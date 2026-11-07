import fs from "./storeFs";
import path from "path";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient } from "viem";
import { writeJsonAtomic } from "./atomicWrite";
import { arcTestnetChain } from "./facilityContract";
import { getArcTransport } from "./arcRpc";

/**
 * Custody of agent signing keys.
 *
 * Holding somebody's private key is the least trustworthy thing this product
 * does, so the design goal is to hold as little authority as possible for as
 * short a time as possible, and to be honest that it is still custody.
 *
 * Three properties that plaintext-in-a-file did not have:
 *
 *   Encrypted at rest. AES-256-GCM under a key derived from
 *   LIFELINE_KEYSTORE_SECRET. A leaked repository, backup or laptop no longer
 *   leaks spending authority - which is not hypothetical here, a key reached
 *   this project's git history exactly that way.
 *
 *   Bounded. A key is stored with a per-payment ceiling and an expiry. Lifeline
 *   may sign payments up to that amount until that date, rather than anything
 *   at all forever.
 *
 *   Revocable. Authority can be withdrawn without touching the agent's wallet.
 *
 * What this is not: non-custodial. A compromised server still signs within
 * those bounds, because the key is in memory to use it. The only designs that
 * remove that are the agent signing for itself, or a remote signer where the
 * key never enters this process. Both are real options and neither is this.
 */

/** Authority expires by default rather than persisting silently. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A ceiling large enough for the dossier tier, small enough to bound a breach. */
const DEFAULT_MAX_PER_PAYMENT_USD = 5;

interface KeyEntry {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  maxPerPaymentUsd: number | null;
  expiresAt: number | null;
  createdAt: number;
}

interface Keystore {
  version: 2;
  entries: Record<string, KeyEntry>;
}

function secret(): string | null {
  const s = process.env.LIFELINE_KEYSTORE_SECRET;
  return s && s.length >= 16 ? s : null;
}

function derive(pass: string, salt: Buffer): Buffer {
  return crypto.scryptSync(pass, salt, 32);
}

function encrypt(plain: string, pass: string): Omit<KeyEntry, "maxPerPaymentUsd" | "expiresAt" | "createdAt"> {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derive(pass, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    salt: salt.toString("base64"),
  };
}

function decrypt(entry: KeyEntry, pass: string): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      derive(pass, Buffer.from(entry.salt, "base64")),
      Buffer.from(entry.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong secret or tampered file. Indistinguishable on purpose.
    return null;
  }
}

function filePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "agent-keys.json"),
    path.resolve(process.cwd(), "data", "agent-keys.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.resolve(process.cwd(), "data", "agent-keys.json");
}

/** Legacy plaintext entries, read so an existing install keeps working. */
function readLegacy(): Record<string, string> {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && parsed.version === 2) return {};
    const out: Record<string, string> = {};
    for (const [addr, key] of Object.entries(parsed ?? {})) {
      if (typeof key === "string" && key.startsWith("0x") && key.length === 66) {
        out[addr.toLowerCase()] = key;
      }
    }
    if (Object.keys(out).length > 0) {
      console.warn(
        "[AgentKeys] Plaintext keys found in the keystore. Set LIFELINE_KEYSTORE_SECRET " +
          "and re-add the agent to store them encrypted."
      );
    }
    return out;
  } catch {
    return {};
  }
}

function readStore(): Keystore {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { version: 2, entries: {} };
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed?.version === 2 && parsed.entries) return parsed as Keystore;
  } catch (err) {
    console.warn("[AgentKeys] Could not read the keystore:", err);
  }
  return { version: 2, entries: {} };
}

function writeStore(store: Keystore) {
  writeJsonAtomic(filePath(), store);
}

/** A key supplied through the environment, for single-agent deployments. */
function envKey(): { address: string; key: `0x${string}` } | null {
  const raw = process.env.AGENT_PRIVATE_KEY;
  if (!raw || !raw.startsWith("0x") || raw.length !== 66) return null;
  try {
    return { address: privateKeyToAccount(raw as `0x${string}`).address.toLowerCase(), key: raw as `0x${string}` };
  } catch {
    return null;
  }
}

export interface StoreKeyResult {
  ok: boolean;
  error?: string;
  expiresAt?: number;
  maxPerPaymentUsd?: number;
}

/**
 * Registers a signing key for an agent.
 *
 * The key must derive to the address it is being registered for. This used to
 * store a mismatch under both addresses without complaint, which meant a
 * mistyped pair silently pointed Lifeline at somebody else's wallet - repayments
 * would have moved USDC out of the wrong account, and an x402 payment would
 * check one balance and sign with another.
 */
