import fs from "./storeFs";
import path from "path";
import crypto from "crypto";
import { writeJsonAtomic } from "./atomicWrite";
import { humanForSubject } from "./worldAgents";
import { standingOf, type Standing } from "./standing";
import { getHumanCreditTier } from "./reputationStore";

/**
 * Lifeline as a registry other World apps can ask: does this human repay?
 *
 * World gives every app its own private identifier for a person, so apps
 * cannot link people behind their backs. The owner of a relationship may
 * name other apps to share its identifier, by publishing an authorization
 * document listing their exact callback URLs (the sector identifier). Lifeline
 * owns the relationship its humans link with World ID for Agents; a partner
 * app listed in Lifeline's document gets the same identifier - the `sub` -
 * when that human signs in to it with World, and can ask Lifeline how they
 * stand.
 *
 * The answer is how they stand now - good, delinquent or defaulted - and their
 * tier. Never amounts, never history. Only partners Lifeline has listed can
 * ask, with their own key, and every lookup is shown to the human it was about.
 */

export type Partner = { id: string; name: string; callbackUrl: string; keyHash: string; addedAt?: number };

function dataFile(name: string): string {
  const candidates = [path.resolve(process.cwd(), "web", "data", name), path.resolve(process.cwd(), "data", name)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
const readJson = <T>(name: string, fallback: T): T => {
  try {
    const f = dataFile(name);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

export const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

/** Partners from LIFELINE_REGISTRY_PARTNERS (a JSON array) and data/registry-partners.json. */
export function partners(): Partner[] {
  let fromEnv: Partner[] = [];
  try {
    fromEnv = process.env.LIFELINE_REGISTRY_PARTNERS ? JSON.parse(process.env.LIFELINE_REGISTRY_PARTNERS) : [];
  } catch {
    console.warn("[registry] LIFELINE_REGISTRY_PARTNERS is not valid JSON; ignoring it");
  }
  const fromFile = readJson<Partner[]>("registry-partners.json", []);
  const byId = new Map<string, Partner>();
  for (const p of [...fromFile, ...fromEnv]) if (p?.id && p.keyHash && p.callbackUrl) byId.set(p.id, p);
  return [...byId.values()];
}

/** Add a partner (operator tooling). Returns its key - shown once, stored only as a hash. */
export function addPartner(p: { id: string; name: string; callbackUrl: string }): { partner: Partner; key: string } {
  const u = new URL(p.callbackUrl);
  if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("A partner's callback must be https");
  const key = `llp_${crypto.randomBytes(24).toString("base64url")}`;
  const partner: Partner = { id: p.id, name: p.name, callbackUrl: u.toString(), keyHash: hashKey(key), addedAt: Date.now() };
  const all = readJson<Partner[]>("registry-partners.json", []).filter((x) => x.id !== p.id);
  writeJsonAtomic(dataFile("registry-partners.json"), [...all, partner]);
  return { partner, key };
}

export function partnerForKey(key: string | null | undefined): Partner | null {
  if (!key) return null;
  const h = Buffer.from(hashKey(key));
  return (
    partners().find((p) => {
      const mine = Buffer.from(p.keyHash);
      return mine.length === h.length && crypto.timingSafeEqual(mine, h);
    }) ?? null
  );
}

const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || process.env.LIFELINE_APP_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * The authorization (sector identifier) document: every callback URL that may
 * share Lifeline's relationship identifier - Lifeline's own, then each partner's.
 */
export function sectorDocument(): string[] {
  return [`${appUrl()}/api/auth/world-agents/callback`, ...partners().map((p) => p.callbackUrl)];
}

export type RegistryAnswer =
  | { found: false; sub: string; checkedAt: string }
  | {
      found: true;
      sub: string;
      standing: { arc: Standing; sui: Standing };
      /** The worse of the two lines. */
      overall: Standing;
      tier: { arc: number; sui: number };
      memberSince: string;
      checkedAt: string;
    };

const rank: Record<Standing, number> = { good: 0, delinquent: 1, defaulted: 2 };

/** How the human behind this World identifier stands. Recorded for them to see. */
export function lookup(partner: Partner, sub: string): RegistryAnswer {
  const checkedAt = new Date().toISOString();
  const who = humanForSubject(sub);
  if (!who) {
    return { found: false, sub, checkedAt };
  }
  const s = standingOf(who.human);
  const overall = rank[s.arc.status] >= rank[s.sui.status] ? s.arc.status : s.sui.status;
  recordLookup(who.human, partner, overall);
  return {
    found: true,
    sub,
    standing: { arc: s.arc.status, sui: s.sui.status },
    overall,
    tier: { arc: getHumanCreditTier(who.human, "arc").tierNumber, sui: getHumanCreditTier(who.human, "sui").tierNumber },
    memberSince: new Date(who.linkedAt).toISOString(),
    checkedAt,
  };
}

/* ---- who looked, shown to the human ----------------------------------- */

export type Lookup = { partnerId: string; partnerName: string; answered: Standing; at: number };
const LOOKUPS = "registry-lookups.json";

function recordLookup(human: string, partner: Partner, answered: Standing) {
  const all = readJson<Record<string, Lookup[]>>(LOOKUPS, {});
  const k = human.toLowerCase();
  all[k] = [{ partnerId: partner.id, partnerName: partner.name, answered, at: Date.now() }, ...(all[k] ?? [])].slice(0, 50);
  writeJsonAtomic(dataFile(LOOKUPS), all);
}

export const lookupsFor = (human: string): Lookup[] => readJson<Record<string, Lookup[]>>(LOOKUPS, {})[human.toLowerCase()] ?? [];
