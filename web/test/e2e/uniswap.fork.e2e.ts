/**
 * The Uniswap API against a local copy of Sepolia, using your API key.
 *
 *   npm run e2e:uniswap     # needs anvil and UNISWAP_API_KEY in .env
 *
 * Quotes and swap transactions come from the real API, and are executed on a fork, so
 * no funds are needed. It stops where the bridge starts: a bridge cannot leave a fork.
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { sepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = 8596;
const RPC = `http://127.0.0.1:${PORT}`;
process.env.UNISWAP_RPC_URL = RPC;

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail !== "" ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  if (!process.env.UNISWAP_API_KEY) throw new Error("UNISWAP_API_KEY is not set.");
  const anvil = spawn("anvil", ["--fork-url", "https://ethereum-sepolia-rpc.publicnode.com", "--port", String(PORT), "--silent"], { stdio: "ignore" });
  process.on("exit", () => anvil.kill());
  for (let i = 0; ; i++) {
    try {
      await rpc("eth_chainId", []);
      break;
    } catch {
      if (i > 60) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const { chooseFunding, usdcToBuy } = await import("../../src/lib/swapOrBorrow");
  const { executeSwap, holdingsOf, quoteForUsdc, swapChain, usdcOn } = await import("../../src/lib/uniswapApi");
  const c = swapChain();
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key);
  const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account: agent, chain: sepolia, transport: http(RPC) });

  check("this is a copy of Sepolia, on this machine", (await client.getChainId()) === 11155111, RPC);

  console.log("\nan agent holding nothing");
  const empty = await chooseFunding({ agent: agent.address, amountUsd: 5, headroomUsd: 10 });
  check("borrows, and says why", empty.decision.choice === "borrow", empty.decision.reason);

  console.log("\nan agent holding ETH and WETH");
  await rpc("anvil_setBalance", [agent.address, "0x" + parseEther("2").toString(16)]);
  const WETH = c.tokens.WETH.address;
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: WETH, abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: parseEther("0.5") }),
  });
  const held = await holdingsOf(agent.address);
  check("its holdings are read", held.ETH > 0n && held.WETH === parseEther("0.5"), `${held.ETH} ETH wei, ${held.WETH} WETH wei`);

  const need = usdcToBuy(0.2);
  const weth = await quoteForUsdc("WETH", need, agent.address);
  check("Uniswap quotes WETH for exact USDC", weth.amountIn > 0n, `${weth.amountIn} wei, impact ${weth.impactPct}%, gas $${weth.gasUsd.toFixed(4)}, pool fee ${(weth.poolFee * 100).toFixed(3)}%`);

  console.log("\nthe decision");
  const small = await chooseFunding({ agent: agent.address, amountUsd: 0.2, headroomUsd: 0.5 });
  check("it reaches a decision with real numbers", !!small.decision.swap, small.decision.reason);
  console.log(`        borrowing $${small.decision.borrow.totalUsd.toFixed(4)}, swapping $${small.decision.swap?.totalUsd.toFixed(4)}`);
  const forced = await chooseFunding({ agent: agent.address, amountUsd: 0.2, headroomUsd: 0.01 });
  check("with no room on the line, it swaps", forced.decision.choice === "swap" && !!forced.quote, forced.decision.reason);

  console.log("\nswapping, with the API's real transaction");
  const before = await usdcOn(agent.address);
  const swapped = await executeSwap(key, weth);
  const after = await usdcOn(agent.address);
  check("the swap settles: approval, Permit2 signature, swap", !!swapped.txHash, swapped.txHash);
  check("exactly the USDC asked for arrives", after - before === need, `${after - before} units`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
