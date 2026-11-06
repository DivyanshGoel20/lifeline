process.env.LIFELINE_SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fundLoanFromPool, returnRepaymentToPool, usePoolChain } from "../src/lib/poolFunding";

let drawable: number, outstanding: number;
let draws: number[], repays: [number, number][];

beforeEach(() => {
  process.env.LIFELINE_LENDING_POOL_ADDRESS = "0x00000000000000000000000000000000000000b0";
  drawable = 10;
  outstanding = 0;
  draws = [];
  repays = [];
  usePoolChain({
    drawableUsd: async () => drawable,
    outstandingUsd: async () => outstanding,
    draw: async (u) => (draws.push(u), "0xdraw"),
    repay: async (p, i) => (repays.push([p, i]), "0xrepay"),
  });
});

test("a loan is drawn from the pool when it has room", async () => {
  assert.equal(await fundLoanFromPool(1), "0xdraw");
  assert.deepEqual(draws, [1]);
});

test("with no room, the operator funds the loan and nothing is drawn", async () => {
  drawable = 0.5;
  assert.equal(await fundLoanFromPool(1), null);
  assert.deepEqual(draws, []);
});

test("with no pool configured nothing happens", async () => {
  delete process.env.LIFELINE_LENDING_POOL_ADDRESS;
  assert.equal(await fundLoanFromPool(1), null);
  assert.equal(await returnRepaymentToPool(1, 0.1), null);
});

test("a failing pool never stops a loan", async () => {
  usePoolChain({
    drawableUsd: async () => { throw new Error("rpc down"); },
    outstandingUsd: async () => { throw new Error("rpc down"); },
    draw: async () => "",
    repay: async () => "",
  });
  assert.equal(await fundLoanFromPool(1), null);
  assert.equal(await returnRepaymentToPool(1, 0.1), null);
});

test("a repayment goes back with its interest", async () => {
  outstanding = 5;
  await returnRepaymentToPool(1, 0.1);
  assert.deepEqual(repays, [[1, 0.1]]);
});

test("a loan the pool did not fund pays it nothing", async () => {
  outstanding = 0;
  assert.equal(await returnRepaymentToPool(1, 0.1), null);
  assert.deepEqual(repays, []);
});

test("only what the pool lent goes back, with interest in proportion", async () => {
  outstanding = 0.5;
  await returnRepaymentToPool(1, 0.1);
  assert.deepEqual(repays, [[0.5, 0.05]]);
});
