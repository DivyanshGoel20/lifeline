import fs from "./storeFs";
import path from "path";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * World ID for Agents: a human's fresh "yes" before an agent's action runs.
 *
 * World's Human Continuity IdP speaks OpenID Connect. Lifeline uses its
 * device authorization grant - the flow World documents for headless agents -
 * so the same approval works when an agent asks through the API, and when the
 * human is on the dashboard or inside World App: the request shows a code and
 * a link, the human proves themselves in the World ID app and approves, and
 * Lifeline's backend collects a signed ID token. Every device approval needs a
 * fresh World proof; there is no session to reuse.
 *
 * The token is only believed after validation here: RS256 signature against
 * the IdP's published keys, exact issuer, our client as audience, expiry, the
 * Orb authentication class, and an `auth_time` from after the request began.
 * Its pairwise `sub` is then bound, once, to the Lifeline human who linked it
 * while signed in; afterwards only that same `sub` can approve for them.
 *
 * Denied, expired, the wrong person, a stale authentication, or the IdP being
 * down: the protected action does not run.
 */

export const ORB_ACR = "https://world.org/oidc/acr/orb-v3";
const DEVICE_TTL_MS = 20 * 60 * 1000;
// Clock tolerance when checking auth_time against when the request started.
const SKEW_MS = 30_000;

const issuer = () => (process.env.WORLD_AGENTS_ISSUER || "https://sandbox.auth.world.org").replace(/\/$/, "");
export const agentsConfigured = () => Boolean(process.env.WORLD_AGENTS_CLIENT_ID && process.env.WORLD_AGENTS_CLIENT_SECRET);

