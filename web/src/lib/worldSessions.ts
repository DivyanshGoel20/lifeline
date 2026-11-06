import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * World ID sessions: how a human who has already joined signs in again.
 *
 * A World ID 4 uniqueness proof can be made once per person per action - that
 * is what makes it proof of one human, and why asking for it at every sign-in
 * locked out anyone whose cookie had expired. So it is asked for once, to
 * join. In the same sitting a World ID session is created and bound to that
 * human; every later sign-in proves that session instead, as often as needed.
 *
 *   session_id         bound to one human, for good; never silently replaced
 *   session nullifier  per proof; each is accepted once, so a proof cannot be
 *                      replayed
 */
type Store = {
  byHuman: Record<string, { sessionId: string; createdAt: number }>;
  bySession: Record<string, string>;
  usedNullifiers: string[];
};

function filePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "world-sessions.json"),
    path.resolve(process.cwd(), "data", "world-sessions.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}

function read(): Store {
  try {
    const p = filePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* start empty */
  }
  return { byHuman: {}, bySession: {}, usedNullifiers: [] };
}

const key = (human: string) => human.toLowerCase();

export const sessionForHuman = (human: string): string | null => read().byHuman[key(human)]?.sessionId ?? null;

export const humanForSession = (sessionId: string): string | null => read().bySession[sessionId] ?? null;

export function bindSession(human: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
  const s = read();
  const mine = s.byHuman[key(human)];
  if (mine && mine.sessionId !== sessionId) {
    return { ok: false, reason: "This account already has a World ID session. Sign in with it." };
  }
  const owner = s.bySession[sessionId];
  if (owner && key(owner) !== key(human)) {
    return { ok: false, reason: "That World ID session belongs to another account." };
  }
  s.byHuman[key(human)] = { sessionId, createdAt: mine?.createdAt ?? Date.now() };
  s.bySession[sessionId] = human;
  writeJsonAtomic(filePath(), s);
  return { ok: true };
}

/** False if this proof's nullifier was accepted before. Records it otherwise. */
export function spendNullifier(nullifier: string): boolean {
  const s = read();
  const n = nullifier.toLowerCase();
  if (s.usedNullifiers.includes(n)) return false;
  s.usedNullifiers.push(n);
  writeJsonAtomic(filePath(), s);
  return true;
}
