import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { X402Trace } from "./x402";
import { agentKeypair, operatorKeypair, suiClient } from "./client";
import { fromUnits, requireDeployment, termMs, toUnits, trancheCeilingUsd } from "./config";
import {
  authorizeAgent,
  buildDrawAndPay,
  buildSelfPay,
  createProfile,
  facilityLiquidity,
  isAgentAuthorized,
  openPurse,
  parkRepayment,
  readObligation,
  readProfile,
  setCreditLimit,
  signTransaction,
  walletUnits,
} from "./facility";
import { encodeHeader, paymentPayload, suiRequirementsFrom, decodeHeader } from "./x402";

/**
 * Lifeline's payer on Sui: quote, decide, park, settle.
 *
 * An agent that can afford a resource pays for
 * it. One that cannot has the shortfall drawn from the facility - but only
 * against a repayment it has already parked, and in the same transaction that
 * pays the seller, so there is never a moment where Lifeline has paid and holds
 * only a promise, nor a debt without a delivery.
 */

export interface SuiPayContext {
  /** The agent's secp256k1 key - its Arc key, which is also its Sui key. */
  agentKey: string;
  /** keccak of the human's World nullifier, the same profile id as on Arc. */
  profileId: string;
  /** The human's line, so a first draw can open their profile at the right size. */
  creditLimitUsd: number;
  /** The tightest of headroom across both rails and any mandate cap. */
  maxCreditUsd: number;
  /**
   * Called with the price once the 402 has named it, before anything is
   * signed. A key Lifeline holds for an agent is held under a per-payment ceiling
   * and an expiry; this is where they are enforced. Throw to refuse.
   */
  approve?: (amountUsd: number) => void;
  /**
   * Called with what must be borrowed, once that is known and before anything
   * is signed. Throw to stop the payment (the web app holds it for the human).
   */
  approveDraw?: (drawUsd: number, quote: { payTo: string; priceUsd: number }) => void;
}

export interface SuiPayResult {
  success: true;
  fundingSource: "AGENT_WALLET" | "LIFELINE_CREDIT";
  agent: string;
  payTo: string;
  amount: string;
  borrowed: string;
  ownContribution: string;
  digest?: string;
  obligationId?: string;
  purseId?: string;
  dueMs?: number;
  parkedDigest?: string;
  data: unknown;
  /** How it happened, step by step. */
  x402?: X402Trace;
}

/** Which purse and obligations belong to which agent, so tranches are reused. */
type BookEntry = { purseId?: string; obligations: string[] };

function bookFile(): string {
  if (process.env.LIFELINE_SUI_BOOK) return process.env.LIFELINE_SUI_BOOK;
  for (const c of [
    path.resolve(process.cwd(), "web", "data", "sui-agents.json"),
    path.resolve(process.cwd(), "data", "sui-agents.json"),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), "data", "sui-agents.json");
}

const bookKey = (agent: string) => `${requireDeployment().facilityId}:${agent}`;

/** Where the book lives can be replaced, for hosts with no lasting disk. */
let bookStore: { read(): Record<string, BookEntry> | null; write(book: Record<string, BookEntry>): void } | null = null;
export const setBookStore = (s: typeof bookStore) => {
  bookStore = s;
};

export function readBook(): Record<string, BookEntry> {
  if (bookStore) return bookStore.read() ?? {};
  try {
    const f = bookFile();
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeBook(book: Record<string, BookEntry>) {
  if (bookStore) return bookStore.write(book);
  const f = bookFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2));
  fs.renameSync(tmp, f);
}

export function agentBook(agent: string): BookEntry {
  return readBook()[bookKey(agent)] ?? { obligations: [] };
}

function saveAgentBook(agent: string, entry: BookEntry) {
  const book = readBook();
  book[bookKey(agent)] = entry;
  writeBook(book);
}

/**
 * Enough runway that a draw is not refused for being past due mid-flight. A
 * minute, or a fifth of the term when the term is short enough that a minute
 * would rule out every tranche ever parked.
 */
