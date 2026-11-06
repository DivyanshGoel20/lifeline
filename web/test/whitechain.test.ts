process.env.LIFELINE_SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
const MERCHANT = "0x00000000000000000000000000000000000000d7";
const FACILITY = "0x00000000000000000000000000000000000000f1";
process.env.WHITECHAIN_MERCHANTS = MERCHANT;
process.env.WHITECHAIN_MERCHANT_ADDRESS = MERCHANT;
process.env.WHITECHAIN_FACILITY_ADDRESS = FACILITY;
process.env.WHITECHAIN_OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useSandbox } from "./sandbox";
import { WC_NETWORK, WC_USDT } from "../src/lib/whitechain/config";
import { relayerUsage, settlePayment, useFacilitatorChain, verifyPayment } from "../src/lib/whitechain/facilitator";
import { buyOnWhitechain, repayOnWhitechain, signAuthorization, useWcCreditChain, wcDebts, wcLine } from "../src/lib/whitechain/credit";
import { merchantReceipts, requireUsdtPayment, requirementsFor } from "../src/lib/whitechain/seller";

const dir = useSandbox();
const KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(KEY).address;
const req = (usd = 0.01, to = MERCHANT) => ({
  scheme: "exact",
  network: WC_NETWORK,
  maxAmountRequired: String(Math.round(usd * 1e6)),
  asset: WC_USDT,
  payTo: to,
});

let balance: bigint, used: boolean, blocked: boolean, wbt: number, submitted: number, simulateFails: boolean;
beforeEach(() => {
  for (const f of fs.readdirSync(path.join(dir, "data"))) fs.rmSync(path.join(dir, "data", f), { force: true });
  balance = 10_000_000n;
  used = false;
  blocked = false;
  wbt = 1;
  submitted = 0;
  simulateFails = false;
  useFacilitatorChain({
    balanceOf: async () => balance,
    authorizationUsed: async () => used,
    isBlocked: async () => blocked,
    relayerWbt: async () => wbt,
    simulate: async () => {
      if (simulateFails) throw new Error("token refused");
    },
    submit: async () => (submitted++, { txHash: "0xsettled", gasWei: 21000n }),
  });
});

const signed = (value = 10_000n, to = MERCHANT, now = Date.now()) => signAuthorization(KEY, to, value, now);

test("a valid authorisation passes and the relayer settles it", async () => {
  const p = await signed();
  assert.deepEqual(await verifyPayment(p, req()), { isValid: true, payer: PAYER });
  const out = await settlePayment(p, req());
  assert.equal(out.success, true);
  assert.equal(out.transaction, "0xsettled");
  assert.equal(relayerUsage().total, 1);
});

const refused = async (p: any, r: any, reason: string) => {
  const out = await settlePayment(p, r);
  assert.equal(out.success, false);
  assert.equal(out.errorReason, reason);
  assert.equal(submitted, 0, "no gas was spent");
};

test("a forged signature costs the relayer nothing", async () => {
  const p = await signed();
  p.payload.authorization.from = privateKeyToAccount(generatePrivateKey()).address;
  await refused(p, req(), "invalid_signature");
});

test("changing the amount after signing breaks the signature", async () => {
  const p = await signed();
  p.payload.authorization.value = "20000";
  await refused(p, req(), "invalid_signature");
});

test("an unregistered merchant gets no free gas", async () => {
  const stranger = "0x00000000000000000000000000000000000000e9";
  await refused(await signed(10_000n, stranger), req(0.01, stranger), "merchant_not_registered");
});

test("paying someone else than the seller asked is refused", async () => {
  await refused(await signed(10_000n, FACILITY), req(), "wrong_recipient");
});

test("too little for the price is refused", async () => {
  await refused(await signed(1_000n), req(), "insufficient_amount");
});

test("dust cannot be used to burn gas", async () => {
  await refused(await signed(100n), req(0.0001), "below_minimum");
});

test("a payment over the maximum is refused", async () => {
  await refused(await signed(6_000_000n), req(6), "above_maximum");
});

test("another token is refused", async () => {
  await refused(await signed(), { ...req(), asset: "0x00000000000000000000000000000000000000aa" }, "unsupported_asset");
});

test("another network is refused", async () => {
  const p = await signed();
  await refused({ ...p, network: "eip155:1" }, req(), "unsupported_network");
});

test("an expired authorisation is refused", async () => {
  await refused(await signed(10_000n, MERCHANT, Date.now() - 3_600_000), req(), "expired");
});

