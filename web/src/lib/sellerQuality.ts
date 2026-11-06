import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * Did the seller deliver what it charged for?
 *
 * The marketplace lists a seller's price and uptime, not whether its answers are
 * any good. Lifeline sees every purchase, so it can keep the record nobody else
 * has: paid for, delivered or not, and whether what came back matched the format
 * the seller published. Agents are steered by it, and past a certain point
 * Lifeline will not lend to buy from that seller.
 */
export type SellerRecord = {
  delivered: number;
  failed: number;
  /** Delivered, but not in the format the seller's listing promised. */
  malformed: number;
  lastAt: number;
};

/** Below this many purchases a seller has no meaningful record either way. */
export const MIN_SAMPLES = 5;
/** A seller with a record worse than this is not lent against. */
export const POOR_SCORE = 0.5;

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "seller-quality.json"),
    path.resolve(process.cwd(), "data", "seller-quality.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}

function readAll(): Record<string, SellerRecord> {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
}

export const sellerKey = (seller: string) => seller.toLowerCase();

export function recordSellerOutcome(seller: string, outcome: "delivered" | "failed" | "malformed", now = Date.now()) {
  const all = readAll();
  const key = sellerKey(seller);
  const r = all[key] ?? { delivered: 0, failed: 0, malformed: 0, lastAt: 0 };
  r[outcome] += 1;
  r.lastAt = now;
  all[key] = r;
  writeJsonAtomic(file(), all);
  return r;
}

export const sellerRecord = (seller: string): SellerRecord | null => readAll()[sellerKey(seller)] ?? null;

/**
 * Share of purchases that delivered, pulled toward even odds while the record is
 * short: one bad purchase should not condemn a seller, nor one good one clear it.
 */
export function sellerScore(seller: string): { score: number; samples: number } {
  const r = sellerRecord(seller);
  const samples = r ? r.delivered + r.failed + r.malformed : 0;
  return { score: ((r?.delivered ?? 0) + 1) / (samples + 2), samples };
}

export function sellerIsPoor(seller: string): boolean {
  const { score, samples } = sellerScore(seller);
  return samples >= MIN_SAMPLES && score < POOR_SCORE;
}

/**
 * Does a response match the listing's output schema? Only the parts that catch a
 * seller sending the wrong thing: type and required keys, nested. A schema it
 * cannot read counts as a match, because a seller must not lose its record over
 * a limit of this check.
 */
export function matchesSchema(schema: unknown, value: unknown, depth = 0): boolean {
  if (!schema || typeof schema !== "object" || depth > 8) return true;
  const s = schema as { type?: unknown; required?: unknown; properties?: unknown; items?: unknown };
  if (typeof s.type === "string" && !matchesType(s.type, value)) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required) && s.required.some((k) => typeof k === "string" && !(k in obj))) return false;
    if (s.properties && typeof s.properties === "object") {
      for (const [k, sub] of Object.entries(s.properties as Record<string, unknown>)) {
        if (k in obj && !matchesSchema(sub, obj[k], depth + 1)) return false;
      }
    }
  }
  if (Array.isArray(value) && s.items) return value.every((v) => matchesSchema(s.items, v, depth + 1));
  return true;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}
