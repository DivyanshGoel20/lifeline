process.env.UNISWAP_API_KEY = "test-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import { borrowCost, chooseFunding, decideFunding, fundBySwap, swapCostOf, swapSettings, usdcToBuy, type SwapCost } from "../src/lib/swapOrBorrow";
import { routeFee, type SwapQuote } from "../src/lib/uniswapApi";

const swap = (totalUsd: number): SwapCost => ({ token: "ETH", amountIn: "0.0021", impactUsd: 0, poolFeeUsd: 0, gasUsd: 0, bridgeUsd: 0, totalUsd });
const quote = (over: Partial<SwapQuote> = {}): SwapQuote =>
  ({ token: "ETH", amountIn: 100n, maxAmountIn: 110n, decimals: 18, impactPct: 0.1, gasUsd: 0.01, poolFee: 0.0005, maxFeePerGas: 1n, raw: {}, ...over }) as SwapQuote;

test("borrowing costs the fee, the interest and a share of the line", () => {
  const c = borrowCost(5, 10);
  assert.ok(Math.abs(c.feeUsd - 0.05) < 1e-9);
  assert.ok(Math.abs(c.interestUsd - 5 * 0.0005 * 3) < 1e-9);
  assert.ok(c.lineUsd > 0);
  assert.equal(c.possible, true);
});

test("using more of the line costs more", () => {
  assert.ok(borrowCost(1, 10).lineUsd < borrowCost(1, 2).lineUsd);
});

test("more than the line has cannot be borrowed", () => {
  assert.equal(borrowCost(5, 1).possible, false);
});

test("the cheaper swap wins, and the receipt says by how much", () => {
  const d = decideFunding(5, { feeUsd: 0, interestUsd: 0, lineUsd: 0, totalUsd: 0.1, possible: true }, swap(0.06));
  assert.equal(d.choice, "swap");
  assert.equal(d.reason, "Swapped 0.0021 ETH → $5.00. Cheaper than borrowing by $0.0400.");
});

test("cheaper borrowing wins, and the receipt says that too", () => {
  const d = decideFunding(0.2, { feeUsd: 0, interestUsd: 0, lineUsd: 0, totalUsd: 0.002, possible: true }, swap(0.05));
  assert.equal(d.choice, "borrow");
  assert.match(d.reason, /Borrowed \$0.20. Cheaper than swapping ETH by \$0.0480/);
});

test("when the line cannot cover it, a swap is the only way, whatever it costs", () => {
  const d = decideFunding(5, { feeUsd: 0, interestUsd: 0, lineUsd: 0, totalUsd: 0.01, possible: false }, swap(9));
  assert.equal(d.choice, "swap");
  assert.match(d.reason, /too little left/);
});

test("a swap's cost adds impact, pool fees, gas and the bridge", async () => {
  const c = await swapCostOf(quote({ impactPct: 1, poolFee: 0.003, gasUsd: 0.01 }), 10, "0xa", { weiUsd: async () => 0.02 });
  assert.ok(Math.abs(c.impactUsd - 0.1) < 1e-9);
  assert.ok(Math.abs(c.poolFeeUsd - 0.03) < 1e-9);
  assert.ok(Math.abs(c.gasUsd - 0.03) < 1e-9);
  assert.ok(Math.abs(c.totalUsd - (0.1 + 0.03 + 0.03 + 0.02)) < 1e-9);
});

test("pool fees are read from the route", () => {
  assert.equal(routeFee([[{ fee: "500" }, { fee: "3000" }]]), 0.0035);
  assert.equal(routeFee(undefined), 0);
});

test("the swap buys enough to cover the bridge and Arc's gas", () => {
  assert.equal(usdcToBuy(1), 1_020_000n);
});

/* ---------------------------------------------------------------- choosing */

const big = { agent: "0xa", amountUsd: 5, headroomUsd: 10 };

test("a small purchase borrows without asking anyone", async () => {
  let asked = false;
  const out = await chooseFunding({ ...big, amountUsd: 0.01 }, { holdings: async () => ((asked = true), {}) });
  assert.equal(asked, false);
  assert.equal(out.decision.choice, "borrow");
  assert.match(out.decision.reason, /gas alone/);
});