const drawMarginMs = () => Math.min(60_000, termMs() / 5);

/**
 * Everything a first draw needs, created only if missing: the human's profile
 * on this facility, the agent's authorisation, its purse, and an obligation
 * with room for this draw.
 */
export async function prepareCredit(ctx: SuiPayContext, drawUnits: bigint) {
  const operator = operatorKeypair();
  const agent = agentKeypair(ctx.agentKey);
  const agentAddr = agent.toSuiAddress();
  const limit = toUnits(ctx.creditLimitUsd);

  const profile = await readProfile(ctx.profileId);
  if (!profile) {
    await createProfile(operator, { profileId: ctx.profileId, humanOwner: operator.toSuiAddress(), limitUnits: limit });
  } else if (profile.creditLimit !== limit) {
    // The tier the human has earned is set off-chain; keep the chain's
    // backstop in step with it.
    await setCreditLimit(operator, ctx.profileId, limit);
  }
  if (!(await isAgentAuthorized(ctx.profileId, agentAddr))) {
    await authorizeAgent(operator, ctx.profileId, agentAddr);
  }

  const entry = agentBook(agentAddr);
  if (!entry.purseId) {
    entry.purseId = await openPurse(agent, operator, ctx.profileId);
    saveAgentBook(agentAddr, entry);
  }

  const now = Date.now();
  for (const id of [...entry.obligations].reverse()) {
    const ob = await readObligation(id).catch(() => null);
    if (
      ob &&
      ob.status === "open" &&
      ob.dueMs - now > drawMarginMs() &&
      ob.drawn + drawUnits <= ob.ceiling
    ) {
      return { agent, operator, purseId: entry.purseId, obligationId: id, dueMs: ob.dueMs, parkedDigest: undefined };
    }
  }

  // No tranche with room: park a new promise before anything is spent.
  const ceiling = toUnits(trancheCeilingUsd()) > drawUnits ? toUnits(trancheCeilingUsd()) : drawUnits;
  const dueMs = now + termMs();
  const parked = await parkRepayment(agent, operator, { purseId: entry.purseId, ceilingUnits: ceiling, dueMs });
  entry.obligations.push(parked.obligationId);
  saveAgentBook(agentAddr, entry);
  return { agent, operator, purseId: entry.purseId, obligationId: parked.obligationId, dueMs, parkedDigest: parked.digest };
}

