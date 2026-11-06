import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";
import { getActiveLoansByHuman } from "./loanStore";
import { calculateLoanAccrual, CREDIT_TIERS } from "./reputationEngine";
import { getAgentsByOwner, updateAgentInStore } from "./agentStore";
import { railDebtsFor } from "./railDebt";
import { penalizeDefault } from "./reputationStore";

/**
 * Whether a human is keeping up with what they owe, per rail - and what the
 * chain says about it.
 *
 *   good        nothing overdue
 *   delinquent  Arc: a loan is past its due date. The line is suspended on
 *               chain (no new drawdowns; repaying still works), and the agents
 *               that owe are marked delinquent.
 *   defaulted   Arc: still unpaid a grace period after the due date, and
 *               marked defaulted on chain. Sui: a parked repayment fell due and
 *               the purse could not cover it (the chain records that itself).
 *               The record drops to the first tier.
 *
 * Paying everything overdue restores the line: active again on chain, agents
 * back to healthy. The penalty to the record stays.
 *
 * This is what a partner app would read about a human, and it only ever says
 * how they stand now.
 */
export type Standing = "good" | "delinquent" | "defaulted";
export type RailStanding = {
  status: Standing;
  /** Owed on loans that are past due (Arc) or on defaulted obligations (Sui). */
  overdueUsd: number;
  /** When the oldest overdue debt fell due. */
  dueSince?: number;
  /** Arc: when a delinquent line becomes a default, unless paid. */
  defaultsAt?: number;
};
type Applied = { status: Standing; at: number; chainTx?: string; chainError?: string; penalized?: boolean };
type Record_ = { arc?: Applied; sui?: Applied };

