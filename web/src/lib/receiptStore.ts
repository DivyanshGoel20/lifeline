import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * Transfers that have already been counted as a repayment.
 *
 * A browser repayment is proved by a transaction hash, and verifying the hash
 * says the transfer happened - not that it has not been used before. Without
 * this, one real ten-cent transfer could be posted again and again, clearing a
 * little more debt each time.
 */
function filePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "repayment-receipts.json"),
    path.resolve(process.cwd(), "data", "repayment-receipts.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.resolve(process.cwd(), "data", "repayment-receipts.json");
}

function readAll(): Record<string, { humanOwner: string; usedAt: number }> {
  try {
    const p = filePath();
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
}

/** True the first time a receipt is presented, false every time after. */
export function claimReceipt(txHash: string, humanOwner: string): boolean {
  const key = txHash.toLowerCase();
  const all = readAll();
  if (all[key]) return false;
  all[key] = { humanOwner, usedAt: Date.now() };
  writeJsonAtomic(filePath(), all);
  return true;
}

/** Put a receipt back when the repayment it was claimed for did not go through. */
export function releaseReceipt(txHash: string): void {
  const all = readAll();
  delete all[txHash.toLowerCase()];
  writeJsonAtomic(filePath(), all);
}