test("holding nothing means borrowing", async () => {
  const out = await chooseFunding(big, { holdings: async () => ({ ETH: 0n, UNI: 0n }), quote: async () => quote() });
  assert.equal(out.decision.choice, "borrow");
  assert.match(out.decision.reason, /nothing it could swap/);
});

const cost = (totalUsd: number, token = "ETH") => async () => ({ ...swap(totalUsd), token });

test("a token that is cheaper to swap is chosen, with its quote", async () => {
  const out = await chooseFunding(big, { holdings: async () => ({ ETH: 1000n }), quote: async () => quote(), cost: cost(0.01) });
  assert.equal(out.decision.choice, "swap");
  assert.ok(out.quote);
});

test("the cheapest of several tokens is compared", async () => {
  const out = await chooseFunding(big, {
    holdings: async () => ({ ETH: 1000n, UNI: 1000n }),
    quote: async (t) => quote({ token: t }),
    cost: async (q) => ({ ...swap(q.token === "UNI" ? 0.005 : 0.05), token: q.token }),
  });
  assert.equal(out.decision.swap?.token, "UNI");
});

test("too little of a token to cover it is not an option", async () => {
  const out = await chooseFunding(big, { holdings: async () => ({ ETH: 50n }), quote: async () => quote({ maxAmountIn: 100n }) });
  assert.equal(out.decision.choice, "borrow");
  assert.match(out.decision.reason, /would not cover/);
});

test("a dearer swap keeps the loan, and no quote is carried on", async () => {
  const out = await chooseFunding(big, { holdings: async () => ({ ETH: 1000n }), quote: async () => quote(), cost: cost(5) });
  assert.equal(out.decision.choice, "borrow");
  assert.equal(out.quote, null);
});

test("Uniswap failing never stops a purchase", async () => {
  const out = await chooseFunding(big, {
    holdings: async () => ({ ETH: 1000n }),
    quote: async () => {
      throw new Error("down");
    },
  });
  assert.equal(out.decision.choice, "borrow");
});

test("Uniswap being slow never holds a purchase up", async () => {
  const before = process.env.LIFELINE_SWAP_DECIDE_MS;
  process.env.LIFELINE_SWAP_DECIDE_MS = "20";
  const out = await chooseFunding(big, { holdings: () => new Promise(() => undefined) });
  process.env.LIFELINE_SWAP_DECIDE_MS = before ?? "";
  assert.match(out.decision.reason, /did not answer in time/);
  assert.equal(swapSettings().bridgeGasUnits, 250_000);
});

/* ---------------------------------------------------------------- funding */

const funders = (over = {}) => {
  const log: string[] = [];
  let usdc = 0n;
  return {
    log,
    deps: {
      usdc: async () => usdc,
      swap: async () => (log.push("swap"), (usdc = 5_020_000n), { txHash: "0xswap" }),
      bridge: async (_k: string, usd: number) => (log.push(`bridge ${usd}`), { state: "success", steps: [] }),
      deposit: async (_k: string, usd: number) => log.push(`deposit ${usd}`),
      ...over,
    } as any,
  };
};

test("funding goes swap, bridge, deposit, in that order", async () => {
  const f = funders();
  const out = await fundBySwap("0xk", "0xa", quote(), 5, f.deps);
  assert.deepEqual(f.log, ["swap", "bridge 5.02", "deposit 5"]);
  assert.equal(out.swapTx, "0xswap");
});

test("a swap that delivers nothing goes no further", async () => {
  const f = funders({ swap: async () => ({ txHash: "0xswap" }), usdc: async () => 0n });
  await assert.rejects(fundBySwap("0xk", "0xa", quote(), 5, f.deps), /delivered no USDC/);
  assert.deepEqual(f.log, []);
});

test("a bridge that fails deposits nothing, and says where it stopped", async () => {
  const f = funders({ bridge: async () => ({ state: "error", steps: [{ state: "error", errorMessage: "no gas" }] }) });
  await assert.rejects(fundBySwap("0xk", "0xa", quote(), 5, f.deps), /no gas/);
  assert.deepEqual(f.log, ["swap"]);
});