const DAY = 24 * 60 * 60 * 1000;
const graceMs = () => (Number(process.env.LIFELINE_DEFAULT_GRACE_DAYS) >= 0 && process.env.LIFELINE_DEFAULT_GRACE_DAYS !== undefined ? Number(process.env.LIFELINE_DEFAULT_GRACE_DAYS) : 30) * DAY;

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "standing.json"),
    path.resolve(process.cwd(), "data", "standing.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
const readAll = (): Record<string, Record_> => {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
};
const save = (human: string, r: Record_) => {
  const all = readAll();
  all[human.toLowerCase()] = r;
  writeJsonAtomic(file(), all);
};
export const appliedStanding = (human: string): Record_ => readAll()[human.toLowerCase()] ?? {};
export const standingHumans = () => Object.keys(readAll());

/** How the human stands on Arc, from the loan ledger. */
export function arcStanding(human: string, now = Date.now()): RailStanding {
  const overdue = getActiveLoansByHuman(human).filter((l) => l.dueAt && l.dueAt < now);
  if (!overdue.length) return { status: "good", overdueUsd: 0 };
  const dueSince = Math.min(...overdue.map((l) => l.dueAt!));
  const overdueUsd = Math.round(overdue.reduce((n, l) => n + calculateLoanAccrual(l, now).totalDue, 0) * 10000) / 10000;
  const defaultsAt = dueSince + graceMs();
  return { status: now >= defaultsAt ? "defaulted" : "delinquent", overdueUsd, dueSince, defaultsAt };
}

/** How the human stands on Sui, from the parked repayments. */
export function suiStanding(human: string): RailStanding {
  const defaulted = railDebtsFor(human).filter((r) => r.status === "defaulted");
  if (!defaulted.length) return { status: "good", overdueUsd: 0 };
  return {
    status: "defaulted",
    overdueUsd: Math.round(defaulted.reduce((n, r) => n + r.amountUsd, 0) * 10000) / 10000,
    dueSince: Math.min(...defaulted.map((r) => r.defaultedAt ?? r.createdAt)),
  };
}

export function standingOf(human: string, now = Date.now()) {
  return { arc: arcStanding(human, now), sui: suiStanding(human) };
}

/** The on-chain side, swappable so tests run without a chain. */
export type ChainHooks = {
  arc: { suspend(h: string): Promise<string>; activate(h: string): Promise<string>; markDefault(h: string): Promise<string> };
  sui: { setStatus(h: string, s: "active" | "defaulted"): Promise<string | undefined> };
  onPenalty?(h: string, rail: "arc" | "sui"): Promise<unknown>;
};
let hooks: ChainHooks | null = null;
export const useChainHooks = (h: ChainHooks | null) => (hooks = h);

async function chain(): Promise<ChainHooks> {
  if (hooks) return hooks;
  const fc = await import("./facilityContract");
  const { flushAgent } = await import("./ledgerFlush");
  // Settle pending drawdowns before suspending: the contract takes none while
  // a profile is not active, and they are already owed.
  const flushAll = async (h: string) => {
    for (const a of getAgentsByOwner(h)) await flushAgent(h, a.address, { force: true }).catch(() => {});
  };
  return {
    arc: {
      suspend: async (h) => (await flushAll(h), fc.setArcProfileStatus(h, "suspended")),
      activate: (h) => fc.setArcProfileStatus(h, "active"),
      markDefault: async (h) => (await flushAll(h), fc.markArcDefault(h)),
    },
    sui: {
      setStatus: async (h, s) => {
        const sui = await import("@lifeline/sui");
        const { suiConfigured } = await import("./suiRail");
        if (!suiConfigured()) return undefined;
        const profile = await sui.readProfile(fc.computeProfileId(h)).catch(() => null);
        if (!profile) return undefined;
        return (await sui.setProfileStatus(sui.operatorKeypair(), fc.computeProfileId(h), s)).digest;
      },
    },
    onPenalty: (h, rail) => (rail === "arc" ? fc.updateOnChainCreditLimit(h, CREDIT_TIERS[0].creditLimit) : Promise.resolve()),
  };
}

// One enforcement per human at a time.
const g = globalThis as unknown as { __lifelineStanding?: Map<string, Promise<unknown>> };
const running = (g.__lifelineStanding ??= new Map());

/**
 * Bring what is applied - on chain, on the agents, on the record - in line
 * with how the human stands. Safe to call often: it only acts on a change,
 * and a chain call that failed is tried again next time.
 */
export function enforceStanding(human: string, now = Date.now()) {
  const key = human.toLowerCase();
  const run = (running.get(key) ?? Promise.resolve()).catch(() => {}).then(() => enforceNow(human, now));
  running.set(key, run);
  void run.finally(() => running.get(key) === run && running.delete(key)).catch(() => {});
  return run;
}

async function enforceNow(human: string, now: number) {
  const want = standingOf(human, now);
  const had = appliedStanding(human);
  const next: Record_ = { ...had };
  const c = await chain();

  // ---- Arc
  const arcHad = had.arc ?? { status: "good" as Standing, at: 0 };
  const arcWant = want.arc.status;
  if (arcWant !== arcHad.status || arcHad.chainError) {
    const applied: Applied = { status: arcWant, at: now, penalized: arcHad.penalized };
    try {
      if (arcWant === "delinquent") applied.chainTx = await c.arc.suspend(human);
      else if (arcWant === "defaulted") applied.chainTx = await c.arc.markDefault(human);
      else if (arcHad.status !== "good") applied.chainTx = await c.arc.activate(human);
    } catch (err: any) {
      applied.chainError = err?.shortMessage ?? err?.message ?? String(err);
    }
    if (arcWant === "defaulted" && !arcHad.penalized) {
      penalizeDefault(human, "arc");
      applied.penalized = true;
      await c.onPenalty?.(human, "arc")?.catch?.(() => {});
    }
    if (arcWant === "good") applied.penalized = false;
    next.arc = applied;
  }

  // The agents that owe overdue debt are delinquent; once it is paid, they are not.
  const overdueAgents = new Set(
    getActiveLoansByHuman(human)
      .filter((l) => l.dueAt && l.dueAt < now)
      .map((l) => l.agentAddress.toLowerCase())
  );
  for (const a of getAgentsByOwner(human)) {
    if ((a.rail ?? "arc") !== "arc") continue;
    const late = overdueAgents.has(a.address.toLowerCase());
    if (late && a.status !== "Delinquent") updateAgentInStore(a.address, { status: "Delinquent" });
    if (!late && a.status === "Delinquent") updateAgentInStore(a.address, { status: a.outstandingDebt > 0 ? "Active" : "Healthy" });
  }

  // ---- Sui (the chain records obligation defaults itself; the profile follows)
  const suiHad = had.sui ?? { status: "good" as Standing, at: 0 };
  const suiWant = want.sui.status;
  if (suiWant !== suiHad.status || suiHad.chainError) {
    const applied: Applied = { status: suiWant, at: now, penalized: suiHad.penalized };
    try {
      applied.chainTx = await c.sui.setStatus(human, suiWant === "defaulted" ? "defaulted" : "active");
    } catch (err: any) {
      applied.chainError = err?.message ?? String(err);
    }
    if (suiWant === "defaulted" && !suiHad.penalized) {
      penalizeDefault(human, "sui");
      applied.penalized = true;
    }
    if (suiWant === "good") applied.penalized = false;
    next.sui = applied;
  }

  if (next.arc !== had.arc || next.sui !== had.sui) save(human, next);
  return { ...want, applied: next };
}

/** A line that may not borrow right now, and why - or null. */
export function borrowingBlocked(human: string, rail: "arc" | "sui", now = Date.now()): string | null {
  const s = rail === "arc" ? arcStanding(human, now) : suiStanding(human);
  if (s.status === "good") return null;
  const what = rail === "arc" ? "Arc" : "Sui";
  return s.status === "defaulted"
    ? `Your ${what} line is in default: $${s.overdueUsd.toFixed(2)} is unpaid. Repay it to borrow again.`
    : `Your ${what} line is suspended: $${s.overdueUsd.toFixed(2)} is past due. Repay it to borrow again.`;
}