type Endpoints = { token: string; device: string; jwks: string };
let endpoints: Promise<Endpoints> | null = null;
function discover(): Promise<Endpoints> {
  endpoints ??= fetch(`${issuer()}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) })
    .then((r) => {
      if (!r.ok) throw new Error(`World ID discovery ${r.status}`);
      return r.json();
    })
    .then((d) => {
      if (d.issuer !== issuer()) throw new Error("World ID discovery names a different issuer");
      return { token: d.token_endpoint, device: d.device_authorization_endpoint, jwks: d.jwks_uri };
    })
    .catch((err) => {
      endpoints = null;
      throw err;
    });
  return endpoints;
}

let jwks: JWTVerifyGetKey | null = null;
/** Tests supply their own signing keys here. */
export const useKeys = (k: JWTVerifyGetKey | null) => (jwks = k);

function basicAuth(): string {
  const id = encodeURIComponent(process.env.WORLD_AGENTS_CLIENT_ID!);
  const secret = encodeURIComponent(process.env.WORLD_AGENTS_CLIENT_SECRET!);
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function post(url: string, form: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(), Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

export type Identity = { iss: string; sub: string; authTime: number; acr: string };

/** Everything World's guide asks of an ID token before it counts. */
export async function validateIdToken(idToken: string, freshSince: number): Promise<Identity> {
  if (!jwks) jwks = createRemoteJWKSet(new URL((await discover()).jwks));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: issuer(),
    audience: process.env.WORLD_AGENTS_CLIENT_ID!,
    algorithms: ["RS256"],
  });
  if (payload.acr !== ORB_ACR) throw new Error(`Unexpected authentication class ${String(payload.acr)}`);
  const authTime = Number(payload.auth_time) * 1000;
  if (!Number.isFinite(authTime)) throw new Error("The token has no authentication time");
  if (authTime < freshSince - SKEW_MS) throw new Error("The World ID confirmation is older than this request");
  if (authTime > Date.now() + SKEW_MS) throw new Error("The World ID confirmation is dated in the future");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("The token names nobody");
  return { iss: String(payload.iss), sub: payload.sub, authTime, acr: String(payload.acr) };
}

/* ---- the store --------------------------------------------------------- */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "mismatch" | "failed";

/** One device approval: to link World ID, or to release a held payment. */
export type Approval = {
  id: string; // "link:<human>" or "hold:<holdId>"
  human: string;
  purpose: { kind: "link" } | { kind: "release-hold"; holdId: string };
  deviceCode: string; // never leaves the server
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  startedAt: number;
  expiresAt: number;
  nextPollAt: number;
  status: ApprovalStatus;
  reason?: string;
  identity?: Identity;
  /** Set when the protected action is claimed and when it has run, so it never runs twice. */
  claimedAt?: number;
  completedAt?: number;
  result?: unknown;
};

type Store = {
  bindings: Record<string, { iss: string; sub: string; linkedAt: number }>;
  approvals: Record<string, Approval>;
};

function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "world-agents.json"),
    path.resolve(process.cwd(), "data", "world-agents.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
function read(): Store {
  try {
    if (fs.existsSync(file())) return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    /* start empty */
  }
  return { bindings: {}, approvals: {} };
}
const write = (s: Store) => writeJsonAtomic(file(), s);
const key = (h: string) => h.toLowerCase();

/* ---- linking ----------------------------------------------------------- */

export const boundIdentity = (human: string) => read().bindings[key(human)] ?? null;

/** The Lifeline human a World ID for Agents subject is linked to, if any. */
export function humanForSubject(sub: string): { human: string; iss: string; linkedAt: number } | null {
  const hit = Object.entries(read().bindings).find(([, b]) => b.sub === sub);
  return hit ? { human: hit[0], iss: hit[1].iss, linkedAt: hit[1].linkedAt } : null;
}

/**
 * Bind a World ID for Agents subject to the signed-in Lifeline human, once.
 * Never silently moved: not to a second human, not replaced by another subject.
 */
export function bindIdentity(human: string, id: Identity): { ok: true } | { ok: false; reason: string } {
  const s = read();
  const mine = s.bindings[key(human)];
  if (mine && (mine.iss !== id.iss || mine.sub !== id.sub)) {
    return { ok: false, reason: "This account is already linked to a different World ID." };
  }
  const other = Object.entries(s.bindings).find(([h, b]) => h !== key(human) && b.iss === id.iss && b.sub === id.sub);
  if (other) return { ok: false, reason: "That World ID is linked to another Lifeline account." };
  s.bindings[key(human)] = { iss: id.iss, sub: id.sub, linkedAt: mine?.linkedAt ?? Date.now() };
  write(s);
  return { ok: true };
}

/* ---- device approvals -------------------------------------------------- */

export const getApproval = (id: string) => read().approvals[id] ?? null;
export const publicView = (a: Approval) => ({
  status: a.status,
  reason: a.reason,
  userCode: a.status === "pending" ? a.userCode : undefined,
  verificationUri: a.status === "pending" ? a.verificationUri : undefined,
  verificationUriComplete: a.status === "pending" ? a.verificationUriComplete : undefined,
  expiresAt: a.expiresAt,
  interval: a.interval,
});

function save(a: Approval) {
  const s = read();
  s.approvals[a.id] = a;
  write(s);
}

/**
 * Ask World ID for the human's approval. An attempt still pending is reused
 * rather than stacking new codes on the human's phone.
 */
export async function startApproval(id: string, human: string, purpose: Approval["purpose"]): Promise<Approval> {
  const existing = getApproval(id);
  if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) return existing;

  const { device } = await discover();
  const res = await post(device, { scope: "openid" });
  if (res.status !== 200 || !res.body.device_code) {
    throw new Error(res.status === 429 ? "World ID is rate-limiting approvals; wait a minute." : `World ID refused the request (${res.body.error ?? res.status}).`);
  }
  const now = Date.now();
  const a: Approval = {
    id,
    human,
    purpose,
    deviceCode: res.body.device_code,
    userCode: res.body.user_code,
    verificationUri: res.body.verification_uri,
    verificationUriComplete: res.body.verification_uri_complete,
    interval: Number(res.body.interval) || 5,
    startedAt: now,
    expiresAt: now + Math.min(Number(res.body.expires_in) * 1000 || DEVICE_TTL_MS, DEVICE_TTL_MS),
    nextPollAt: now + (Number(res.body.interval) || 5) * 1000,
    status: "pending",
  };
  save(a);
  return a;
}

/**
 * One poll of the token endpoint, no faster than World asked. Returns the
 * attempt's state; `approved` carries the validated identity, already checked
 * against the human's linked World ID where one is required.
 */
export async function pollApproval(id: string): Promise<Approval | null> {
  const a = getApproval(id);
  if (!a || a.status !== "pending") return a;
  const now = Date.now();
  if (now > a.expiresAt) return finish(a, "expired", "The approval request expired before it was answered.");
  if (now < a.nextPollAt) return a;

  const { token } = await discover();
  let res;
  try {
    res = await post(token, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: a.deviceCode });
  } catch {
    a.nextPollAt = now + a.interval * 2000; // back off after a timeout
    save(a);
    return a;
  }

  if (res.status === 200 && res.body.id_token) {
    let identity: Identity;
    try {
      identity = await validateIdToken(res.body.id_token, a.startedAt);
    } catch (err: any) {
      return finish(a, "failed", `The World ID token did not validate: ${err?.message ?? err}`);
    }
    const bound = boundIdentity(a.human);
    if (a.purpose.kind === "link") {
      const linked = bindIdentity(a.human, identity);
      if (!linked.ok) return finish(a, "mismatch", linked.reason, identity);
    } else if (!bound || bound.iss !== identity.iss || bound.sub !== identity.sub) {
      return finish(a, "mismatch", "A different World ID approved this. Only the account's own World ID can.", identity);
    }
    return finish(a, "approved", undefined, identity);
  }

  switch (res.body.error) {
    case "authorization_pending":
      a.nextPollAt = now + a.interval * 1000;
      save(a);
      return a;
    case "slow_down":
      a.interval += 5;
      a.nextPollAt = now + a.interval * 1000;
      save(a);
      return a;
    case "access_denied":
      return finish(a, "denied", "Declined in World ID.");
    case "expired_token":
      return finish(a, "expired", "The approval request expired before it was answered.");
    default:
      return finish(
        a,
        "failed",
        res.status === 503 ? "World ID is unavailable right now." : `World ID answered ${res.body.error ?? res.status}.`
      );
  }
}

function finish(a: Approval, status: ApprovalStatus, reason?: string, identity?: Identity): Approval {
  a.status = status;
  a.reason = reason;
  if (identity) a.identity = identity;
  save(a);
  return a;
}

/** Record that the protected action ran, and what came of it. */
export function markCompleted(id: string, result: unknown) {
  const a = getApproval(id);
  if (!a) return;
  a.completedAt = Date.now();
  a.result = result;
  save(a);
}

/**
 * Claim the right to run the action behind an approved attempt, exactly once.
 * Two polls landing together cannot both run it.
 */
export function claimCompletion(id: string): boolean {
  const s = read();
  const a = s.approvals[id];
  if (!a || a.status !== "approved" || a.completedAt || a.claimedAt) return false;
  a.claimedAt = Date.now();
  write(s);
  return true;
}