test("a payer without the funds costs nothing", async () => {
  balance = 5n;
  await refused(await signed(), req(), "insufficient_funds");
});

test("a used authorisation is refused", async () => {
  used = true;
  await refused(await signed(), req(), "authorization_already_used");
});

test("a blocked payer is refused", async () => {
  blocked = true;
  await refused(await signed(), req(), "payer_blocked");
});

test("a relayer low on gas stops", async () => {
  wbt = 0;
  await refused(await signed(), req(), "relayer_out_of_gas");
});

test("a transfer the token would refuse never reaches the chain", async () => {
  simulateFails = true;
  const out = await settlePayment(await signed(), req());
  assert.match(out.errorReason!, /settlement_failed/);
  assert.equal(submitted, 0);
});

test("one payer cannot use up the relayer", async () => {
  process.env.WHITECHAIN_PAYER_DAILY_TXS = "2";
  for (let i = 0; i < 2; i++) assert.equal((await settlePayment(await signed(), req())).success, true);
  assert.equal((await settlePayment(await signed(), req())).errorReason, "payer_daily_limit");
  assert.equal(submitted, 2);
  delete process.env.WHITECHAIN_PAYER_DAILY_TXS;
});

test("the whole relayer has a daily limit", async () => {
  process.env.WHITECHAIN_RELAYER_DAILY_TXS = "1";
  await settlePayment(await signed(), req());
  const other = await signAuthorization(generatePrivateKey(), MERCHANT, 10_000n);
  assert.equal((await settlePayment(other, req())).errorReason, "relayer_daily_limit");
  delete process.env.WHITECHAIN_RELAYER_DAILY_TXS;
});

/* ---------------------------------------------------------------- the seller */

const encoded = (p: any) => Buffer.from(JSON.stringify(p)).toString("base64");

test("no payment gets a quote for USDT on Whitechain", async () => {
  const out: any = await requireUsdtPayment(null, 0.01, "/x", "X");
  assert.equal(out.status, 402);
  assert.equal(out.body.accepts[0].asset, WC_USDT);
  assert.equal(out.body.accepts[0].network, WC_NETWORK);
  assert.equal(out.body.accepts[0].extra.name, "Tether USD");
});

test("goods follow settlement, and the merchant gets a receipt", async () => {
  const out: any = await requireUsdtPayment(encoded(await signed()), 0.01, "/x", "X");
  assert.equal(out.paid, true);
  assert.equal(merchantReceipts()[0].txHash, "0xsettled");
  assert.equal(merchantReceipts()[0].payer, PAYER);
});

test("a bad payment gets a 402 with the reason, and no goods", async () => {
  const out: any = await requireUsdtPayment(encoded(await signed(1n)), 0.01, "/x", "X");
  assert.equal(out.paid, false);
  assert.equal(out.body.error, "insufficient_amount");
  assert.equal(merchantReceipts().length, 0);
  assert.equal(requirementsFor(0.01, "/x", "X").payTo, MERCHANT);
});

/* ---------------------------------------------------------------- credit */

const HUMAN = "0xhuman";
const AGENT_KEY = generatePrivateKey();
const AGENT = privateKeyToAccount(AGENT_KEY).address;
const SELLER = "https://seller.test/report";
let agentHolds: number, draws: number[], repays: number[], profiles: number;

function setCredit() {
  agentHolds = 0;
  draws = [];
  repays = [];
  profiles = 0;
  useWcCreditChain({
    usdtBalance: async () => agentHolds,
    ensureProfile: async () => void profiles++,
    recordDraw: async (_h, _a, usd) => (draws.push(usd), "0xdraw"),
    recordRepay: async (_h, _a, usd) => (repays.push(usd), "0xrepay"),
  });
}

/** A real seller: the gate above, behind the fetch the agent uses. */
const fetcher = (priceUsd: number) => async (_url: string, init?: RequestInit) => {
  const header = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"] ?? null;
  const gate = await requireUsdtPayment(header, priceUsd, "/report", "Report");
  if (!gate.paid) return new Response(JSON.stringify(gate.body), { status: 402 });
  return new Response(JSON.stringify({ report: "the goods" }), { status: 200, headers: { "x-payment-response": gate.responseHeader } });
};
const deps = (price: number, over = {}) => ({ fetcher: fetcher(price) as any, key: () => AGENT_KEY, allow: () => ({ ok: true }), ...over });
const buy = (price = 0.2, over = {}) => buyOnWhitechain({ human: HUMAN, agent: AGENT, url: SELLER }, deps(price, over));

