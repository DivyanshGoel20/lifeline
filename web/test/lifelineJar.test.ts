process.env.LIFELINE_SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useSandbox } from "./sandbox";
import { clearJar, jarContracts, jarOpen, repayWithToken } from "../src/lib/lifelineJar";

/** The rules around a token repayment. The real chain is in test/e2e/jar.fork.e2e.ts. */
const dir = useSandbox();
const AGENT = "0x00000000000000000000000000000000000000a1";
const base = { human: "0xhuman", agent: { address: AGENT, humanOwner: "0xhuman" } as any, token: "WETH" as const, amount: "0.001" };

let sent: bigint[];
let booked: number[];
function deps(over: Record<string, unknown> = {}) {
  return {
    open: () => true,
    key: () => "0xkey",
    allow: () => ({ ok: true }),
    owed: async () => 3,
    quote: async () => ({ worthUsd: 2.5, creditUsd: 2.425 }),
    send: async ({ units }: { units: bigint }) => (sent.push(units), "0xsent"),
    book: async ({ amountUsd }: { amountUsd: number }) => (booked.push(amountUsd), { repaidUsd: amountUsd, txHash: "0xbooked" }),
    ...over,
  } as any;
}

beforeEach(() => {
  sent = [];
  booked = [];
  for (const f of fs.readdirSync(path.join(dir, "data"))) fs.rmSync(path.join(dir, "data", f), { force: true });
});

test("no token moves and nothing clears until repayments are opened", async () => {
  delete process.env.LIFELINE_JAR_REPAYMENTS;
  assert.equal(jarOpen(), false);
  await assert.rejects(repayWithToken(base, deps({ open: jarOpen })), /opens when credit moves/);
  assert.equal(sent.length, 0);
  assert.deepEqual(await clearJar(), { cleared: false, reason: "Clearing opens with repayments." });
});

test("the deployed contracts are named without any setting", () => {
  delete process.env.LIFELINE_JAR_ADDRESS;
  delete process.env.LIFELINE_JAR_RELEASER_ADDRESS;
  const { jar, releaser, open } = jarContracts();
  assert.equal(jar, "0x9282BCCAda9C009CCC4c80e52a0A02b342fc0e8B");
  assert.equal(releaser, "0xa64688229151023Ca2b2f9B3eFe9FB9f2899A2Bc");
  assert.equal(open, false);
});

test("the debt falls by the token's worth less the margin, and the token moves first", async () => {
  const out = await repayWithToken(base, deps());
  assert.deepEqual(sent, [10n ** 15n]);
  assert.deepEqual(booked, [2.425]);
  assert.equal(out.repaidUsd, 2.425);
  assert.equal(out.jarTxHash, "0xsent");
});

test("more than is owed is refused before anything moves: the excess would not come back", async () => {
  await assert.rejects(repayWithToken(base, deps({ owed: async () => 1 })), /only \$1\.00 is owed/);
  assert.deepEqual(sent, []);
});

test("nothing owed sends nothing", async () => {
  await assert.rejects(repayWithToken(base, deps({ owed: async () => 0 })), /Nothing is owed/);
  assert.deepEqual(sent, []);
});

test("one repayment has a limit", async () => {
  await assert.rejects(repayWithToken(base, deps({ quote: async () => ({ worthUsd: 9, creditUsd: 8.7 }), owed: async () => 20 })), /limited to \$5\.00/);
  assert.deepEqual(sent, []);
});

test("the key's ceiling applies", async () => {
  await assert.rejects(repayWithToken(base, deps({ allow: () => ({ ok: false, reason: "over its ceiling" }) })), /over its ceiling/);
  assert.deepEqual(sent, []);
});

test("without the agent's key nothing moves", async () => {
  await assert.rejects(repayWithToken(base, deps({ key: () => null })), /does not hold this agent's key/);
});

test("a token already sent is booked by the next attempt, and never sent twice", async () => {
  let fail = true;
  const book = async ({ amountUsd }: { amountUsd: number }) => {
    if (fail) throw new Error("Arc is down");
    booked.push(amountUsd);
    return { repaidUsd: amountUsd, txHash: "0xbooked" };
  };
  await assert.rejects(repayWithToken(base, deps({ book })), /Arc is down/);
  assert.equal(sent.length, 1);
  assert.deepEqual(booked, []);

  fail = false;
  const out = await repayWithToken(base, deps({ book }));
  assert.equal(sent.length, 1, "not sent again");
  assert.deepEqual(booked, [2.425]);
  assert.equal(out.jarTxHash, "0xsent");

  // Booked now, so a later repayment is a new one.
  await repayWithToken(base, deps({ book }));
  assert.equal(sent.length, 2);
});
