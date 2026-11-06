import fs from "./storeFs";
import path from "path";
import crypto from "crypto";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * Signing a browser in from World App.
 *
 * For a browser that has never signed in, or has forgotten who it was, while
 * its human has already joined - so World ID's one-time proof is spent. The
 * browser shows a code; World App, signed in with the human's linked wallet,
 * approves it; the browser, holding a secret only it was given, collects the
 * session. The code alone signs nobody in.
 */
type Pairing = { code: string; claimHash: string; human: string | null; expiresAt: number; collected: boolean };

const TTL_MS = 10 * 60 * 1000;

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "pairings.json"),
    path.resolve(process.cwd(), "data", "pairings.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
const read = (): Pairing[] => {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : [];
  } catch {
    return [];
  }
};
const write = (all: Pairing[]) => writeJsonAtomic(file(), all.filter((p) => p.expiresAt > Date.now()));
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// However many are asked for, the file stays small.
const MAX_OPEN = 500;

export function startPairing(): { code: string; claim: string; expiresAt: number } | null {
  const open = read().filter((p) => p.expiresAt > Date.now());
  if (open.length >= MAX_OPEN) return null;
  // Short enough to read off a screen, long enough not to be guessed in five minutes.
  const code = crypto.randomBytes(5).toString("hex").toUpperCase();
  const claim = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + TTL_MS;
  write([...open, { code, claimHash: hash(claim), human: null, expiresAt, collected: false }]);
  return { code, claim, expiresAt };
}

export function approvePairing(code: string, human: string): boolean {
  const all = read();
  const p = all.find((x) => x.code === code.toUpperCase() && x.expiresAt > Date.now() && !x.human);
  if (!p) return false;
  p.human = human;
  write(all);
  return true;
}

/** The human, once approved, to the browser holding the claim - once. */
export function collectPairing(code: string, claim: string): { status: "pending" | "expired" } | { status: "approved"; human: string } {
  const all = read();
  const p = all.find((x) => x.code === code.toUpperCase());
  if (!p || p.expiresAt <= Date.now() || p.collected || p.claimHash !== hash(claim)) return { status: "expired" };
  if (!p.human) return { status: "pending" };
  p.collected = true;
  write(all);
  return { status: "approved", human: p.human };
}

/** Whether a code is still waiting for someone to approve it. */
export function isWaiting(code: string): boolean {
  const p = read().find((x) => x.code === code.toUpperCase());
  return !!p && p.expiresAt > Date.now() && !p.human && !p.collected;
}

/**
 * The one code a browser started in the last `withinMs`, if exactly one.
 *
 * World App sometimes opens the mini app at the path it was opened with last
 * time, not the one just scanned, so the code in the URL is stale. The code
 * on the human's screen is then almost always the newest one waiting; it is
 * offered for them to match against their screen - and not at all when more
 * than one is waiting, rather than guess.
 */
export function newestWaiting(withinMs = 5 * 60 * 1000): string | null {
  // Started within the window: expiresAt is start + TTL_MS.
  const recent = read().filter((p) => !p.human && !p.collected && p.expiresAt > Date.now() && p.expiresAt - TTL_MS > Date.now() - withinMs);
  return recent.length === 1 ? recent[0].code : null;
}
