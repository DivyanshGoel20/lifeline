/**
 * The Arc rail's edge cases, on Arc testnet, through the app.
 *
 *   npm run dev && npm run premium
 *   npm run e2e:arc-edges
 *
 * Where e2e:arc walks the happy path, this goes looking for the places money
 * can go wrong: an agent with no balance, some balance, and enough; caps at
 * every level (agent, mandate, facility); repaying with nothing, too little,
 * too much, and with a browser receipt that is real, reused, misdirected or
 * made up. After every movement the app's ledger is checked against the
 * contract.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createWalletClient, parseUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { attachSession } from "../../src/lib/session";
import { getAgentPrivateKey } from "../../src/lib/agentKeys";
import {
  arcTestnetChain,
  ensureHumanProfileOnChain,
  getArcTransport,
  getOnChainProfile,
  getPublicClient,
} from "../../src/lib/facilityContract";
import { ARC_TREASURY } from "../../src/lib/browserChain";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const PREMIUM = process.env.NEXT_PUBLIC_X402_RESOURCE_BASE || "http://localhost:4402";
const CENT = `${PREMIUM}/premium-data`; // $0.01
const DOLLAR = `${PREMIUM}/risk-curve`; // $0.20
const HUMAN = "0x" + crypto.randomBytes(32).toString("hex");
const STRANGER = "0x" + crypto.randomBytes(32).toString("hex");

let failures = 0;
let section = "";
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
const heading = (s: string) => console.log(`\n${(section = s)}`);
const near = (a: number, b: number, eps = 0.0002) => Math.abs(a - b) <= eps;

const cookieFor = (h: string) => `lifeline_session=${attachSession(NextResponse.json({}), h).cookies.get("lifeline_session")!.value}`;
const client = (headers: Record<string, string>) => async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const operator = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const wallet = (pk: `0x${string}`) =>
  createWalletClient({ account: privateKeyToAccount(pk), chain: arcTestnetChain, transport: getArcTransport() });

async function sendUsdc(from: `0x${string}`, to: string, usdc: number) {
  const hash = await wallet(from).sendTransaction({ to: to as `0x${string}`, value: parseUnits(usdc.toFixed(6), 18) });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: process.env.PRIVATE_KEY as `0x${string}` });
const gatewayOf = async (addr: string) => Number((await (gateway as any).getGatewayBalance(addr)).formattedAvailable);

/** Circle credits a deposit a beat after the transaction lands. */
async function waitForGateway(addr: string, test: (n: number) => boolean) {
  for (let i = 0; i < 24; i++) {
    const n = await gatewayOf(addr);
    if (test(n)) return n;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return gatewayOf(addr);
}

async function main() {
  console.log(`human ${HUMAN}`);
  await ensureHumanProfileOnChain(HUMAN);
  const call = client({ cookie: cookieFor(HUMAN) });
  const stranger = client({ cookie: cookieFor(STRANGER) });
  const anon = client({});

  const debtOf = async (addr: string) =>
    (await call("GET", "/api/agents")).body.agents.find((a: any) => a.address.toLowerCase() === addr.toLowerCase())
      ?.outstandingDebt as number;
  const onChainDebt = async () => Number((await getOnChainProfile(HUMAN))?.outstandingDebt ?? NaN);

  // ── Who may spend ─────────────────────────────────────────────────────
  heading("who may spend");
  const a = (await call("POST", "/api/agent/provision", { label: "edge-a", capUsd: 5 })).body.agent.address as string;
  const b = (await call("POST", "/api/agent/provision", { label: "edge-b", capUsd: 0.1 })).body.agent.address as string;
  check("two agents provisioned", !!a && !!b, `${a} ${b}`);

  const r401 = await anon("POST", "/api/pay", { url: CENT, agentAddress: a });
  check("no session: refused", r401.status === 401, `status ${r401.status}`);
  const r403 = await stranger("POST", "/api/pay", { url: CENT, agentAddress: a });
  check("someone else's agent: refused", r403.status === 403, `status ${r403.status}`);
  const r404 = await call("POST", "/api/pay", { url: CENT, agentAddress: "0x" + "9".repeat(40) });
  check("an agent nobody registered: refused", r404.status === 404, `status ${r404.status}`);

  // ── No balance ────────────────────────────────────────────────────────
  heading("an agent with no balance");
  check("agent A starts with nothing in Gateway", (await gatewayOf(a)) === 0);
  const broke = await call("POST", "/api/pay", { url: CENT, agentAddress: a });
  check(
    "a cent purchase is covered on credit",
    broke.body.success && broke.body.fundingSource === "LIFELINE_FACILITY" && Number(broke.body.borrowed) === 0.01,
    broke.body.error ?? `borrowed ${broke.body.borrowed}`
  );
  check("A owes the price plus the 1% fee", near(await debtOf(a), 0.0101), `owes ${await debtOf(a)}`);

  const rm = await call("DELETE", `/api/agents?address=${a}`);
  check("an agent that owes cannot be revoked", rm.status === 403, rm.body.error);

  // ── Caps ──────────────────────────────────────────────────────────────
  heading("caps");
  const overAgent = await call("POST", "/api/pay", { url: DOLLAR, agentAddress: b });
  // Past the agent's cap but within the line: held for the human, not refused.
  check(
    "B's $0.10 agent cap holds a $0.20 purchase for the human",
    overAgent.status === 202 && !overAgent.body.success && !!overAgent.body.hold?.holdId && /spending cap/i.test(overAgent.body.screening?.reasons?.[0] ?? ""),
    overAgent.body.screening?.reasons?.[0] ?? overAgent.body.error
  );
  check("and B owes nothing for the attempt", near(await debtOf(b), 0));

  const overAgentDraw = await call("POST", "/api/borrow", { agentAddress: b, amount: 0.15 });
  check("B's agent cap also binds a direct draw", overAgentDraw.status >= 400, overAgentDraw.body.error ?? `status ${overAgentDraw.status}`);

  const tiny = (await call("POST", "/api/agent-token", { capUsd: 0.005, days: 1, label: "tiny" })).body.token;
  const mandate = client({ authorization: `Bearer ${tiny}` });
  const overMandate = await mandate("POST", "/api/pay", { url: CENT, agentAddress: b });
  check("a $0.005 mandate refuses a $0.01 draw", !overMandate.body.success, overMandate.body.error);
  const mandateAdmin = await mandate("POST", "/api/agents", { name: "sneaky", walletAddress: "0x" + "1".repeat(40) });
  check("a mandate cannot register agents", mandateAdmin.status === 401, `status ${mandateAdmin.status}`);
  const mandateMint = await mandate("POST", "/api/agent-token", { capUsd: 100 });
  check("a mandate cannot mint itself a bigger one", mandateMint.status === 401, `status ${mandateMint.status}`);

  const roomy = (await call("POST", "/api/agent-token", { capUsd: 1, days: 1, label: "roomy" })).body.token;
  const withRoomy = await client({ authorization: `Bearer ${roomy}` })("POST", "/api/pay", { url: CENT, agentAddress: b });
  check("a $1 mandate spends on credit", withRoomy.body.success && withRoomy.body.fundingSource === "LIFELINE_FACILITY", withRoomy.body.error ?? "");

  const overLine = await call("POST", "/api/borrow", { agentAddress: a, amount: 50 });
  check("a draw beyond the whole line is refused", overLine.status === 403, overLine.body.error);

  // ── Own balance ───────────────────────────────────────────────────────
  heading("an agent with its own balance");
  const aKey = getAgentPrivateKey(a)!;
  await sendUsdc(process.env.PRIVATE_KEY as `0x${string}`, a, 0.12);
  const aGateway = new GatewayClient({ chain: "arcTestnet", privateKey: aKey });
  await aGateway.deposit("0.1");
  const funded = await waitForGateway(a, (n) => n >= 0.1);
  check("A deposits $0.10 of its own into Gateway", funded >= 0.1, `gateway ${funded}`);

  const debtBefore = await debtOf(a);
  const own = await call("POST", "/api/pay", { url: CENT, agentAddress: a });
  check("with enough, A pays for itself", own.body.success && own.body.fundingSource === "AGENT_GATEWAY", own.body.error ?? own.body.fundingSource);
  check("and borrows nothing", near(await debtOf(a), debtBefore), `owes ${await debtOf(a)}`);
  const afterOwn = await waitForGateway(a, (n) => n < funded);
  check("its own Gateway balance paid", near(afterOwn, funded - 0.01, 0.0011), `gateway ${funded} -> ${afterOwn}`);

  // ── Some balance, not enough ──────────────────────────────────────────
  heading("an agent with some balance, but not enough");
  const partialBefore = await debtOf(a);
  const partial = await call("POST", "/api/pay", { url: DOLLAR, agentAddress: a });
  check("a $0.20 purchase with $0.09 held goes to credit", partial.body.success && partial.body.fundingSource === "LIFELINE_FACILITY", partial.body.error ?? "");
  // Lifeline's Gateway pays the seller the whole price - one x402 payment
  // has one payer - so the whole price is what the human owes.
  check("the whole price is lent, not only the shortfall", near(Number(partial.body.borrowed), 0.2), `borrowed ${partial.body.borrowed}`);
  check("A's debt rose by the whole price plus its fee", near((await debtOf(a)) - partialBefore, 0.202), `+${((await debtOf(a)) - partialBefore).toFixed(4)}`);
  check("A's own balance was left alone", near(await gatewayOf(a), afterOwn, 0.0011), `gateway ${await gatewayOf(a)}`);

  // ── Direct draw ───────────────────────────────────────────────────────
  heading("a direct draw");
  const gBefore = await gatewayOf(a);
  const dBefore = await debtOf(a);
  const draw = await call("POST", "/api/borrow", { agentAddress: a, amount: 0.2 });
  check("A draws $0.20", draw.body.success, draw.body.txHash ?? draw.body.error);
  const gAfter = await waitForGateway(a, (n) => n >= gBefore + 0.19);
  check("the $0.20 lands in A's Gateway", near(gAfter - gBefore, 0.2, 0.011), `gateway +${(gAfter - gBefore).toFixed(4)}`);
  check("A owes the draw plus the 1% fee", near((await debtOf(a)) - dBefore, 0.202), `+${((await debtOf(a)) - dBefore).toFixed(4)}`);

  // ── Repaying ──────────────────────────────────────────────────────────
  heading("repaying");
  const owed = await debtOf(a);
  const broke2 = await call("POST", "/api/repay", { agentAddress: a, amount: owed });
  check("repaying more than the wallet holds fails cleanly", !broke2.body.success, (broke2.body.error ?? "").slice(0, 90));
  check("and the debt is untouched", near(await debtOf(a), owed), `owes ${await debtOf(a)}`);

  await sendUsdc(process.env.PRIVATE_KEY as `0x${string}`, a, owed + 0.3);
  const part = await call("POST", "/api/repay", { agentAddress: a, amount: 0.3 });
  check("a partial repayment settles on Arc", part.body.success, part.body.txHash ?? part.body.error);
  check("the debt drops by it", near(await debtOf(a), owed - 0.3, 0.001), `owes ${await debtOf(a)}`);

  const over = await call("POST", "/api/repay", { agentAddress: a, amount: 100 });
  check("an overpayment is clamped to what is owed", over.body.success && over.body.amount < 100, over.body.error ?? `applied ${over.body.amount}`);
  check("A owes nothing", near(await debtOf(a), 0), `owes ${await debtOf(a)}`);

  // ── Receipts from a browser wallet ────────────────────────────────────
  // A's overpayment also cleared B's cent: the human is the borrower, and a
  // repayment clears their oldest loans first, whichever agent drew them.
  check("A's overpayment cleared its sibling B too", near(await debtOf(b), 0), `B owes ${await debtOf(b)}`);
  check("and the contract agrees nothing is owed", near(await onChainDebt(), 0, 0.0001), `on chain ${await onChainDebt()}`);

  heading("repaying from a browser wallet");
  await call("POST", "/api/pay", { url: CENT, agentAddress: b });
  const bOwes = await debtOf(b);
  check("B owes for a new purchase", near(bOwes, 0.0101), `owes ${bOwes}`);
  const payer = generatePrivateKey();
  await sendUsdc(process.env.PRIVATE_KEY as `0x${string}`, privateKeyToAccount(payer).address, 0.2);
  const good = await sendUsdc(payer, ARC_TREASURY, bOwes);
  const receipt = await call("POST", "/api/repay", { agentAddress: b, amount: bOwes, txHash: good });
  check("a real transfer to the treasury is booked", receipt.body.success, receipt.body.error ?? receipt.body.txHash);

  // Each bad receipt is presented while B owes something, so it is refused
  // for what it is - not because there was nothing left to repay.
  await call("POST", "/api/pay", { url: CENT, agentAddress: b });
  check("B owes again", near(await debtOf(b), 0.0101), `owes ${await debtOf(b)}`);

  const replay = await call("POST", "/api/repay", { agentAddress: b, amount: 0.0101, txHash: good });
  check("the same transfer cannot be counted twice", replay.status === 409, replay.body.error);

  const misdirected = await sendUsdc(payer, "0x" + "7".repeat(40), 0.0101);
  const wrong = await call("POST", "/api/repay", { agentAddress: b, amount: 0.0101, txHash: misdirected });
  check("a transfer to somebody else is not a repayment", wrong.status === 400 && /not Lifeline's treasury/.test(wrong.body.error ?? ""), wrong.body.error);

  const short = await sendUsdc(payer, ARC_TREASURY, 0.001);
  const tooSmall = await call("POST", "/api/repay", { agentAddress: b, amount: 0.0101, txHash: short });
  check("a transfer smaller than the claim is not a repayment", tooSmall.status === 400 && /less than/.test(tooSmall.body.error ?? ""), tooSmall.body.error);

  const made = await call("POST", "/api/repay", { agentAddress: b, amount: 0.0101, txHash: "0x" + "ab".repeat(32) });
  check("a made-up hash is not a repayment", made.status === 400 && /not on Arc/.test(made.body.error ?? ""), made.body.error);

  check("none of them moved the debt", near(await debtOf(b), 0.0101), `owes ${await debtOf(b)}`);

  const honest = await sendUsdc(payer, ARC_TREASURY, 0.0101);
  const cleared = await call("POST", "/api/repay", { agentAddress: b, amount: 0.0101, txHash: honest });
  check("an honest receipt clears it", cleared.body.success, cleared.body.error ?? "");

  // ── Books agree ───────────────────────────────────────────────────────
  heading("the books");
  check("the app says nothing is owed", near(await debtOf(a), 0) && near(await debtOf(b), 0));
  check("the contract agrees", near(await onChainDebt(), 0, 0.0001), `on chain ${await onChainDebt()}`);

  const noDebt = await call("POST", "/api/repay", { agentAddress: a, amount: 1 });
  check("repaying with nothing owed is refused", noDebt.status === 400, noDebt.body.error);

  // ── Leaving ───────────────────────────────────────────────────────────
  heading("revoking");
  const gone = await call("DELETE", `/api/agents?address=${a}`);
  check("a clear agent can be revoked", gone.body.success, gone.body.error ?? "");
  const ghost = await call("POST", "/api/pay", { url: CENT, agentAddress: a });
  check("a revoked agent cannot spend", ghost.status === 404, `status ${ghost.status}`);

  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`e2e failed during "${section}":`, err);
  process.exit(1);
});
