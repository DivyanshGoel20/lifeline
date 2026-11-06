process.env.LIFELINE_SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.LIFELINE_POOL_CAP_USD = "20";
process.env.LIFELINE_DAILY_NEW_CREDIT_USD = "15";
process.env.LIFELINE_SELLER_DAILY_USD = "3";
process.env.LIFELINE_BREAKER_DEFAULT_RATE = "0.2";
process.env.LIFELINE_BREAKER_MIN_LOANS = "5";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useSandbox } from "./sandbox";
import { addAgentToStore } from "../src/lib/agentStore";
import { createLoan, getAllLoans, saveAllLoans } from "../src/lib/loanStore";
import { recordPayment } from "../src/lib/paymentStore";
import { recordSellerOutcome } from "../src/lib/sellerQuality";
import { creditRefusal, isSelfDealing, lentToSellerToday, riskStatus } from "../src/lib/riskControls";

/** The limits that decide the most Lifeline can lose when borrowers do not repay. */

const dir = useSandbox();
const DAY = 24 * 60 * 60 * 1000;
const HUMAN = "human-a";
const AGENT = "0x00000000000000000000000000000000000000a1";
const SELLER = "0x00000000000000000000000000000000000000b2";

const loan = (amount: number, over: Record<string, unknown> = {}) => {
  createLoan({ agentAddress: AGENT, agentName: "a", humanOwner: HUMAN, amount, txHash: "" });
  const all = getAllLoans();
  Object.assign(all[0], over);
  saveAllLoans(all);
};
const paid = (shortfall: string, seller = SELLER, at = Date.now()) =>
  recordPayment({
    paymentId: `p_${Math.random()}`,
    agentAddress: AGENT,
    humanProfileId: HUMAN,
    sellerAddress: seller,
    resourceUrl: "https://x.test",
    requestedAmount: shortfall,
    agentGatewayBalance: "0",
    shortfall,
    fundingSource: "LIFELINE_FACILITY",
    drawdownId: null,
    status: "SUCCESS",
    timestamp: at,
  });

beforeEach(() => {
  for (const f of fs.readdirSync(path.join(dir, "data"))) fs.rmSync(path.join(dir, "data", f), { force: true });
});

test("a small loan to a stranger seller passes", () => {
  assert.equal(creditRefusal({ human: HUMAN, amountUsd: 1, seller: SELLER }), null);
});

test("lending stops at the pool cap, counting what is already out", () => {
  // Old enough not to count against today's budget.
  loan(19, { borrowedAt: Date.now() - 2 * DAY });
  assert.match(creditRefusal({ human: HUMAN, amountUsd: 2 }) ?? "", /at its limit/);
});

test("new lending stops at the daily budget", () => {
  loan(14.9);
  assert.match(creditRefusal({ human: HUMAN, amountUsd: 0.5 }) ?? "", /for today/);
});

test("yesterday's lending does not count against today's budget", () => {
  loan(14, { borrowedAt: Date.now() - 2 * DAY });
  assert.equal(creditRefusal({ human: HUMAN, amountUsd: 1 }), null);
});

test("the breaker trips when too many due loans go unpaid, and not before", () => {
  const past = { borrowedAt: Date.now() - 10 * DAY, dueAt: Date.now() - DAY };
  for (let i = 0; i < 4; i++) loan(0.1, past);
  assert.equal(riskStatus().breakerTripped, false, "too few loans have fallen due to judge");

  loan(0.1, past);
  const s = riskStatus();
  assert.equal(s.loansDue, 5);
  assert.equal(s.loansUnpaid, 5);
  assert.equal(s.breakerTripped, true);
  assert.match(creditRefusal({ human: HUMAN, amountUsd: 0.01 }) ?? "", /paused new credit/);
});

test("repaid loans keep the breaker quiet", () => {
  const settled = { borrowedAt: Date.now() - 10 * DAY, dueAt: Date.now() - DAY, status: "SETTLED", outstandingAmount: 0 };
  for (let i = 0; i < 9; i++) loan(0.1, settled);
  loan(0.1, { borrowedAt: Date.now() - 10 * DAY, dueAt: Date.now() - DAY });
  const s = riskStatus();
  assert.equal(s.defaultRate, 0.1);
  assert.equal(s.breakerTripped, false);
});

test("loans due long ago no longer count", () => {
  const old = { borrowedAt: Date.now() - 90 * DAY, dueAt: Date.now() - 60 * DAY };
  for (let i = 0; i < 6; i++) loan(0.1, old);
  assert.equal(riskStatus().loansDue, 0);
  assert.equal(riskStatus().breakerTripped, false);
});

test("a borrower cannot pay their own agent or themselves with credit", () => {
  addAgentToStore({ address: AGENT, name: "a", humanOwner: HUMAN } as any);
  assert.equal(isSelfDealing(HUMAN, AGENT.toUpperCase().replace("0X", "0x")), true);
  assert.equal(isSelfDealing(HUMAN, HUMAN), true);
  assert.equal(isSelfDealing(HUMAN, SELLER), false);
  assert.match(creditRefusal({ human: HUMAN, amountUsd: 0.5, seller: AGENT }) ?? "", /pay yourself/);
});

test("credit to one seller stops at its daily limit, across borrowers", () => {
  paid("2.50");
  paid("0.40");
  paid("9.00", SELLER, Date.now() - 2 * DAY);
  paid("9.00", "0x00000000000000000000000000000000000000c3");
  assert.ok(Math.abs(lentToSellerToday(SELLER) - 2.9) < 1e-9);
  assert.equal(creditRefusal({ human: HUMAN, amountUsd: 0.1, seller: SELLER }), null);
  assert.match(creditRefusal({ human: HUMAN, amountUsd: 0.2, seller: SELLER }) ?? "", /credit limit for this seller/);
});

test("a seller with a bad record is not lent against", () => {
  for (let i = 0; i < 6; i++) recordSellerOutcome(SELLER, "failed");
  assert.match(creditRefusal({ human: HUMAN, amountUsd: 0.1, seller: SELLER }) ?? "", /will not lend/);
});

test("a direct draw has no seller to judge", () => {
  for (let i = 0; i < 6; i++) recordSellerOutcome(SELLER, "failed");
  assert.equal(creditRefusal({ human: HUMAN, amountUsd: 0.1 }), null);
});

test("the public status gives totals and nothing about anyone", () => {
  loan(1);
  const text = JSON.stringify(riskStatus());
  assert.ok(!text.includes(HUMAN));
  assert.ok(!text.includes(AGENT));
  assert.equal(riskStatus().outstandingUsd, 1.01);
});
