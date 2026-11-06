/**
 * Lifeline on Whitechain, against a local copy of Whitechain Sepolia. No funds needed.
 *
 *   npm run e2e:whitechain-fork     # needs anvil and forge (Foundry)
 *
 * This runs the real USDT contract: a real EIP-3009 signature, real settlement, a real
 * deployed facility. It funds itself by impersonating a USDT holder on the fork, so it
 * proves the code, and proves nothing on the real chain. `e2e:whitechain` does that.
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseEther, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NextRequest } from "next/server";
import { useSandbox } from "../sandbox";

const PORT = 8598;
const RPC = `http://127.0.0.1:${PORT}`;
const OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // Anvil's public test key
const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as const;
const HOLDER = "0xA1616Fe9624B64eF2Dddc8ccAc735bAA234CEbF7" as const;
const MERCHANT = privateKeyToAccount(generatePrivateKey()).address;
const CONTRACTS = path.resolve(process.cwd(), process.cwd().endsWith("web") ? "../contracts" : "contracts");

process.env.WHITECHAIN_RPC_URL = RPC;
process.env.WHITECHAIN_OPERATOR_KEY = OPERATOR_KEY;
process.env.WHITECHAIN_MERCHANTS = MERCHANT;
process.env.WHITECHAIN_MERCHANT_ADDRESS = MERCHANT;
process.env.LIFELINE_SESSION_SECRET ||= "fork-test-secret-that-is-at-least-32-chars";
process.env.PRIVATE_KEY = "";

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
  const anvil = spawn("anvil", ["--fork-url", "https://rpc.testnet.whitechain.io", "--port", String(PORT), "--silent"], { stdio: "ignore" });
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

  const { whitechainSepolia, WC_FACILITY_ABI } = await import("../../src/lib/whitechain/config");
  const c = createPublicClient({ chain: whitechainSepolia, transport: http(RPC) });
  const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
  const usdt = async (a: `0x${string}`) => Number(formatUnits(await c.readContract({ address: USDT, abi: ERC20, functionName: "balanceOf", args: [a] }), 6));
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey).address;

  check("this is a copy of Whitechain Sepolia, on this machine", (await c.getChainId()) === 1874, RPC);

  console.log("\nsetting up");
  const out = execFileSync(
    "forge",
    ["create", "src/LifelineCreditFacility.sol:LifelineCreditFacility", "--rpc-url", RPC, "--private-key", OPERATOR_KEY, "--broadcast", "--constructor-args", USDT],
    { cwd: CONTRACTS, encoding: "utf8" }
  );
  const facility = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)?.[1] as `0x${string}`;
  check("the facility deploys against the real USDT", !!facility, facility);
  process.env.WHITECHAIN_FACILITY_ADDRESS = facility;

  await rpc("anvil_impersonateAccount", [HOLDER]);
  await rpc("anvil_setBalance", [HOLDER, "0x" + parseEther("1").toString(16)]);
  const holder = createWalletClient({ account: HOLDER, chain: whitechainSepolia, transport: http(RPC) });
  await c.waitForTransactionReceipt({ hash: await holder.writeContract({ address: USDT, abi: ERC20, functionName: "transfer", args: [operator.address, parseUnits("20", 6)] }) });
  check("the treasury has USDT", (await usdt(operator.address)) >= 20, `$${await usdt(operator.address)}`);
  const wbt = await c.getBalance({ address: agent });
  check("the agent holds no WBT at all", wbt === 0n);

  const { buyOnWhitechain, payAgentForWork, repayOnWhitechain, wcLine } = await import("../../src/lib/whitechain/credit");
  const { GET: seller } = await import("../../src/app/api/whitechain/paid/[item]/route");
  const fetcher = async (url: string, init?: RequestInit) => {
    const item = url.split("/").pop()!;
    return seller(new NextRequest(url, { headers: init?.headers as HeadersInit }), { params: { item } });
  };
  const deps = { fetcher: fetcher as any, key: () => agentKey, allow: () => ({ ok: true }) } as any;
  const HUMAN = "0x" + "ab".repeat(32);
  const url = (item: string) => `http://merchant.test/api/whitechain/paid/${item}`;
  const { computeProfileId } = await import("../../src/lib/facilityContract");
  const profile = computeProfileId(HUMAN);
  const debt = () => c.readContract({ address: facility, abi: WC_FACILITY_ABI, functionName: "getOutstandingDebt", args: [profile] });

  console.log("\nan agent with nothing buys on credit");
  const onCredit = await buyOnWhitechain({ human: HUMAN, agent, url: url("report") }, deps);
  check("the seller delivered", (onCredit.data as any)?.title === "Merchant risk report");
  check("on credit", onCredit.fundingSource === "LIFELINE_CREDIT", `owes $${onCredit.owedUsd}`);
  check("the merchant really got USDT", (await usdt(MERCHANT)) === 0.2, `merchant $${await usdt(MERCHANT)}`);
  check("settled on chain", !!onCredit.paymentTx, onCredit.paymentTx);
  check("the facility shows the debt", (await debt()) === parseUnits("0.202", 6), onCredit.drawTx);
  check("the agent still holds no WBT and no USDT", (await c.getBalance({ address: agent })) === 0n && (await usdt(agent)) === 0);

  console.log("\nreplaying a payment");
  const { signAuthorization } = await import("../../src/lib/whitechain/credit");
  const { encodePayment } = await import("../../src/lib/whitechain/seller");
  const reused = await signAuthorization(OPERATOR_KEY, MERCHANT, parseUnits("0.2", 6));
  const once = await fetcher(url("report"), { headers: { "X-PAYMENT": encodePayment(reused) } });
  const twice = await fetcher(url("report"), { headers: { "X-PAYMENT": encodePayment(reused) } });
  check("first use pays", once.status === 200);
  const body: any = await twice.json();
  check("the same signature cannot buy twice", twice.status === 402 && body.error === "authorization_already_used", body.error);

  console.log("\nearning, then repaying with only a signature");
  await payAgentForWork(agent, 1);
  check("the agent was paid in USDT", (await usdt(agent)) === 1);
  const repaid = await repayOnWhitechain({ human: HUMAN, agent }, deps);
  check("the repayment settled", !!repaid.paymentTx, repaid.paymentTx);
  check("the facility shows nothing owed", (await debt()) === 0n, repaid.recordTx);
  check("the ledger agrees", wcLine(HUMAN).owedUsd === 0);
  check("and the record counts it", wcLine(HUMAN).repayments === 1);
  check("the agent paid no gas: its WBT is still zero", (await c.getBalance({ address: agent })) === 0n);

  console.log("\nan agent that earned pays for itself");
  const own = await buyOnWhitechain({ human: HUMAN, agent, url: url("signal") }, deps);
  check("paid by the agent", own.fundingSource === "AGENT_USDT" && own.owedUsd === 0);
  check("still no WBT", (await c.getBalance({ address: agent })) === 0n);

  console.log("\nthe line");
  const broke = privateKeyToAccount(generatePrivateKey()).address;
  const merchantBefore = await usdt(MERCHANT);
  await buyOnWhitechain({ human: HUMAN, agent: broke, url: url("report") }, deps);
  await buyOnWhitechain({ human: HUMAN, agent: broke, url: url("report") }, deps);
  const third = await buyOnWhitechain({ human: HUMAN, agent: broke, url: url("report") }, deps).then(() => "", (e) => e.message);
  check("credit stops at the $0.50 line", /left on the Whitechain line/.test(third), third);
  check("and the third purchase paid the merchant nothing", Math.abs((await usdt(MERCHANT)) - merchantBefore - 0.4) < 0.000001);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
