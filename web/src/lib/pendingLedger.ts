import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * Nanopayments waiting to be written to the facility.
 *
 * An x402 charge is a cent. Recording it on chain costs more than a cent in
 * gas, so recording each one individually means the ledger costs more than the
 * payments it is tracking. Payments accumulate here and settle as one drawdown
 * row carrying a payment count.
 *
 * Two properties this file has to hold:
 *
 * Durability. A payment has already left Lifeline's Gateway balance by the time it
 * lands here, so losing an entry means losing the debt. Entries are persisted
 * before the payment is reported as successful, never after.
 *
 * Exactly-once flushing. An entry is claimed before the chain write is awaited,
 * so a crash mid-flush leaves it claimed rather than unflushed - visible to be
 * reconciled, rather than silently booked twice.
 */
export interface PendingDrawdown {
  id: string;
  humanOwner: string;
  agentAddress: string;
  amountUsdc: number;
  reference: string;
  /** The loan booked for this payment, stamped with a tx once its batch lands. */
  loanId?: string;
  createdAt: number;
  /** Set when a flush has claimed this entry and not yet confirmed. */
  claimedAt?: number;
  claimBatch?: string;
}

/** Flush once the unwritten position is worth more than the gas to write it. */
export const FLUSH_AT_USD = 1.0;
/** Or once the oldest entry has been waiting this long, so debt cannot linger. */
export const FLUSH_AFTER_MS = 5 * 60_000;

function filePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "pending-ledger.json"),
    path.resolve(process.cwd(), "data", "pending-ledger.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.resolve(process.cwd(), "data", "pending-ledger.json");
}

function readAll(): PendingDrawdown[] {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: PendingDrawdown[]): void {
  writeJsonAtomic(filePath(), entries);
}

export function addPending(
  entry: Omit<PendingDrawdown, "id" | "createdAt">
): PendingDrawdown {
  const record: PendingDrawdown = {
    ...entry,
    id: `pd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  const all = readAll();
  all.push(record);
  writeAll(all);
  return record;
}

export function getPending(humanOwner?: string): PendingDrawdown[] {
  const all = readAll();
  if (!humanOwner) return all;
  return all.filter((e) => e.humanOwner.toLowerCase() === humanOwner.toLowerCase());
}

/**
 * Debt that exists but is not on chain yet.
 *
 * Admission control has to count this. The contract only refuses a drawdown
 * that breaches the limit against the debt it can see, and between flushes it
 * cannot see any of this - so without adding it in, an agent could spend past
 * its line in the gap.
 */
export function pendingTotal(humanOwner: string, agentAddress?: string): number {
  return getPending(humanOwner)
    .filter((e) => !agentAddress || e.agentAddress.toLowerCase() === agentAddress.toLowerCase())
    .reduce((n, e) => n + e.amountUsdc, 0);
}

export function shouldFlush(humanOwner: string, agentAddress: string): boolean {
  const mine = getPending(humanOwner).filter(
    (e) => e.agentAddress.toLowerCase() === agentAddress.toLowerCase() && !e.claimedAt
  );
  if (mine.length === 0) return false;

  const total = mine.reduce((n, e) => n + e.amountUsdc, 0);
  if (total >= FLUSH_AT_USD) return true;

  const oldest = Math.min(...mine.map((e) => e.createdAt));
  return Date.now() - oldest >= FLUSH_AFTER_MS;
}

/** Claims every unclaimed entry for this agent. Returns them and the batch id. */
export function claimForFlush(
  humanOwner: string,
  agentAddress: string
): { batchId: string; entries: PendingDrawdown[] } {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const all = readAll();
  const claimed: PendingDrawdown[] = [];

  for (const e of all) {
    if (
      e.humanOwner.toLowerCase() === humanOwner.toLowerCase() &&
      e.agentAddress.toLowerCase() === agentAddress.toLowerCase() &&
      !e.claimedAt
    ) {
      e.claimedAt = Date.now();
      e.claimBatch = batchId;
      claimed.push(e);
    }
  }

  if (claimed.length > 0) writeAll(all);
  return { batchId, entries: claimed };
}

/** The write landed: the entries are on chain and can go. */
export function dropBatch(batchId: string): void {
  writeAll(readAll().filter((e) => e.claimBatch !== batchId));
}

/** The write failed: un-claim so the next flush picks them up again. */
export function releaseBatch(batchId: string): void {
  const all = readAll();
  for (const e of all) {
    if (e.claimBatch === batchId) {
      delete e.claimedAt;
      delete e.claimBatch;
    }
  }
  writeAll(all);
}