export function setAgentPrivateKey(
  address: string,
  privateKey: string,
  opts?: { maxPerPaymentUsd?: number; ttlMs?: number }
): StoreKeyResult {
  if (!address || !privateKey) return { ok: false, error: "Address and key are both required." };

  const clean = privateKey.trim();
  const formatted = (clean.startsWith("0x") ? clean : `0x${clean}`) as `0x${string}`;
  if (formatted.length !== 66) {
    return { ok: false, error: "A signing key is 32 bytes: 0x followed by 64 hex characters." };
  }

  let derived: string;
  try {
    derived = privateKeyToAccount(formatted).address.toLowerCase();
  } catch {
    return { ok: false, error: "That is not a valid secp256k1 private key." };
  }

  const target = address.trim().toLowerCase();
  if (derived !== target) {
    return {
      ok: false,
      error:
        `That key controls ${derived}, not ${target}. ` +
        "Registering it would make Lifeline sign for a different wallet than the agent.",
    };
  }

  const pass = secret();
  if (!pass) {
    return {
      ok: false,
      error:
        "LIFELINE_KEYSTORE_SECRET is not set, so the key cannot be stored encrypted. " +
        "Set it (16+ characters) and try again, or leave the key blank and let Lifeline sign.",
    };
  }

  const maxPerPaymentUsd = opts?.maxPerPaymentUsd ?? DEFAULT_MAX_PER_PAYMENT_USD;
  const expiresAt = Date.now() + (opts?.ttlMs ?? DEFAULT_TTL_MS);

  const store = readStore();
  store.entries[target] = {
    ...encrypt(formatted, pass),
    maxPerPaymentUsd,
    expiresAt,
    createdAt: Date.now(),
  };
  writeStore(store);

  return { ok: true, expiresAt, maxPerPaymentUsd };
}

export function getAgentPrivateKey(address: string): `0x${string}` | null {
  if (!address) return null;
  const target = address.trim().toLowerCase();

  const fromEnv = envKey();
  if (fromEnv && fromEnv.address === target) return fromEnv.key;

  const entry = readStore().entries[target];
  if (entry) {
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      console.warn(`[AgentKeys] Signing authority for ${target} expired; refusing to sign.`);
      return null;
    }
    const pass = secret();
    if (!pass) {
      console.warn("[AgentKeys] LIFELINE_KEYSTORE_SECRET is not set; encrypted keys are unreadable.");
      return null;
    }
    const plain = decrypt(entry, pass);
    return plain && plain.length === 66 ? (plain as `0x${string}`) : null;
  }

  const legacy = readLegacy()[target];
  return legacy ? (legacy as `0x${string}`) : null;
}

/**
 * Whether Lifeline may sign a payment of this size for this agent.
 *
 * A credit limit bounds what the human owes; this bounds what a compromised
 * Lifeline could spend from the agent's own wallet before anyone notices.
 */
export function authorizeAgentSpend(
  address: string,
  amountUsd: number
): { ok: boolean; reason?: string } {
  const entry = readStore().entries[address.trim().toLowerCase()];
  if (!entry) return { ok: true }; // env or legacy key: no recorded ceiling

  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    return { ok: false, reason: "Signing authority for this agent has expired." };
  }
  if (entry.maxPerPaymentUsd !== null && amountUsd > entry.maxPerPaymentUsd) {
    return {
      ok: false,
      reason: `Above the agent's per-payment ceiling of $${entry.maxPerPaymentUsd.toFixed(2)}.`,
    };
  }
  return { ok: true };
}

/** Withdraws Lifeline's authority without touching the agent's wallet. */
export function revokeAgentKey(address: string): boolean {
  const target = address.trim().toLowerCase();
  const store = readStore();
  if (!store.entries[target]) return false;
  delete store.entries[target];
  writeStore(store);
  return true;
}

/** What authority Lifeline holds, for display. Never includes the key. */
export function describeAgentKey(address: string) {
  const target = address.trim().toLowerCase();
  const fromEnv = envKey();
  if (fromEnv && fromEnv.address === target) {
    return { held: true, source: "env" as const, maxPerPaymentUsd: null, expiresAt: null };
  }
  const entry = readStore().entries[target];
  if (!entry) return { held: false as const };
  return {
    held: true,
    source: "keystore" as const,
    maxPerPaymentUsd: entry.maxPerPaymentUsd,
    expiresAt: entry.expiresAt,
    expired: !!(entry.expiresAt && entry.expiresAt <= Date.now()),
  };
}

export function hasAgentPrivateKey(address: string): boolean {
  return !!getAgentPrivateKey(address);
}

export function getAgentAccount(address: string) {
  const pk = getAgentPrivateKey(address);
  if (!pk) return null;
  try {
    return privateKeyToAccount(pk);
  } catch {
    return null;
  }
}

export function getAgentWalletClient(address: string) {
  const account = getAgentAccount(address);
  if (!account) return null;
  return createWalletClient({
    account,
    chain: arcTestnetChain,
    transport: getArcTransport(),
  });
}
