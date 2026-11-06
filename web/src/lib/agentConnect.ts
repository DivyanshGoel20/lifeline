import fs from "./storeFs";
import path from "path";
import crypto from "crypto";
import { writeJsonAtomic } from "./atomicWrite";
import type { Rail } from "@/types";
import type { ProvisionedAgent } from "./provisionAgent";

/**
 * An agent asking a human for a line of its own.
 *
 * An agent that has nothing - no wallet, no token, no account - asks here. It
 * gets a short code and a link for its human, and a secret only it holds.
 * The human opens the link signed in with World ID, sees who is asking and
 * for what, and approves or declines. Approval makes the agent a wallet,
 * authorises it on the human's line and binds a mandate to it; the agent,
 * polling with its secret, collects that mandate once. The code alone gets
 * nobody anything, and nothing is issued without the human saying yes.
 */
export type ConnectRequest = {
  code: string;
  secretHash: string;
  name: string;
  rail: Rail;
  capUsd?: number;
  reason?: string;
  client?: string;
  status: "pending" | "approving" | "approved" | "denied" | "collected";
  human?: string;
  /** Held only until the agent collects it, then wiped. */
  issued?: ProvisionedAgent;
  agentAddress?: string;
  createdAt: number;
  expiresAt: number;
};

export const CONNECT_TTL_MS = 15 * 60 * 1000;
// No 0/O/1/I: read off a screen and typed without a second guess.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "agent-connects.json"),
    path.resolve(process.cwd(), "data", "agent-connects.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
const read = (): ConnectRequest[] => {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : [];
  } catch {
    return [];
  }
};
const write = (all: ConnectRequest[]) => writeJsonAtomic(file(), all.filter((c) => c.expiresAt > Date.now()));
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const norm = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function newCode(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
export const displayCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function startConnect(req: {
  name: string;
  rail: Rail;
  capUsd?: number;
  reason?: string;
  client?: string;
}): { code: string; secret: string; expiresAt: number } {
  const code = newCode();
  const secret = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + CONNECT_TTL_MS;
  write([...read(), { ...req, code, secretHash: hash(secret), status: "pending", createdAt: Date.now(), expiresAt }]);
  return { code, secret, expiresAt };
}

export function getConnect(code: string): ConnectRequest | null {
  const c = read().find((x) => x.code === norm(code));
  return c && c.expiresAt > Date.now() ? c : null;
}

/** Take the request for approval, so two clicks cannot mint two agents. */
export function claimForApproval(code: string, human: string): ConnectRequest | null {
  const all = read();
  const c = all.find((x) => x.code === norm(code) && x.expiresAt > Date.now());
  if (!c || c.status !== "pending") return null;
  c.status = "approving";
  c.human = human;
  write(all);
  return c;
}

export function finishApproval(code: string, issued: ProvisionedAgent | null) {
  const all = read();
  const c = all.find((x) => x.code === norm(code));
  if (!c) return;
  if (issued) {
    c.status = "approved";
    c.issued = issued;
    c.agentAddress = issued.agent.address;
    // Time for the agent's next poll to collect it.
    c.expiresAt = Date.now() + CONNECT_TTL_MS;
  } else {
    c.status = "pending";
    delete c.human;
  }
  write(all);
}

export function denyConnect(code: string, human: string): boolean {
  const all = read();
  const c = all.find((x) => x.code === norm(code) && x.expiresAt > Date.now());
  if (!c || c.status !== "pending") return false;
  c.status = "denied";
  c.human = human;
  write(all);
  return true;
}

/** For the agent holding the secret: where its request stands, and the mandate once. */
export function pollConnect(
  code: string,
  secret: string
):
  | { status: "unknown" }
  | { status: "pending" | "approving" | "denied" | "collected"; expiresAt: number }
  | { status: "approved"; issued: ProvisionedAgent } {
  const all = read();
  const c = all.find((x) => x.code === norm(code));
  if (!c || c.expiresAt <= Date.now() || c.secretHash !== hash(secret)) return { status: "unknown" };
  if (c.status !== "approved" || !c.issued) return { status: c.status as any, expiresAt: c.expiresAt };
  const issued = c.issued;
  c.status = "collected";
  delete c.issued;
  write(all);
  return { status: "approved", issued };
}
