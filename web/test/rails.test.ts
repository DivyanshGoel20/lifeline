import { test } from "node:test";
import assert from "node:assert/strict";
import { useSandbox } from "./sandbox";
import { NextRequest, NextResponse } from "next/server";
import { attachSession } from "../src/lib/session";
import { POST as borrow } from "../src/app/api/borrow/route";
import { POST as suiPay } from "../src/app/api/sui/pay/route";
import { addAgentToStore, getHumanFacilityStats, getSuiFacilityStats, updateAgentInStore } from "../src/lib/agentStore";
import { openRailDebt, settleObligation } from "../src/lib/railDebt";
import { getHumanCreditTier, getHumanReputationRecord, recordRepaymentInReputation } from "../src/lib/reputationStore";

/**
 * Arc and Sui are separate lines: separate limits, separate debt, separate
 * repayment records. Nothing on one rail moves the other.
 */

useSandbox();
const HUMAN = "0x" + "d4".repeat(32);
const AGENT = ("0x" + "44".repeat(20)) as `0x${string}`;
addAgentToStore({ address: AGENT, name: "a", humanOwner: HUMAN, creditLimit: 10, outstandingDebt: 0, totalBorrowed: 0, totalRepaid: 0, currentBalance: 0 } as any);

test("each rail starts with its own $0.50 line", () => {
  assert.equal(getHumanFacilityStats(HUMAN).totalAvailableCredit, 0.5);
  assert.equal(getSuiFacilityStats(HUMAN).availableCredit, 0.5);
});

test("what Sui draws uses the Sui line only", () => {
  openRailDebt({ humanOwner: HUMAN, rail: "sui", agentAddress: AGENT, amountUsd: 0.2, obligationId: "0xob1", resource: "/risk" });
  assert.equal(getSuiFacilityStats(HUMAN).availableCredit, 0.3);
  assert.equal(getHumanFacilityStats(HUMAN).totalAvailableCredit, 0.5, "Arc is untouched");
});

test("what Arc owes uses the Arc line only", () => {
  updateAgentInStore(AGENT, { outstandingDebt: 0.3 });
  assert.equal(getHumanFacilityStats(HUMAN).totalAvailableCredit, 0.2);
  assert.equal(getSuiFacilityStats(HUMAN).availableCredit, 0.3, "Sui is untouched");
  updateAgentInStore(AGENT, { outstandingDebt: 0 });
  settleObligation("0xob1");
  assert.equal(getSuiFacilityStats(HUMAN).availableCredit, 0.5);
});

test("repaying on one rail builds that rail's record, and only that one", async () => {
  for (let i = 0; i < 3; i++) await recordRepaymentInReputation({ humanOwner: HUMAN, interestPaid: 0, loanDurationDays: 3, rail: "sui" });
  assert.equal(getHumanReputationRecord(HUMAN, "sui").repaymentsCount, 3);
  assert.equal(getHumanReputationRecord(HUMAN, "arc").repaymentsCount, 0, "Arc's record is untouched");
});

test("Sui's line grows on repayments and time, since Sui charges no fee", async () => {
  // Tier 2 needs 3 repayments over 7 days (and a fee, on Arc): 3 x 3 days.
  assert.equal(getHumanCreditTier(HUMAN, "sui").creditLimit, 1);
  assert.equal(getHumanCreditTier(HUMAN, "arc").creditLimit, 0.5, "Arc's limit did not move");
});

/* ---- agents belong to one rail --------------------------------------- */


const SUI_AGENT = ("0x" + "55".repeat(20)) as `0x${string}`;
addAgentToStore({ address: SUI_AGENT, name: "s", humanOwner: HUMAN, rail: "sui", creditLimit: 10, outstandingDebt: 0, totalBorrowed: 0, totalRepaid: 0, currentBalance: 0 } as any);
const cookie = () => `lifeline_session=${attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value}`;
const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { cookie: cookie(), "content-type": "application/json" } });

test("a Sui agent cannot borrow on Arc", async () => {
  const res = await borrow(post("/api/borrow", { agentAddress: SUI_AGENT, amount: 1 }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "wrong_rail");
});

test("an Arc agent cannot pay on Sui", async () => {
  const res = await suiPay(post("/api/sui/pay", { url: "http://x/risk", agentAddress: AGENT }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "wrong_rail");
});

test("Arc's line counts Arc agents only", () => {
  updateAgentInStore(SUI_AGENT, { outstandingDebt: 0.1 }); // a stray figure on a Sui agent
  assert.equal(getHumanFacilityStats(HUMAN).totalAvailableCredit, 0.5);
});