export async function paySui(
  url: string,
  ctx: SuiPayContext,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<SuiPayResult> {
  const d = requireDeployment();
  const method = init.method ?? "GET";
  const headers = { "Content-Type": "application/json", ...init.headers };

  // Never follow a redirect: a public URL could bounce the request into a private network.
  const first = await fetch(url, { redirect: "manual", method, headers, body: init.body });
  const agent = agentKeypair(ctx.agentKey);
  const agentAddr = agent.toSuiAddress();

  if (first.status !== 402) {
    if (!first.ok) throw new Error(`Resource answered ${first.status}`);
    return {
      success: true,
      fundingSource: "AGENT_WALLET",
      agent: agentAddr,
      payTo: "",
      amount: "0",
      borrowed: "0",
      ownContribution: "0",
      data: await first.json().catch(() => null),
    };
  }

  const quote = suiRequirementsFrom(first.headers.get("payment-required"));
  if (!quote) throw new Error("The resource does not accept payment on Sui");
  if (quote.network !== `sui:${d.network}`) {
    throw new Error(`The resource wants ${quote.network}; Lifeline is on sui:${d.network}`);
  }
  if (quote.asset !== d.coinType) {
    throw new Error(`The resource wants ${quote.asset}; Lifeline's facility lends ${d.coinType}`);
  }

  const price = BigInt(quote.amount);
  ctx.approve?.(fromUnits(price));
  const own = await walletUnits(agentAddr);
  const operator = operatorKeypair();
  const reference = crypto.createHash("sha256").update(url).digest();

  let tx;
  let credit: Awaited<ReturnType<typeof prepareCredit>> | null = null;
  let drawUnits = 0n;
  let ownUnits = price;

  if (own >= price) {
    tx = buildSelfPay({ agent: agentAddr, units: price, payTo: quote.payTo });
  } else {
    drawUnits = price - own;
    ownUnits = own;
    ctx.approveDraw?.(fromUnits(drawUnits), { payTo: quote.payTo, priceUsd: fromUnits(price) });
    if (fromUnits(drawUnits) > ctx.maxCreditUsd + 1e-9) {
      throw new Error(
        `Lifeline: shortfall of ${fromUnits(drawUnits).toFixed(6)} exceeds the ` +
          `${ctx.maxCreditUsd.toFixed(6)} of credit available to this agent`
      );
    }
    if ((await facilityLiquidity()) < drawUnits) {
      throw new Error("The Sui facility does not hold enough liquidity for this draw");
    }
    credit = await prepareCredit(ctx, drawUnits);
    tx = buildDrawAndPay({
      agent: agentAddr,
      purseId: credit.purseId,
      obligationId: credit.obligationId,
      drawUnits,
      ownUnits,
      payTo: quote.payTo,
      referenceHash: reference,
    });
  }

  const { bytes, signatures } = await signTransaction(tx, agent, operator);
  const paid = await fetch(url, {
    redirect: "manual",
    method,
    headers: { ...headers, "PAYMENT-SIGNATURE": encodeHeader(paymentPayload(quote, bytes, signatures)) },
    body: init.body,
  });
  if (!paid.ok) {
    const err = await paid.json().catch(() => ({}));
    throw new Error(`Seller refused the payment: ${err.reason || err.error || paid.statusText}`);
  }

  const receipt = paid.headers.get("payment-response");
  const settled = receipt ? decodeHeader<{ transaction?: string }>(receipt) : {};
  const firstQuote = decodeHeader<{ x402Version?: number; resource?: { description?: string } }>(
    first.headers.get("payment-required")!
  );

  // The seller executed it, in another process. Until this node has indexed
  // that, the sponsor's gas coin still reads at its old version, and the next
  // transaction Lifeline builds is rejected as stale.
  if (settled.transaction) {
    await suiClient().waitForTransaction({ digest: settled.transaction }).catch(() => undefined);
  }

  return {
    success: true,
    fundingSource: credit ? "LIFELINE_CREDIT" : "AGENT_WALLET",
    agent: agentAddr,
    payTo: quote.payTo,
    amount: fromUnits(price).toFixed(6),
    borrowed: fromUnits(drawUnits).toFixed(6),
    ownContribution: fromUnits(ownUnits).toFixed(6),
    digest: settled.transaction,
    obligationId: credit?.obligationId,
    purseId: credit?.purseId,
    dueMs: credit?.dueMs,
    parkedDigest: credit?.parkedDigest,
    data: await paid.json().catch(() => null),
    x402: {
      rail: "sui",
      request: { method, url },
      challenge: { status: 402, x402Version: firstQuote.x402Version ?? 2, description: firstQuote.resource?.description },
      quote: {
        scheme: quote.scheme,
        network: quote.network,
        mechanism: "Sui transaction, submitted by the seller",
        asset: quote.asset,
        assetLabel: quote.asset.split("::").pop() ?? quote.asset,
        amount: quote.amount,
        amountUsd: fromUnits(price),
        payTo: quote.payTo,
        maxTimeoutSeconds: quote.maxTimeoutSeconds,
      },
      payment: {
        signer: agentAddr,
        signerRole: "agent",
        summary: credit
          ? `The agent signed one transaction that draws ${fromUnits(drawUnits).toFixed(6)} from Lifeline's facility against its parked repayment, adds ${fromUnits(ownUnits).toFixed(6)} of its own, and pays the seller; Lifeline sponsored the gas.`
          : "The agent signed a transaction paying the seller from its own coins; Lifeline sponsored the gas.",
        borrowedUsd: fromUnits(drawUnits),
      },
      settlement: { status: paid.status, receipt: settled as Record<string, unknown> },
      response: { contentType: paid.headers.get("content-type") },
    },
  };
}
