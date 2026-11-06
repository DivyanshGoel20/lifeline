import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";
import { deployment } from "@lifeline/sui";

/**
 * Debt drawn on Sui, counted against the same line as Arc.
 *
 * Arc's facility is the ledger of record for what a human may borrow, but
 * headroom there is computed from Arc agents only - so a Sui drawdown would be
 * invisible to it, and a human could exhaust the line on Arc and borrow the
 * same money again on Sui. This is the missing column. It is not a second
 * ledger: rows here are counted against the one limit, and they close when the
 * obligation that collects them does.
 *
 * One obligation is a tranche and can back several draws, so several rows can
 * point at the same obligation and close together.
 */
export interface RailDebt {
  id: string;
  humanOwner: string;
  rail: "sui";
  agentAddress: string;
  amountUsd: number;
  /** The parked repayment that collects this debt. */
  obligationId: string;
  /**
   * The Sui facility it was drawn from. An obligation only exists on the
   * network it was parked on, so a debt from another deployment - a localnet
   * that has since been wiped, a devnet that was reset - is not something this
   * one can collect or count.
   */
  facilityId?: string;
  resource: string;
  digest?: string;
  createdAt: number;
  /**
   * open      - parked, not yet collected
   * settled   - collected, headroom returned
   * defaulted - fell due and the purse could not cover it; still owed and
   *             still consuming the line. A default must never be cheaper than
   *             repaying.
   */
  status: "open" | "settled" | "defaulted";
  settledAt?: number;
  defaultedAt?: number;
  defaultReason?: string;
}

function filePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "rail-debt.json"),
    path.resolve(process.cwd(), "data", "rail-debt.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.resolve(process.cwd(), "data", "rail-debt.json");
}

/** Every row, from every deployment - only what writes back needs this. */
function readEverything(): RailDebt[] {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const current = () => deployment()?.facilityId ?? null;

/** The rows this deployment can see: drawn from the facility it points at. */
function readAll(): RailDebt[] {
  const facility = current();
  return readEverything().filter((r) => !!facility && r.facilityId === facility);
}

/**
 * Writes rows back without losing the other deployments' rows. Rows are
 * mutated in place by the callers, so `rows` is the current deployment's
 * slice with its changes.
 */
function writeAll(rows: RailDebt[]) {
  const facility = current();
  const others = readEverything().filter((r) => r.facilityId !== facility);
  writeJsonAtomic(filePath(), [...others, ...rows]);
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function openRailDebt(entry: Omit<RailDebt, "id" | "createdAt" | "status">): RailDebt {
  const row: RailDebt = {
    ...entry,
    facilityId: entry.facilityId ?? current() ?? undefined,
    id: `rd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    status: "open",
  };
  const all = readAll();
  all.push(row);
  writeAll(all);
  return row;
}

/** What this human owes on Sui, counted against the one limit. */
export function railDebtTotal(humanOwner: string): number {
  if (!humanOwner) return 0;
  // Defaulted debt still counts: freeing the headroom would make failing to
  // pay the cheapest way to borrow again.
  const total = readAll()
    .filter((r) => (r.status === "open" || r.status === "defaulted") && same(r.humanOwner, humanOwner))
    .reduce((n, r) => n + r.amountUsd, 0);
  return Math.round(total * 10000) / 10000;
}

/** Everything still owed on Sui, open or defaulted, for one human. */
export function unpaidRailDebts(humanOwner: string): RailDebt[] {
  return readAll().filter(
    (r) => (r.status === "open" || r.status === "defaulted") && same(r.humanOwner, humanOwner)
  );
}

/** Every row behind one obligation, whatever its status. */
export function railDebtsForObligation(obligationId: string): RailDebt[] {
  return readAll().filter((r) => r.obligationId === obligationId);
}

/** The unpaid rows behind one obligation, whoever's they are. */
export function unpaidRowsOf(obligationId: string): RailDebt[] {
  return readAll().filter((r) => r.obligationId === obligationId && (r.status === "open" || r.status === "defaulted"));
}

export function railDebtsFor(humanOwner: string): RailDebt[] {
  return readAll().filter((r) => same(r.humanOwner, humanOwner));
}

/** The obligation collected, so every draw it covered is paid. */
export function settleObligation(obligationId: string): RailDebt[] {
  const all = readAll();
  const rows = all.filter((r) => r.obligationId === obligationId && r.status !== "settled");
  for (const r of rows) {
    r.status = "settled";
    r.settledAt = Date.now();
  }
  if (rows.length) writeAll(all);
  return rows;
}

/** The obligation fell due and collected nothing. The debt stands. */
export function defaultObligation(obligationId: string, reason: string): RailDebt[] {
  const all = readAll();
  const rows = all.filter((r) => r.obligationId === obligationId && r.status === "open");
  for (const r of rows) {
    r.status = "defaulted";
    r.defaultedAt = Date.now();
    r.defaultReason = reason;
  }
  if (rows.length) writeAll(all);
  return rows;
}

/** Obligations with unpaid debt behind them, for reconciliation. */
export function unpaidObligations(humanOwner?: string): string[] {
  return [
    ...new Set(
      readAll()
        .filter(
          (r) =>
            (r.status === "open" || r.status === "defaulted") &&
            (!humanOwner || same(r.humanOwner, humanOwner))
        )
        .map((r) => r.obligationId)
    ),
  ];
}
