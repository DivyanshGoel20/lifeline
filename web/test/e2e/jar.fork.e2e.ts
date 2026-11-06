/**
 * The Token Jar, against a local copy of Base mainnet. No real money moves.
 *
 *   npm run e2e:jar        # needs anvil (Foundry)
 *
 * Anvil forks Base, so this runs Uniswap's real TJAR Factory, real pools and real
 * prices, with throwaway accounts on a chain only this machine can see. It never reads
 * this project's keys. Everything except the last step of sending USDC to Arc runs here:
 * a bridge cannot cross out of a fork.
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseUnits, formatUnits, decodeEventLog, encodePacked } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useSandbox } from "../sandbox";

const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's first public test account. Not a secret, and it means nothing off this fork.
const KEEPER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

process.env.PRIVATE_KEY = "";
process.env.BASE_RPC_URL = RPC;
process.env.LIFELINE_JAR_KEEPER_KEY = KEEPER_KEY;
process.env.LIFELINE_SESSION_SECRET ||= "fork-test-secret-that-is-at-least-32-chars";

const FACTORY = "0xfAc70EEEE259F2140CBbB8e3157b75A52ce39fee" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const UNI = "0xc3De830EA07524a0761646a6a4e4be0e114a3C83" as const;
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
const THRESHOLD_USD = 5;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit() payable",
]);
const FACTORY_ABI = parseAbi([
  "function deploy(address revenueToken, address revenueRecipient, uint256 threshold, address owner, address configSetter, bytes32 salt) returns (address jar, address releaser)",
  "event JarDeployed(address indexed jar, address indexed releaser, address indexed owner, address configSetter, address deployer, bytes32 salt)",
]);
const ROUTER_ABI = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
]);

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
  useSandbox();
  const anvil = spawn("anvil", ["--fork-url", process.env.FORK_URL || "https://mainnet.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });
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

  const c = createPublicClient({ chain: base, transport: http(RPC) });
  check("this is a fork of Base, on this machine", (await c.getChainId()) === 8453, RPC);
  const keeper = createWalletClient({ account: privateKeyToAccount(KEEPER_KEY), chain: base, transport: http(RPC) });
  const agentKey = generatePrivateKey();
  const agentAcct = privateKeyToAccount(agentKey);
  const agentWallet = createWalletClient({ account: agentAcct, chain: base, transport: http(RPC) });
  const wait = (hash: `0x${string}`) => c.waitForTransactionReceipt({ hash });
  await rpc("anvil_setBalance", [agentAcct.address, "0x" + parseEther("1").toString(16)]);
  // The keeper's working capital, bought on the fork: Anvil gives its test accounts ETH.
  await wait(await keeper.writeContract({ address: WETH, abi: ERC20, functionName: "deposit", value: parseEther("0.1") }));
  await wait(await keeper.writeContract({ address: WETH, abi: ERC20, functionName: "approve", args: [ROUTER, parseEther("0.1")] }));
  await wait(
    await keeper.writeContract({
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: "exactInput",
      args: [{ path: encodePacked(["address", "uint24", "address"], [WETH, 500, USDC]), recipient: keeper.account.address, amountIn: parseEther("0.1"), amountOutMinimum: 0n }],
    })
  );

  console.log("\ndeploying through Uniswap's real factory");
  const receipt = await wait(
    await keeper.writeContract({
      address: FACTORY,
      abi: FACTORY_ABI,
      functionName: "deploy",
      args: [USDC, keeper.account.address, parseUnits(String(THRESHOLD_USD), 6), keeper.account.address, keeper.account.address, `0x${"11".repeat(32)}`],
    })
  );
  let jar: `0x${string}` | undefined;
  let releaser: `0x${string}` | undefined;
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({ abi: FACTORY_ABI, ...log });
      if (e.eventName === "JarDeployed") {
        jar = e.args.jar;
        releaser = e.args.releaser;
      }
    } catch {
      /* another contract's event */
    }
  }
  check("the jar and releaser exist", !!jar && !!releaser, `${jar} ${releaser}`);
  process.env.LIFELINE_JAR_ADDRESS = jar;
  process.env.LIFELINE_JAR_RELEASER_ADDRESS = releaser;

  // Imported late: the module's clients read the environment set above.
  const { clearJar, jarSummary, quoteCredit, repayWithToken } = await import("../../src/lib/lifelineJar");

  console.log("\nan agent earns tokens");
  await wait(await agentWallet.writeContract({ address: WETH, abi: ERC20, functionName: "deposit", value: parseEther("0.01") }));
  await wait(await agentWallet.writeContract({ address: WETH, abi: ERC20, functionName: "approve", args: [ROUTER, parseEther("0.004")] }));
  const path = encodePacked(["address", "uint24", "address"], [WETH, 3000, UNI]);
  await wait(
    await agentWallet.writeContract({
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: "exactInput",
      args: [{ path, recipient: agentAcct.address, amountIn: parseEther("0.004"), amountOutMinimum: 0n }],
    })
  );
  const uniHeld = (await c.readContract({ address: UNI, abi: ERC20, functionName: "balanceOf", args: [agentAcct.address] })) as bigint;
  check("it holds WETH and UNI", uniHeld > 0n, `${formatUnits(uniHeld, 18)} UNI`);

  const quoted = await quoteCredit("WETH", "0.001");
  check("Uniswap prices WETH", quoted.worthUsd > 0, `0.001 WETH = $${quoted.worthUsd}, pays $${quoted.creditUsd}`);
  check("the margin comes off", Math.abs(quoted.creditUsd - quoted.worthUsd * 0.97) < 0.001);

  console.log("\nrepaying in tokens");
  const booked: number[] = [];
  const deps = {
    key: () => agentKey,
    allow: () => ({ ok: true }),
    owed: async () => 50,
    book: async ({ amountUsd }: { amountUsd: number }) => (booked.push(amountUsd), { repaidUsd: amountUsd, txHash: "0xbooked" }),
  } as any;
  const who = { human: "0xhuman", agent: { address: agentAcct.address, humanOwner: "0xhuman" } as any };

  const first = await repayWithToken({ ...who, token: "WETH", amount: "0.0005" }, deps);
  check("WETH reached the jar and the debt fell", first.repaidUsd > 0, `$${first.repaidUsd}, ${first.jarTxHash}`);
  const jarWeth = (await c.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [jar!] })) as bigint;
  check("the jar holds exactly what was sent", jarWeth === parseEther("0.0005"));

  const tooBig = await repayWithToken({ ...who, token: "WETH", amount: "0.1" }, deps).then(() => false, (e) => /limited to|not enough/.test(e.message));
  check("more than one repayment's limit is refused", tooBig);

  console.log("\nclearing");
  const early = await clearJar();
  check("not worth clearing yet, so nothing happens", early.cleared === false, (early as any).reason);

  // Topped up directly to pass the threshold: the limit per repayment is smaller than it.
  await wait(await agentWallet.writeContract({ address: WETH, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [jar!, parseEther("0.005")] }));
  const uniToSend = uniHeld / 4n;
  await repayWithToken({ ...who, token: "UNI", amount: formatUnits(uniToSend, 18) }, deps);
  const status: any = await jarSummary();
  check("the jar holds two tokens, and is worth more than clearing costs", status.worthUsd > status.costToClearUsd, `$${status.worthUsd} against $${status.costToClearUsd}`);

  const before = (await c.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [keeper.account.address] })) as bigint;
  const cleared: any = await clearJar();
  check("the keeper clears it", cleared.cleared === true, cleared.releaseTx ?? cleared.reason);
  check("both tokens were swapped on Uniswap", cleared.swaps?.length === 2, JSON.stringify(cleared.swaps?.map((s: any) => `${s.token} $${s.usdc}`)));
  const after = (await c.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [keeper.account.address] })) as bigint;
  check("Lifeline ends with more USDC", after > before, `+$${formatUnits(after - before, 6)}`);
  const emptied = (await c.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [jar!] })) as bigint;
  check("the jar is empty", emptied === 0n);
  const later: any = await jarSummary();
  check("and the releaser's nonce moved on", later.nonce === "1", later.nonce);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
