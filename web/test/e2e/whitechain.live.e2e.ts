/**
 * Lifeline on the real Whitechain Sepolia, through the running app. Spends test USDT and WBT.
 *
 *   npm run e2e:whitechain
 *
 * An agent with no WBT and no USDT buys on credit, a customer pays it, it repays with a
 * signature, and it then pays for itself. Prints the explorer links the bounty asks for.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { attachSession } from "../../src/lib/session";
import { ensureHumanProfileOnChain } from "../../src/lib/facilityContract";
import { WC_EXPLORER, WC_USDT, whitechainSepolia, wcRpcUrl } from "../../src/lib/whitechain/config";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const HUMAN = "0x" + crypto.randomBytes(32).toString("hex");
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail !== "" ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
const link = (tx?: string) => (tx ? `${WC_EXPLORER}/tx/${tx}` : "(none)");

async function main() {
  await ensureHumanProfileOnChain(HUMAN);
  const cookie = `lifeline_session=${attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value}`;
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${APP}${route}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({} as any)) };
  };
  const c = createPublicClient({ chain: whitechainSepolia, transport: http(wcRpcUrl()) });
  const usdt = async (a: string) =>
    Number(formatUnits(await c.readContract({ address: WC_USDT, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a as `0x${string}`] }), 6));

  const before = (await call("GET", "/api/whitechain?view=merchant")).body;
  check("the app is set up on Whitechain", before.configured === true, before.facility);
  console.log(`        relayer holds ${before.relayer?.wbt} WBT`);

  const agent = (await call("POST", "/api/agent/provision", { rail: "arc", label: "whitechain-live", capUsd: 2 })).body.agent?.address as string;
  check("an agent exists", !!agent, agent);
  check("it holds no WBT", (await c.getBalance({ address: agent as `0x${string}` })) === 0n);
  const me = (await call("GET", "/api/whitechain")).body;
  const url = (id: string) => me.catalogue.find((i: any) => i.id === id).url;
  const merchant = me.catalogue && before.relayer?.merchants?.[0];
  const merchantBefore = merchant ? await usdt(merchant) : 0;

  console.log("\nbuying on credit, holding nothing");
  const credit = (await call("POST", "/api/whitechain", { action: "buy", agentAddress: agent, url: url("report") })).body;
  check("the seller delivered, on credit", credit.success === true && credit.fundingSource === "LIFELINE_CREDIT", credit.error ?? `owes $${credit.owedUsd}`);
  console.log(`        payment  ${link(credit.paymentTx)}`);
  console.log(`        drawdown ${link(credit.drawTx)}`);
  if (merchant) check("the merchant really received USDT", Math.abs((await usdt(merchant)) - merchantBefore - 0.2) < 0.000001, `$${merchantBefore} -> $${await usdt(merchant)}`);

  console.log("\nearning, then repaying with a signature");
  const earned = (await call("POST", "/api/whitechain", { action: "earn", agentAddress: agent })).body;
  check("a customer pays the agent $0.50", earned.success === true, link(earned.txHash));
  const repaid = (await call("POST", "/api/whitechain", { action: "repay", agentAddress: agent })).body;
  check("it repays", repaid.success === true && repaid.owedUsd === 0, repaid.error ?? `repaid $${repaid.repaidUsd}`);
  console.log(`        payment  ${link(repaid.paymentTx)}`);
  console.log(`        recorded ${link(repaid.recordTx)}`);

  console.log("\npaying for itself");
  const own = (await call("POST", "/api/whitechain", { action: "buy", agentAddress: agent, url: url("signal") })).body;
  check("paid by the agent", own.success === true && own.fundingSource === "AGENT_USDT", own.error ?? link(own.paymentTx));
  check("it still holds no WBT", (await c.getBalance({ address: agent as `0x${string}` })) === 0n);

  const after = (await call("GET", "/api/whitechain?view=merchant")).body;
  console.log(`        relayer spent ${after.relayer?.gasTodayWbt} WBT today, ${after.relayer?.settledToday} settlements`);
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
