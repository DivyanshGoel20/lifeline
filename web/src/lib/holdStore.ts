import fs from "./storeFs";
import path from "path";
import crypto from "crypto";
import { writeJsonAtomic } from "./atomicWrite";
import type { Verdict } from "./intercepta";

/**
 * Payments Intercepta's verdict sent to a human.
 *
 * A held payment is the request the agent made, kept until its owner approves
 * or declines it. Approving does not replay an old verdict: the payment is
 * screened again, and a refusal still refuses. Only a hold can be waved
 * through.
 */
export interface HeldPayment {
  holdId: string;
  human: string;
  agentAddress: string;
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  payTo: string;
  amountUsd: number;
  verdict: Verdict;
  /** Which rail the payment was on. Missing means Arc. */
  rail?: "arc" | "sui";
  status: "held" | "approved" | "declined";
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
}

const TTL_MS = 30 * 60 * 1000;

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "holds.json"),
    path.resolve(process.cwd(), "data", "holds.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data"))
    ? candidates[0]
    : candidates[1];
}

function readAll(): HeldPayment[] {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : [];
  } catch {
    return [];
  }
}

export function createHold(h: Omit<HeldPayment, "holdId" | "status" | "createdAt" | "expiresAt">): HeldPayment {
  const hold: HeldPayment = {
    ...h,
    holdId: `hold_${crypto.randomBytes(8).toString("hex")}`,
    status: "held",
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  };
  writeJsonAtomic(file(), [hold, ...readAll()]);
  return hold;
}

export const getHold = (holdId: string) => readAll().find((h) => h.holdId === holdId) ?? null;

/** Open holds for one human, newest first. Expired ones are not offered. */
export const openHolds = (human: string) =>
  readAll().filter(
    (h) => h.status === "held" && h.expiresAt > Date.now() && h.human.toLowerCase() === human.toLowerCase()
  );

export function resolveHold(holdId: string, status: "approved" | "declined" | "held"): HeldPayment | null {
  const all = readAll();
  const hold = all.find((h) => h.holdId === holdId);
  if (!hold) return null;
  hold.status = status;
  hold.resolvedAt = Date.now();
  writeJsonAtomic(file(), all);
  return hold;
}
