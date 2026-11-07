import { formatUnits, parseUnits } from "viem";
import { ARC_BRIDGE_CHAIN } from "./arc";
import { arcGatewayClient, depositReallyFailed } from "./arcGateway";
import { DAILY_INTEREST_RATE, ORIGINATION_FEE_RATE } from "./reputationEngine";
import { executeSwap, formatToken, holdingsOf, quoteForUsdc, swapChain, uniswapConfigured, usdcOn, weiToUsd, type SwapQuote } from "./uniswapApi";

/**
 * Swap or borrow?
 *
 * An agent short of USDC may still hold other tokens. A credit line should only lend when
 * lending is the better deal, so before a loan is recorded this asks Uniswap what swapping
 * would cost, and compares it with what borrowing would. Whichever is chosen, the receipt
 * says why.
 */
const envNumber = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};
export const swapSettings = () => ({
  /** Below this, gas alone outweighs any saving, so asking only adds a delay. */
  minUsd: envNumber("LIFELINE_SWAP_MIN_USD", 0.05),
  /** How long a loan is assumed to stay open when pricing its interest. */
  expectedLoanDays: envNumber("LIFELINE_EXPECTED_LOAN_DAYS", 3),
  /**
   * What tying up credit is worth: using it all costs this fraction of the amount, and
   * using a little almost nothing. A judgement, not a market price.
   */
  lineCostRate: envNumber("LIFELINE_LINE_COST_RATE", 0.02),
  /** The bridge's fee, and the gas to mint and deposit on Arc. */
  bridgeFeeUsd: envNumber("LIFELINE_BRIDGE_FEE_USD", 0.01),
  arcGasUsd: envNumber("LIFELINE_ARC_GAS_USD", 0.01),
  /** Asking must not slow a purchase down by more than this. */
  decideTimeoutMs: envNumber("LIFELINE_SWAP_DECIDE_MS", 3500),
  /** Gas the bridge's approval and burn use on the swap chain. */
  bridgeGasUnits: 250_000,
  /** Gas a token's first approval uses. */
  approvalGasUnits: 60_000,
});

export type BorrowCost = { feeUsd: number; interestUsd: number; lineUsd: number; totalUsd: number; possible: boolean };

export function borrowCost(amountUsd: number, headroomUsd: number, s = swapSettings()): BorrowCost {
  const feeUsd = amountUsd * ORIGINATION_FEE_RATE;
  const interestUsd = amountUsd * DAILY_INTEREST_RATE * s.expectedLoanDays;
  const owed = amountUsd + feeUsd;
  const lineUsd = headroomUsd > 0 ? amountUsd * Math.min(1, owed / headroomUsd) * s.lineCostRate : 0;
  return { feeUsd, interestUsd, lineUsd, totalUsd: feeUsd + interestUsd + lineUsd, possible: owed <= headroomUsd };
}

export type SwapCost = { token: string; amountIn: string; impactUsd: number; poolFeeUsd: number; gasUsd: number; bridgeUsd: number; totalUsd: number };

export type FundingDecision = {
  choice: "swap" | "borrow";
  amountUsd: number;
  reason: string;
  borrow: BorrowCost;
  swap: SwapCost | null;
  savedUsd: number | null;
};

const money = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/** The comparison alone: the numbers in, the choice and the sentence for the receipt out. */
export function decideFunding(amountUsd: number, borrow: BorrowCost, swap: SwapCost | null, why?: string): FundingDecision {
  if (!swap) {
    return { choice: "borrow", amountUsd, borrow, swap: null, savedUsd: null, reason: why ?? "Borrowed: the agent holds nothing it could swap." };
  }
  if (!borrow.possible || swap.totalUsd < borrow.totalUsd) {
    const savedUsd = borrow.possible ? borrow.totalUsd - swap.totalUsd : null;
    return {
      choice: "swap",
      amountUsd,
      borrow,
      swap,
      savedUsd,
      reason: borrow.possible
        ? `Swapped ${swap.amountIn} ${swap.token} → ${money(amountUsd)}. Cheaper than borrowing by ${money(savedUsd!)}.`
        : `Swapped ${swap.amountIn} ${swap.token} → ${money(amountUsd)}. The line has too little left to borrow.`,
    };
  }
  const savedUsd = swap.totalUsd - borrow.totalUsd;
  return {
    choice: "borrow",
    amountUsd,
    borrow,
    swap,
    savedUsd,
    reason: `Borrowed ${money(amountUsd)}. Cheaper than swapping ${swap.token} by ${money(savedUsd)}.`,
  };
}

export async function swapCostOf(q: SwapQuote, amountUsd: number, swapper: string, deps: { weiUsd?: typeof weiToUsd } = {}, s = swapSettings()): Promise<SwapCost> {
  const weiUsd = deps.weiUsd ?? weiToUsd;
  const approvalGas = q.raw?.permitData ? s.approvalGasUnits : 0;
  const extraGasUsd = await weiUsd(BigInt(s.bridgeGasUnits + approvalGas) * q.maxFeePerGas, swapper);
  const impactUsd = amountUsd * (q.impactPct / 100);
  const poolFeeUsd = amountUsd * q.poolFee;
  const gasUsd = q.gasUsd + extraGasUsd;
  const bridgeUsd = s.bridgeFeeUsd + s.arcGasUsd;
  return { token: q.token, amountIn: formatToken(q.amountIn, q.decimals), impactUsd, poolFeeUsd, gasUsd, bridgeUsd, totalUsd: impactUsd + poolFeeUsd + gasUsd + bridgeUsd };
}

