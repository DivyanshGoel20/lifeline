import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * What each human's deposit last read as on chain.
 *
 * Credit checks run on every payment, so they read this copy, not the chain. It
 * only ever trails in the safe direction: a withdrawal request stops backing
 * credit as soon as it is synced, and the contract refuses any withdrawal that
 * would leave the debt uncovered, whatever this file says.
 */
export type CollateralRecord = { assetsUsd: number; creditUsd: number; syncedAt: number };

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "collateral.json"),
    path.resolve(process.cwd(), "data", "collateral.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}

function readAll(): Record<string, CollateralRecord> {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
}

export const collateralRecord = (human: string): CollateralRecord | null => readAll()[human.toLowerCase()] ?? null;

/** How much credit this human's deposit backs, on top of their earned tier. */
export const collateralCreditUsd = (human: string): number => collateralRecord(human)?.creditUsd ?? 0;

export function saveCollateral(human: string, record: CollateralRecord) {
  const all = readAll();
  all[human.toLowerCase()] = record;
  writeJsonAtomic(file(), all);
}