test("an agent with USDT pays for itself and owes nothing", async () => {
  setCredit();
  agentHolds = 1;
  const out = await buy();
  assert.equal(out.fundingSource, "AGENT_USDT");
  assert.equal(out.owedUsd, 0);
  assert.deepEqual(out.data, { report: "the goods" });
  assert.equal(merchantReceipts()[0].payer, AGENT);
  assert.equal(wcLine(HUMAN).owedUsd, 0);
  assert.deepEqual(draws, []);
});

test("an agent with nothing buys on credit: the treasury pays and the human owes", async () => {
  setCredit();
  const out = await buy();
  assert.equal(out.fundingSource, "LIFELINE_CREDIT");
  assert.equal(out.owedUsd, 0.202);
  assert.equal(out.paymentTx, "0xsettled");
  assert.equal(out.drawTx, "0xdraw");
  assert.equal(merchantReceipts()[0].payer, privateKeyToAccount(process.env.WHITECHAIN_OPERATOR_KEY as `0x${string}`).address);
  assert.equal(wcLine(HUMAN).owedUsd, 0.202);
  assert.equal(wcLine(HUMAN).headroomUsd, 0.298);
  assert.deepEqual(draws, [0.202]);
  assert.equal(profiles, 1);
});

test("credit past the line is refused and nothing is signed", async () => {
  setCredit();
  await assert.rejects(buy(0.5), /left on the Whitechain line/);
  assert.equal(submitted, 0);
  assert.equal(wcLine(HUMAN).owedUsd, 0);
});

test("a chain write that fails does not lose the debt", async () => {
  setCredit();
  useWcCreditChain({
    usdtBalance: async () => 0,
    ensureProfile: async () => undefined,
    recordDraw: async () => {
      throw new Error("rpc down");
    },
    recordRepay: async () => "0x",
  });
  const out = await buy();
  assert.equal(out.drawTx, undefined);
  assert.equal(wcLine(HUMAN).owedUsd, 0.202);
});

test("the agent's ceiling applies", async () => {
  setCredit();
  await assert.rejects(buy(0.2, { allow: () => ({ ok: false, reason: "over its ceiling" }) }), /over its ceiling/);
});

test("a seller that takes something else is refused", async () => {
  setCredit();
  const other = async () => new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:1", asset: WC_USDT }] }), { status: 402 });
  await assert.rejects(buyOnWhitechain({ human: HUMAN, agent: AGENT, url: SELLER }, { fetcher: other as any, key: () => AGENT_KEY }), /does not take USDT/);
});

test("repaying is a signature, clears the debt and counts on the record", async () => {
  setCredit();
  await buy();
  agentHolds = 1;
  const out = await repayOnWhitechain({ human: HUMAN, agent: AGENT }, { key: () => AGENT_KEY });
  assert.equal(out.repaidUsd, 0.202);
  assert.equal(out.owedUsd, 0);
  assert.equal(out.paymentTx, "0xsettled");
  assert.deepEqual(repays, [0.202]);
  assert.equal(wcLine(HUMAN).repayments, 1);
  assert.equal(wcDebts(HUMAN)[0].status, "settled");
});

test("a partial repayment leaves the rest owed, oldest first", async () => {
  setCredit();
  await buy();
  await buy(0.1);
  agentHolds = 1;
  await repayOnWhitechain({ human: HUMAN, agent: AGENT, amountUsd: 0.25 }, { key: () => AGENT_KEY });
  assert.equal(wcLine(HUMAN).owedUsd, 0.053);
  assert.equal(wcDebts(HUMAN)[0].status, "settled");
  assert.equal(wcDebts(HUMAN)[1].status, "open");
});

test("an agent that cannot pay is told, and nothing moves", async () => {
  setCredit();
  await buy();
  const before = submitted;
  await assert.rejects(repayOnWhitechain({ human: HUMAN, agent: AGENT }, { key: () => AGENT_KEY }), /holds \$0\.00/);
  assert.equal(submitted, before);
  assert.equal(wcLine(HUMAN).owedUsd, 0.202);
});

test("nothing owed is said plainly", async () => {
  setCredit();
  await assert.rejects(repayOnWhitechain({ human: HUMAN, agent: AGENT }, { key: () => AGENT_KEY }), /Nothing is owed/);
});
