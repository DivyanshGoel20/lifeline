import fs from "./storeFs";
import path from "path";
import Stripe from "stripe";
import { writeJsonAtomic } from "./atomicWrite";
import { getAgentByAddress, getHumanFacilityStats } from "./agentStore";
import { prepareArcRepayment, commitArcRepayment } from "./repayCore";
import { withLedgerLock } from "./ledgerLock";
import { fundAndSettleSui, operatorReserveUsd, suiShortfall } from "./suiRail";

/**
 * Repaying by card, Apple Pay or Google Pay, through Stripe.
 *
 * Arc: the repayment is booked on the facility contract.
 * Sui: the payment covers one parked obligation, whole. Once it clears,
 * Lifeline's operator sends the agent the USDC it is short and the agent
 * settles on chain, as it would from its own earnings.
 *
 * The human pays Lifeline in dollars; once Stripe says the payment succeeded,
 * Lifeline books the repayment on the facility contract, exactly as a USDC
 * repayment is booked. Stripe's word is taken from Stripe - the payment is
 * retrieved server-side by id, never believed from the browser - and each
 * payment is booked once, however many times it is reported (the browser's
 * confirmation and the webhook both arrive). Anything paid over what is owed
 * by the time it is booked goes back to the card.
 */

const PURPOSE = "lifeline_repayment";
// Stripe will not charge less than this in USD.
export const CARD_MINIMUM_USD = 0.5;

let client: Stripe | null = null;
export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  client ??= new Stripe(key);
  return client;
}
export const cardEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
/** Tests stand in for Stripe here. */
export const useStripeClient = (c: Stripe | null) => (client = c);

/* ---- which payments have been booked ---------------------------------- */