export type SwapDeps = {
  holdings?: typeof holdingsOf;
  quote?: typeof quoteForUsdc;
  cost?: typeof swapCostOf;
};

/** USDC the swap must yield: the price, plus what bridging and Arc's gas take off the way. */
export const usdcToBuy = (amountUsd: number, s = swapSettings()) =>
  parseUnits((amountUsd + s.bridgeFeeUsd + s.arcGasUsd).toFixed(6), 6);

/**
 * Called before a draw is recorded. Never throws, and never holds a purchase up for long:
 * any failure or delay here means borrowing, which is what happened before this existed.
 */
export async function chooseFunding(
  p: { agent: string; amountUsd: number; headroomUsd: number },
  deps: SwapDeps = {}
): Promise<{ decision: FundingDecision; quote: SwapQuote | null }> {
  const s = swapSettings();
  const borrow = borrowCost(p.amountUsd, p.headroomUsd, s);
  const borrowing = (why: string) => ({ decision: decideFunding(p.amountUsd, borrow, null, why), quote: null });

  if (!uniswapConfigured() && !deps.quote) return borrowing("Borrowed: swapping is not set up.");
  if (p.amountUsd < s.minUsd) return borrowing(`Borrowed: at ${money(p.amountUsd)}, a swap's gas alone would cost more.`);

  const work = async () => {
    const held = await (deps.holdings ?? holdingsOf)(p.agent);
    const candidates = Object.entries(held).filter(([, amount]) => amount > 0n);
    if (candidates.length === 0) return borrowing("Borrowed: the agent holds nothing it could swap.");

    const need = usdcToBuy(p.amountUsd, s);
    const priced = await Promise.all(
      candidates.map(async ([token, amount]) => {
        try {
          const q = await (deps.quote ?? quoteForUsdc)(token, need, p.agent);
          if (q.maxAmountIn > amount) return null;
          return { q, cost: await (deps.cost ?? swapCostOf)(q, p.amountUsd, p.agent) };
        } catch {
          return null;
        }
      })
    );
    const options = priced.filter(Boolean) as { q: SwapQuote; cost: SwapCost }[];
    if (options.length === 0) return borrowing("Borrowed: what the agent holds would not cover it through Uniswap.");
    const best = options.reduce((a, b) => (b.cost.totalUsd < a.cost.totalUsd ? b : a));
    const decision = decideFunding(p.amountUsd, borrow, best.cost);
    return { decision, quote: decision.choice === "swap" ? best.q : null };
  };

  try {
    return await Promise.race([
      work(),
      new Promise<ReturnType<typeof borrowing>>((resolve) => setTimeout(() => resolve(borrowing("Borrowed: Uniswap did not answer in time.")), s.decideTimeoutMs)),
    ]);
  } catch {
    return borrowing("Borrowed: Uniswap could not be reached.");
  }
}

export type SwapFunders = {
  swap?: typeof executeSwap;
  bridge?: (privateKey: `0x${string}`, amountUsd: number) => Promise<{ state: string; steps?: any[] }>;
  deposit?: (privateKey: `0x${string}`, amountUsd: number) => Promise<unknown>;
  usdc?: typeof usdcOn;
};

const bridgeToArc = async (privateKey: `0x${string}`, amountUsd: number) => {
  const [{ BridgeKit }, { createViemAdapterFromPrivateKey }] = await Promise.all([import("@circle-fin/bridge-kit"), import("@circle-fin/adapter-viem-v2")]);
  const adapter = createViemAdapterFromPrivateKey({ privateKey });
  const result = await new BridgeKit().bridge({
    from: { adapter, chain: swapChain().bridgeChain },
    to: { adapter, chain: ARC_BRIDGE_CHAIN },
    amount: amountUsd.toFixed(6),
  } as any);
  return { state: result.state, steps: result.steps as any[] };
};

const depositToOwnGateway = async (privateKey: `0x${string}`, amountUsd: number) => {
  try {
    return await arcGatewayClient(privateKey).deposit(amountUsd.toFixed(6));
  } catch (err) {
    const checked = await depositReallyFailed(err);
    if (!checked?.succeeded) throw err;
    return { depositTxHash: checked.hash };
  }
};

/**
 * Turn the chosen token into spending power: swap on Uniswap, bridge to Arc, deposit into
 * the agent's own Gateway balance. Throws if any step fails, and the caller then borrows.
 */
export async function fundBySwap(privateKey: `0x${string}`, agent: string, quote: SwapQuote, amountUsd: number, deps: SwapFunders = {}) {
  const { swap = executeSwap, bridge = bridgeToArc, deposit = depositToOwnGateway, usdc = usdcOn } = deps;
  const before = await usdc(agent);
  const { txHash } = await swap(privateKey, quote);
  const bought = (await usdc(agent)) - before;
  if (bought <= 0n) throw new Error(`The swap ${txHash} delivered no USDC.`);

  const bridged = await bridge(privateKey, Number(formatUnits(bought, 6)));
  if (bridged.state !== "success") {
    const failed = bridged.steps?.find((step: any) => step.state === "error");
    throw new Error(`The bridge did not finish: ${failed?.errorMessage ?? bridged.state}`);
  }
  await deposit(privateKey, amountUsd);
  return { swapTx: txHash, bridgeSteps: bridged.steps ?? [] };
}