type Booking = {
  human: string;
  status: "booking" | "booked" | "refunded";
  rail?: "arc" | "sui";
  amountUsd?: number;
  txHash?: string;
  refundedUsd?: number;
  at: number;
};

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "card-repayments.json"),
    path.resolve(process.cwd(), "data", "card-repayments.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
const read = (): Record<string, Booking> => {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
};
const save = (id: string, b: Booking | null) => {
  const all = read();
  if (b) all[id] = b;
  else delete all[id];
  writeJsonAtomic(file(), all);
};
export const bookingFor = (paymentIntentId: string) => read()[paymentIntentId] ?? null;

/* ---- starting a payment ------------------------------------------------ */

export async function startCardRepayment(p: {
  human: string;
  agentAddress: string;
  amountUsd: number;
  /** Sui: the obligation this pays off, whole. */
  obligationId?: string;
}) {
  if (p.obligationId) return startSuiCardRepayment(p.human, p.obligationId);
  const agent = getAgentByAddress(p.agentAddress);
  if (!agent || agent.humanOwner.toLowerCase() !== p.human.toLowerCase()) {
    return { error: "That agent is not yours.", status: 403 } as const;
  }
  const owed = getHumanFacilityStats(p.human).arcOutstandingDebt;
  if (owed <= 0.0001) return { error: "Nothing is owed on Arc.", status: 400 } as const;
  if (!(p.amountUsd > 0)) return { error: "Enter an amount.", status: 400 } as const;

  // Paying it all rounds up to the cent (the fraction of a cent stays with
  // Lifeline); paying part rounds to the nearest cent.
  const all = p.amountUsd >= owed - 0.0001;
  const cents = all ? Math.ceil(owed * 100 - 1e-6) : Math.round(Math.min(p.amountUsd, owed) * 100);
  if (cents < CARD_MINIMUM_USD * 100) {
    return { error: `Card payments start at $${CARD_MINIMUM_USD.toFixed(2)}. Repay less than that from the agent's wallet.`, status: 400 } as const;
  }

  const intent = await stripe().paymentIntents.create({
    amount: cents,
    currency: "usd",
    // Cards only - Apple Pay and Google Pay are card wallets, so they are
    // included; Link and the rest are not, which keeps the form short.
    payment_method_types: ["card"],
    description: `Lifeline repayment · ${agent.name}`,
    metadata: { purpose: PURPOSE, human: p.human, agentAddress: agent.address },
  });
  return { clientSecret: intent.client_secret!, paymentIntentId: intent.id, amountUsd: cents / 100 } as const;
}

async function startSuiCardRepayment(human: string, obligationId: string) {
  let s;
  try {
    s = await suiShortfall(human, obligationId);
  } catch (err: any) {
    return { error: err?.message ?? "No such obligation.", status: 404 } as const;
  }
  if (!s.open || s.owedUsd <= 0) return { error: "That obligation is already settled.", status: 400 } as const;
  const agent = getAgentByAddress(s.agentAddress);
  if (!agent || agent.humanOwner.toLowerCase() !== human.toLowerCase()) return { error: "That agent is not yours.", status: 403 } as const;

  if (s.fundUnits <= 0n) {
    return { error: "The agent's purse already covers this. Settle it from the agent instead.", status: 400 } as const;
  }
  // What the purse is short, rounded up to the cent; Stripe's floor above that is refunded.
  const cents = Math.max(Math.ceil(s.fundUsd * 100 - 1e-6), CARD_MINIMUM_USD * 100);
  // The operator puts that in the purse once the card clears; make sure it can.
  const reserve = await operatorReserveUsd().catch(() => 0);
  if (reserve < s.fundUsd) {
    return { error: `Lifeline's Sui reserve holds $${reserve.toFixed(2)}, short of the $${s.fundUsd.toFixed(2)} this needs. Try later.`, status: 503 } as const;
  }

  const intent = await stripe().paymentIntents.create({
    amount: cents,
    currency: "usd",
    payment_method_types: ["card"],
    description: `Lifeline repayment · ${agent.name} · Sui`,
    metadata: { purpose: PURPOSE, human, agentAddress: agent.address, rail: "sui", obligationId, fundUnits: s.fundUnits.toString() },
  });
  return {
    clientSecret: intent.client_secret!,
    paymentIntentId: intent.id,
    amountUsd: cents / 100,
    owedUsd: s.owedUsd,
    note: cents / 100 > s.fundUsd + 0.005 ? `Card payments start at $${CARD_MINIMUM_USD.toFixed(2)}; what is over the debt is refunded.` : undefined,
  } as const;
}

/* ---- booking a paid one ----------------------------------------------- */

export type CardBookingResult =
  | { ok: true; alreadyBooked?: boolean; amountUsd: number; txHash?: string; refundedUsd: number; rail?: "arc" | "sui" }
  | { ok: false; status: number; error: string };

export async function bookCardRepayment(paymentIntentId: string, asHuman?: string): Promise<CardBookingResult> {
  const intent = await stripe().paymentIntents.retrieve(paymentIntentId);
  const human = intent.metadata?.human;
  if (intent.metadata?.purpose !== PURPOSE || !human) return { ok: false, status: 400, error: "Not a Lifeline repayment." };
  if (asHuman && asHuman.toLowerCase() !== human.toLowerCase()) return { ok: false, status: 403, error: "Not your payment." };
  if (intent.currency !== "usd") return { ok: false, status: 400, error: "Unexpected currency." };
  if (intent.status !== "succeeded") return { ok: false, status: 409, error: `The payment is ${intent.status.replace(/_/g, " ")}.` };

  // Queued behind any other change to this human's ledger.
  return withLedgerLock(human, () => book(intent, human));
}

async function book(intent: Stripe.PaymentIntent, human: string): Promise<CardBookingResult> {
  // Claimed before booking, so the webhook and the browser cannot both book it.
  const existing = bookingFor(intent.id);
  if (existing) {
    return existing.status === "booking"
      ? { ok: false, status: 409, error: "Already being booked." }
      : { ok: true, alreadyBooked: true, amountUsd: existing.amountUsd ?? 0, txHash: existing.txHash, refundedUsd: existing.refundedUsd ?? 0, rail: existing.rail };
  }
  save(intent.id, { human, status: "booking", at: Date.now() });

  const paidUsd = (intent.amount_received || intent.amount) / 100;
  if (intent.metadata.rail === "sui") return bookSui(intent, human, paidUsd);
  try {
    const agent = getAgentByAddress(intent.metadata.agentAddress);
    const prepared = await prepareArcRepayment(human, paidUsd);
    if (!agent || !prepared.ok) {
      // Paid, but nothing left to repay by now: it all goes back.
      await stripe().refunds.create({ payment_intent: intent.id });
      save(intent.id, { human, status: "refunded", amountUsd: 0, refundedUsd: paidUsd, at: Date.now() });
      return { ok: true, amountUsd: 0, refundedUsd: paidUsd };
    }

    const { result, txHash } = await commitArcRepayment({
      humanOwner: human,
      payingAgent: agent,
      beneficiaryAddress: agent.address,
      amount: prepared.amount,
      funding: { kind: "card", reference: intent.id },
    });

    // Booked, and recorded as booked before anything else can fail: a failed
    // refund must never let the same payment be booked a second time.
    const overCents = Math.floor((paidUsd - result.amountRepaid) * 100 + 1e-6);
    save(intent.id, { human, status: "booked", amountUsd: result.amountRepaid, txHash, refundedUsd: 0, at: Date.now() });
    const refundedUsd = await refundOver(intent.id, overCents);
    save(intent.id, { human, status: "booked", amountUsd: result.amountRepaid, txHash, refundedUsd, at: Date.now() });
    return { ok: true, amountUsd: result.amountRepaid, txHash, refundedUsd };
  } catch (err: any) {
    // Not booked: let it be tried again.
    save(intent.id, null);
    return { ok: false, status: 500, error: err?.message ?? "Could not book the repayment." };
  }
}

async function bookSui(intent: Stripe.PaymentIntent, human: string, paidUsd: number): Promise<CardBookingResult> {
  const obligationId = intent.metadata.obligationId;
  const paidFor = BigInt(intent.metadata.fundUnits || "0");
  let r;
  try {
    const before = await suiShortfall(human, obligationId);
    if (!before.open) {
      // Settled some other way meanwhile: it all goes back.
      save(intent.id, { human, rail: "sui", status: "refunded", amountUsd: 0, refundedUsd: 0, at: Date.now() });
      const refundedUsd = await refundOver(intent.id, Math.round(paidUsd * 100));
      save(intent.id, { human, rail: "sui", status: "refunded", amountUsd: 0, refundedUsd, at: Date.now() });
      return { ok: true, amountUsd: 0, refundedUsd, rail: "sui" };
    }
    r = await fundAndSettleSui(human, obligationId, paidFor);
  } catch (err: any) {
    // Nothing settled: free to be tried again (the shortfall is read afresh,
    // so a deposit that did land is not sent twice).
    save(intent.id, null);
    return { ok: false, status: 500, error: err?.message ?? "Could not settle on Sui." };
  }

  // Settled on chain. Recorded before the refund, which may fail on its own.
  const chargedUsd = Number(paidFor) / 1e6;
  const txHash = "digest" in r ? r.digest : undefined;
  save(intent.id, { human, rail: "sui", status: "booked", amountUsd: chargedUsd, txHash, refundedUsd: 0, at: Date.now() });
  const refundedUsd = await refundOver(intent.id, Math.floor((paidUsd - chargedUsd) * 100 + 1e-6));
  save(intent.id, { human, rail: "sui", status: "booked", amountUsd: chargedUsd, txHash, refundedUsd, at: Date.now() });
  return { ok: true, amountUsd: chargedUsd, txHash, refundedUsd, rail: "sui" };
}

/** Give back whole cents over what was used. A failure is logged, not thrown: the booking stands. */
async function refundOver(paymentIntentId: string, cents: number): Promise<number> {
  if (cents <= 0) return 0;
  try {
    await stripe().refunds.create({ payment_intent: paymentIntentId, amount: cents });
    return cents / 100;
  } catch (err: any) {
    console.error(`[cardRepay] refund of ${cents}c on ${paymentIntentId} failed - refund it from the Stripe dashboard:`, err?.message ?? err);
    return 0;
  }
}
