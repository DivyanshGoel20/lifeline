/**
 * Lifeline for Claude Code (or any MCP client).
 *
 * Start a session with this server configured and the agent can pay for x402
 * resources on its human's Lifeline credit line with nothing set up by hand:
 *
 *   1. The first tool call finds no credentials, so it asks Lifeline for a line
 *      of its own and gets back a link for its human.
 *   2. The human opens the link, signed in with World ID, and approves: Lifeline
 *      makes the agent a wallet, authorises it on the human's line and binds a
 *      mandate to it.
 *   3. The next tool call collects that mandate, once, and from then on the
 *      agent quotes, buys and repays on its own. Intercepta screens every payee;
 *      anything risky is held until the human approves it with World ID.
 *
 * The agent never sees a private key: Lifeline holds its wallet's key and signs
 * inside the limits the human set. What the agent keeps is a mandate bound to
 * that one wallet, in ~/.lifeline/credentials.json (0600). Revoking the agent
 * on the dashboard ends it.
 *
 *   LIFELINE_URL          the Lifeline app (default http://localhost:3000)
 *   LIFELINE_AGENT_NAME   how the agent introduces itself (default claude-code)
 *   LIFELINE_RAIL         arc or sui, the rail it asks for (default arc)
 *   LIFELINE_HOME         where credentials live (default ~/.lifeline)
 *   LIFELINE_QR           dark (default) or light: the terminal background the
 *                         QR codes are drawn for; off to leave them out
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import QRCode from "qrcode";

// stdout is the protocol. Anything a dependency logs goes to stderr instead.
console.log = (...a: unknown[]) => console.error(...a);

const BASE = (process.env.LIFELINE_URL || "http://localhost:3000").replace(/\/$/, "");
const HOME = process.env.LIFELINE_HOME || path.join(os.homedir(), ".lifeline");
const CRED_FILE = path.join(HOME, "credentials.json");
const DEFAULT_NAME = process.env.LIFELINE_AGENT_NAME || "claude-code";
const DEFAULT_RAIL = process.env.LIFELINE_RAIL === "sui" ? "sui" : "arc";

type Rail = "arc" | "sui";
type Pending = { code: string; secret: string; approveUrl: string; expiresAt: string; name: string; rail: Rail };
type Connected = {
  token: string;
  agent: { address: string; rail: Rail; suiAddress?: string | null; label: string; network: string };
  grant: { capUsd: number; expiresAt: string; label: string };
  connectedAt: string;
};
type Creds = { pending?: Pending; connected?: Connected };

// ---------------------------------------------------------------- credentials

function readAll(): Record<string, Creds> {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  } catch {
    return {};
  }
}
const load = (): Creds => readAll()[BASE] ?? {};
function save(c: Creds) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const all = readAll();
  all[BASE] = c;
  const tmp = `${CRED_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CRED_FILE);
}

// ---------------------------------------------------------------- http

async function api(
  p: string,
  opts: { method?: string; body?: unknown; bearer?: string } = {}
): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${p}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err: any) {
    throw new Error(`Lifeline is not reachable at ${BASE} (${err?.cause?.code ?? err?.message}). Is the app running?`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------- connecting

type Gate = { ok: true; c: Connected } | { ok: false; text: string };

/**
 * A QR code as text, two rows of modules per line in half blocks, so a phone
 * can scan it straight off the terminal. A block character is drawn in the
 * terminal's text colour, so which modules are drawn depends on the
 * background: on a dark terminal the light modules (and the quiet zone) are
 * the ones drawn. A link a phone cannot reach gets no code.
 */
function qr(url: string): string | null {
  const mode = (process.env.LIFELINE_QR || "dark").toLowerCase();
  if (mode === "off") return null;
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
  } catch {
    return null;
  }
  const { modules } = QRCode.create(url, { errorCorrectionLevel: "L" });
  const size = modules.size;
  const margin = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < size && c < size && !!modules.get(r, c);
  const drawn = (r: number, c: number) => (mode === "light" ? dark(r, c) : !dark(r, c));
  const lines: string[] = [];
  for (let r = -margin; r < size + margin; r += 2) {
    let line = "";
    for (let c = -margin; c < size + margin; c++) {
      const top = drawn(r, c);
      const bottom = r + 1 < size + margin ? drawn(r + 1, c) : mode !== "light";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** A link for the human, with its QR code and the instruction to show both. */
function linkForHuman(url: string): string[] {
  const code = qr(url);
  if (!code) return [`  ${url}`];
  return [
    `  ${url}`,
    "",
    "Show the human this QR code exactly as it is, inside a code block, with the link above - they can scan it with their phone instead of typing the link:",
    "```",
    code,
    "```",
  ];
}

function askHuman(p: Pending, lead: string): string {
  return [
    lead,
    "",
    `ACTION NEEDED - ask your human to open this link and approve it (signed in with World ID):`,
    ...linkForHuman(p.approveUrl),
    `  code ${p.code} · for "${p.name}" on ${p.rail === "arc" ? "Arc" : "Sui"} · expires ${new Date(p.expiresAt).toLocaleTimeString()}`,
    "",
    "Nothing can be bought until they do. Once they have approved it, call any Lifeline tool again (lifeline_status is simplest) and access is picked up automatically.",
  ].join("\n");
}

async function startConnect(opts: { name?: string; rail?: Rail; capUsd?: number; reason?: string }): Promise<Pending> {
  const name = opts.name || DEFAULT_NAME;
  const rail = opts.rail || DEFAULT_RAIL;
  const r = await api("/api/agent/connect", {
    body: { name, rail, capUsd: opts.capUsd, reason: opts.reason, client: "Claude Code (MCP)" },
  });
  if (r.status !== 200) throw new Error(r.data.error ?? `Lifeline refused the connect request (${r.status}).`);
  const pending: Pending = {
    code: r.data.code,
    secret: r.data.secret,
    approveUrl: r.data.approveUrl,
    expiresAt: r.data.expiresAt,
    name,
    rail,
  };
  save({ pending });
  return pending;
}

/**
 * Credentials to spend with, or the words to say to the human. Picks up an
 * approval that happened since the last call, and starts a request when there
 * is none.
 */
async function ensureConnected(): Promise<Gate> {
  const creds = load();
  if (creds.connected) {
    if (new Date(creds.connected.grant.expiresAt).getTime() > Date.now()) return { ok: true, c: creds.connected };
    const p = await startConnect({ name: creds.connected.agent.label, rail: creds.connected.agent.rail });
    return { ok: false, text: askHuman(p, `This agent's mandate expired on ${creds.connected.grant.expiresAt}. It needs a new one.`) };
  }

  if (creds.pending) {
    const p = creds.pending;
    const code = p.code.replace("-", "");
    const r = await api(`/api/agent/connect/${code}`, { bearer: p.secret });
    const status = r.data.status;
    if (status === "approved") {
      const connected: Connected = {
        token: r.data.token,
        agent: r.data.agent,
        grant: r.data.grant,
        connectedAt: new Date().toISOString(),
      };
      save({ connected });
      return { ok: true, c: connected };
    }
    if (status === "pending" || status === "approving") return { ok: false, text: askHuman(p, "Still waiting for your human to approve this agent.") };
    if (status === "denied") {
      save({});
      return {
        ok: false,
        text: "Your human DECLINED this agent's request. Do not retry on your own - ask them first, then call lifeline_connect.",
      };
    }
    // Expired, collected elsewhere, or the server forgot it: ask again.
  }

  const p = await startConnect({});
  return {
    ok: false,
    text: askHuman(
      p,
      "This agent is not connected to Lifeline yet. Every agent is tied to a World ID-verified human and must be authorised by them before it can spend."
    ),
  };
}

/** The mandate stopped working on the server: forget it, so the next call reconnects. */
function lostAccess(r: { status: number; data: any }): string | null {
  if (r.status === 401 || r.status === 410 || r.data?.code === "unknown_agent" || r.data?.code === "not_this_agent") {
    save({});
    return `Lifeline no longer accepts this agent's mandate (${r.data?.error ?? r.status}). It was probably revoked. Call lifeline_status to ask your human to connect it again.`;
  }
  return null;
}

// ---------------------------------------------------------------- formatting

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
/** Dollars with at least two decimals and at most `dp`, without trailing zeros past the cents. */
const usd = (n: number | string | null | undefined, dp = 4) => {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "-";
  const [whole, frac = ""] = Number(n).toFixed(dp).split(".");
  return `$${whole}.${frac.replace(/0+$/, "").padEnd(2, "0")}`;
};

function saveArtifact(svg: string, title?: string): string {
  const dir = path.join(HOME, "artifacts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slug = (title || "artifact").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.svg`);
  fs.writeFileSync(f, svg);
  return f;
}

function describeData(data: any): string {
  if (data === undefined || data === null) return "(no content)";
  if (typeof data === "object" && typeof data.svg === "string") {
    const f = saveArtifact(data.svg, data.title);
    const { svg, ...rest } = data;
    return `${data.title ? `"${data.title}" - ` : ""}an SVG, saved to ${f}\n${JSON.stringify(rest, null, 2).slice(0, 3000)}`;
  }
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s.length > 6000 ? `${s.slice(0, 6000)}\n… (${s.length - 6000} more characters)` : s;
}

function describePurchase(url: string, r: { status: number; data: any }, rail: Rail): string {
  const d = r.data;
  const v = d.screening;
  const verdict = v
    ? `Intercepta: ${v.decision}${v.level ? ` (${v.level})` : ""}${v.reasons?.length ? ` - ${v.reasons.join("; ")}` : ""}`
    : null;

  if (d.hold) {
    return [
      `HELD - not paid. Lifeline stopped this before anything was signed and sent it to your human.`,
      verdict,
      `holdId: ${d.hold.holdId}`,
      "",
      `To go ahead, call lifeline_request_approval with this holdId: your human approves in World ID, then lifeline_approval_status completes the payment. Or pick a different seller.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (!d.success) {
    const why =
      v?.decision === "refuse"
        ? "Intercepta refused the payee before anything was signed."
        : d.error ?? `status ${r.status}`;
    return [`NOT PAID - ${why}${d.code ? ` [${d.code}]` : ""}`, verdict].filter(Boolean).join("\n");
  }

  const t = d.x402;
  const lines = [`PAID for ${url}`];
  if (t) {
    lines.push(
      `  price     ${usd(t.quote.amountUsd)} ${t.quote.assetLabel} on ${t.quote.network} (${t.quote.scheme} · ${t.quote.mechanism})`,
      `  payee     ${t.quote.payTo}`,
      `  signed by ${t.payment.signerRole === "agent" ? "the agent's wallet (Lifeline holds its key)" : "Lifeline, on credit"} - ${t.payment.summary}`
    );
  }
  if (rail === "arc") {
    lines.push(
      `  funding   ${d.fundingSource === "LIFELINE_FACILITY" ? `borrowed ${usd(d.borrowed)} on the human's line` : "the agent's own Gateway balance"}`
    );
    if (d.circleSettlementId) lines.push(`  settled   Circle Gateway ${d.circleSettlementId}`);
    if (d.arcTxLink) lines.push(`  drawdown  ${d.arcTxLink}`);
    if (d.agentDebt !== undefined) lines.push(`  owes now  ${usd(d.agentDebt)}`);
  } else {
    lines.push(
      `  funding   ${d.fundingSource === "LIFELINE_CREDIT" ? `borrowed ${usd(d.borrowed)} from the Sui facility` : "the agent's own wallet"}`
    );
    if (d.digest) lines.push(`  tx        ${d.digest}`);
    if (d.dueMs) lines.push(`  repay due ${new Date(d.dueMs).toISOString()} (settles from the agent's earnings on chain)`);
  }
  if (verdict) lines.push(`  ${verdict}`);
  lines.push("", "What it returned:", describeData(d.data));
  return lines.join("\n");
}

/** The network each rail pays on, as x402 names it. */
const RAIL_NETWORK: Record<Rail, string> = { arc: "eip155:5042002", sui: "sui:" };

/** Read an x402 challenge without paying it. */
async function quote(url: string, method: string = "GET") {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(20_000) });
  if (res.status !== 402) {
    return { free: true as const, status: res.status };
  }
  let challenge: any = null;
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {}
  }
  if (!challenge) challenge = await res.json().catch(() => null);
  const accepts: any[] = challenge?.accepts ?? [];
  return {
    free: false as const,
    x402Version: challenge?.x402Version,
    description: challenge?.resource?.description ?? challenge?.description,
    options: accepts.map((a) => ({
      scheme: a.scheme,
      network: a.network,
      asset: a.asset,
      assetName: a.extra?.name,
      payTo: a.payTo,
      amountUsd: Number(a.amount ?? a.maxAmountRequired) / 1e6,
    })),
  };
}

// ---------------------------------------------------------------- tools

const server = new McpServer(
  { name: "lifeline", version: "0.1.0" },
  {
    instructions:
      "Lifeline gives this agent a credit line from its World ID-verified human, for paying x402 resources. " +
      "Start with lifeline_status. If the agent is not connected, it returns a link: show it to the user and ask them to approve - " +
      "never try to work around it. Then lifeline_discover to find real services (lifeline_catalogue for the demo sellers), lifeline_quote to see a price, and lifeline_buy to pay. " +
      "Payments go through Intercepta screening; a HELD result needs the human's approval via lifeline_request_approval.",
  }
);

server.registerTool(
  "lifeline_status",
  {
    title: "Lifeline status",
    description:
      "Whether this agent is connected to Lifeline, and if so its wallet, rail, what it owes and what it can still borrow. " +
      "If it is not connected yet, this starts the connection and returns a link the human must open to approve it.",
    inputSchema: {},
  },
  async () => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    const r = await api("/api/agent/me", { bearer: g.c.token });
    const lost = lostAccess(r);
    if (lost) return fail(lost);
    if (r.status !== 200) return fail(r.data.error ?? `status ${r.status}`);
    const m = r.data;
    return text(
      [
        `Connected to Lifeline at ${BASE}`,
        `  agent       ${m.agent.name} · ${m.agent.rail === "arc" ? "Arc" : "Sui"}`,
        `  wallet      ${m.agent.rail === "sui" ? m.agent.suiAddress : m.agent.address}`,
        `  owes        ${usd(m.owesUsd)}`,
        `  can borrow  ${usd(m.canBorrowUsd, 2)} (mandate cap ${usd(m.mandate.capUsd, 2)}, expires ${m.mandate.expiresAt.slice(0, 10)})`,
        `  holds       ${m.walletUsd === null ? "-" : usd(m.walletUsd)} of its own`,
        "",
        "Tied to a World ID-verified human, who authorised it. Use lifeline_catalogue to see what is for sale.",
      ].join("\n")
    );
  }
);

server.registerTool(
  "lifeline_connect",
  {
    title: "Connect to Lifeline",
    description:
      "Ask the human for a Lifeline credit line for this agent. Returns a link they open to approve it. " +
      "Only needed to choose the name, rail or cap, or to replace an existing connection; lifeline_status connects with defaults on its own.",
    inputSchema: {
      name: z.string().max(48).optional().describe("How the agent introduces itself to the human"),
      rail: z.enum(["arc", "sui"]).optional().describe("Arc (Circle Gateway, batched) or Sui (on-chain facility)"),
      capUsd: z.number().positive().max(1000).optional().describe("Spending cap to ask for, in USDC"),
      reason: z.string().max(280).optional().describe("What the agent wants the money for, shown to the human"),
      replace: z.boolean().optional().describe("Start over even if already connected"),
    },
  },
  async (args) => {
    const creds = load();
    if (creds.connected && !args.replace) {
      return text(
        `Already connected as ${creds.connected.agent.label} on ${creds.connected.agent.rail}. Pass replace: true to ask for a new line instead.`
      );
    }
    const p = await startConnect(args);
    return text(askHuman(p, "Asked Lifeline for a line for this agent."));
  }
);

server.registerTool(
  "lifeline_catalogue",
  {
    title: "What is for sale",
    description: "x402 resources the sellers on this agent's rail offer, with prices and the URL to buy each.",
    inputSchema: {},
  },
  async () => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    const rail = g.c.agent.rail;
    const r = await api(`/api/x402/catalogue${rail === "sui" ? "?rail=sui" : ""}`, { bearer: g.c.token });
    const lost = lostAccess(r);
    if (lost) return fail(lost);
    const items: any[] = r.data.resources ?? [];
    if (!items.length) return text(`No ${rail} seller is reachable right now.${r.data.reason ? ` (${r.data.reason})` : ""}`);
    const base = String(r.data.base ?? "").replace(/\/$/, "");
    return text(
      [
        `For sale on ${rail === "arc" ? "Arc" : "Sui"}:`,
        ...items.map((i) => `  ${usd(i.price, 3).padEnd(8)} ${i.title}${i.artifact ? ` [${i.artifact}]` : ""}\n           ${base}${i.path}`),
        "",
        "lifeline_quote shows the exact terms; lifeline_buy pays.",
      ].join("\n")
    );
  }
);

server.registerTool(
  "lifeline_discover",
  {
    title: "Find real services to buy",
    description:
      "Search Circle's agent marketplace for x402 services Lifeline can pay on Arc, best first: sellers with a poor delivery record come last, and Lifeline will not lend to buy from them.",
    inputSchema: {
      query: z.string().max(200).optional().describe("What you need, in plain words"),
      category: z.string().max(40).optional().describe("For example WEB_SEARCH_RESEARCH or FINANCIAL_ANALYSIS"),
      maxUsd: z.number().positive().optional().describe("Most you would pay per call"),
      limit: z.number().int().positive().max(50).optional(),
    },
  },
  async ({ query, category, maxUsd, limit }) => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    if (g.c.agent.rail !== "arc") return text("The marketplace is paid through Arc. This agent is on Sui; use lifeline_catalogue.");
    const q = new URLSearchParams();
    if (query) q.set("query", query);
    if (category) q.set("category", category);
    if (maxUsd !== undefined) q.set("maxUsd", String(maxUsd));
    q.set("limit", String(limit ?? 10));
    const r = await api(`/api/x402/discover?${q}`, { bearer: g.c.token });
    const lost = lostAccess(r);
    if (lost) return fail(lost);
    if (r.status !== 200) return fail(r.data.error ?? `status ${r.status}`);
    const items: any[] = r.data.services ?? [];
    if (!items.length) return text("Nothing in the marketplace matches that on Arc right now.");
    return text(
      [
        `${r.data.total} on Arc; best ${items.length}:`,
        ...items.map((s) => {
          const record = s.quality.samples ? `delivered ~${Math.round(s.quality.score * 100)}% of ${s.quality.samples}` : "no record yet";
          const flags = [s.needsSignIn ? "wants sign-in" : "", s.quality.poor ? "POOR RECORD, no credit" : ""].filter(Boolean).join(", ");
          return `  ${usd(s.priceUsd, 4).padEnd(9)} ${s.provider} · ${record}${flags ? ` · ${flags}` : ""}\n            ${s.method} ${s.url}\n            ${String(s.description).slice(0, 120)}`;
        }),
        "",
        "lifeline_buy pays; pass method and body for a POST service.",
      ].join("\n")
    );
  }
);

server.registerTool(
  "lifeline_quote",
  {
    title: "Quote an x402 resource",
    description: "Ask a resource what it costs without paying: reads its 402 Payment Required challenge.",
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    try {
      const q = await quote(url);
      if (q.free) return text(`${url} answered ${q.status} without asking for payment - nothing to buy.`);
      // Lifeline pays on its rail's network; the rest are shown as a count.
      const rail = load().connected?.agent.rail ?? DEFAULT_RAIL;
      const ours = q.options.filter((o) => String(o.network).startsWith(RAIL_NETWORK[rail]));
      const shown = ours.length ? ours : q.options;
      const others = q.options.length - shown.length;
      return text(
        [
          `${url} wants payment (x402 v${q.x402Version ?? "?"})${q.description ? ` - ${q.description}` : ""}`,
          ...shown.map(
            (o) => `  ${usd(o.amountUsd)} in ${o.assetName ?? "token"} ${o.asset} on ${o.network} (${o.scheme}), paid to ${o.payTo}`
          ),
          ...(others > 0 ? [`  (also accepted on ${others} other network${others === 1 ? "" : "s"} Lifeline does not pay on)`] : []),
          "",
          "Payees and assets are screened by Intercepta when you buy, not here.",
        ].join("\n")
      );
    } catch (err: any) {
      return fail(`Could not reach ${url}: ${err?.message ?? err}`);
    }
  }
);

server.registerTool(
  "lifeline_buy",
  {
    title: "Buy an x402 resource",
    description:
      "Pay for an x402 resource on this agent's Lifeline line and return what it delivered. " +
      "Lifeline screens the payee with Intercepta, pays from the agent's own balance first and borrows the rest. " +
      "Risky payees, and anything past the agent's spending cap, come back HELD for the human's approval.",
    inputSchema: {
      url: z.string().url(),
      maxUsd: z.number().positive().optional().describe("Refuse if the quoted price is higher than this"),
      method: z.enum(["GET", "POST"]).optional().describe("How the service wants to be called. lifeline_discover says which"),
      body: z.unknown().optional().describe("Request body for a POST service"),
    },
  },
  async ({ url, maxUsd, method, body }) => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    if (maxUsd !== undefined) {
      try {
        const q = await quote(url, method);
        const price = q.free ? 0 : Math.min(...q.options.map((o) => o.amountUsd));
        if (price > maxUsd) return fail(`Not bought: it costs ${usd(price)}, over your limit of ${usd(maxUsd)}.`);
      } catch (err: any) {
        return fail(`Could not quote ${url}: ${err?.message ?? err}`);
      }
    }
    const rail = g.c.agent.rail;
    const r = await api(rail === "arc" ? "/api/pay" : "/api/sui/pay", {
      body: { url, agentAddress: g.c.agent.address, method, body },
      bearer: g.c.token,
    });
    const lost = lostAccess(r);
    if (lost) return fail(lost);
    const out = describePurchase(url, r, rail);
    return r.data.success ? text(out) : r.data.hold ? text(out) : fail(out);
  }
);

server.registerTool(
  "lifeline_request_approval",
  {
    title: "Ask the human to release a held payment",
    description:
      "For a payment that came back HELD: asks the human to approve it with World ID. Returns a code and link for them. " +
      "Then poll lifeline_approval_status.",
    inputSchema: { holdId: z.string() },
  },
  async ({ holdId }) => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    const r = await api(`/api/pay/holds/${encodeURIComponent(holdId)}/approval`, { method: "POST", bearer: g.c.token });
    const lost = lostAccess(r);
    if (lost) return fail(lost);
    if (!r.data.success) return fail(r.data.error ?? `status ${r.status}`);
    return text(
      [
        "ACTION NEEDED - your human approves this payment with World ID:",
        ...linkForHuman(r.data.verificationUriComplete ?? r.data.verificationUri),
        r.data.userCode ? `  code ${r.data.userCode}` : "",
        "",
        `Then call lifeline_approval_status with holdId ${holdId} - the payment goes through once they approve. If they decline it stays unpaid.`,
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
  }
);

server.registerTool(
  "lifeline_approval_status",
  {
    title: "Held payment status",
    description: "Whether the human approved a held payment. Once approved, Lifeline pays and this returns what was bought.",
    inputSchema: { holdId: z.string() },
  },
  async ({ holdId }) => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    const r = await api(`/api/pay/holds/${encodeURIComponent(holdId)}/approval`, { bearer: g.c.token });
    const lost = lostAccess(r);
    if (lost) return fail(lost);
    if (!r.data.success) return fail(r.data.error ?? `status ${r.status}`);
    if (r.data.status === "pending") return text(`Still waiting for your human to answer in World ID${r.data.userCode ? ` (code ${r.data.userCode})` : ""}.`);
    if (r.data.status === "approved" && r.data.payment) {
      const rail: Rail = r.data.payment.x402?.rail === "sui" ? "sui" : "arc";
      return text(`Your human approved it.\n\n${describePurchase(r.data.payment.x402?.request?.url ?? "the held resource", { status: 200, data: r.data.payment }, rail)}`);
    }
    return text(`Not approved (${r.data.status}${r.data.reason ? `: ${r.data.reason}` : ""}). Nothing was paid.`);
  }
);

server.registerTool(
  "lifeline_repay",
  {
    title: "Repay what this agent owes",
    description:
      "Arc: repays the agent's debt from its own wallet (Lifeline signs with the key it holds). Defaults to everything owed. " +
      "Sui: repayments settle on chain from the agent's earnings when due; this reports what is owed.",
    inputSchema: {
      amountUsd: z.number().positive().optional(),
      fromChain: z
        .enum(["Ethereum_Sepolia", "Base_Sepolia", "Arbitrum_Sepolia", "Optimism_Sepolia", "Polygon_Amoy_Testnet", "Avalanche_Fuji", "Unichain_Sepolia"])
        .optional()
        .describe("Arc only: repay with USDC the agent holds on this chain, bridged to Arc first"),
      token: z
        .enum(["WETH", "UNI", "cbBTC"])
        .optional()
        .describe("Arc only: repay with this token from the agent's wallet on Base, through the Uniswap Token Jar"),
      tokenAmount: z.string().optional().describe("How much of that token, as a decimal string. It does not come back."),
    },
  },
  async ({ amountUsd, fromChain, token, tokenAmount }) => {
    const g = await ensureConnected();
    if (!g.ok) return text(g.text);
    const me = await api("/api/agent/me", { bearer: g.c.token });
    const lost = lostAccess(me);
    if (lost) return fail(lost);
    const owes = Number(me.data.owesUsd ?? 0);
    if (!(owes > 0)) return text("Nothing owed.");
    if (g.c.agent.rail === "sui") {
      return text(
        `Owes ${usd(owes)} on Sui. Sui repayments are parked on chain and settle from the agent's earnings when due; the human can also settle early from the dashboard.`
      );
    }
    if (token) {
      if (!tokenAmount) return fail("Say how much of the token to send: tokenAmount.");
      const j = await api("/api/jar", { body: { agentAddress: g.c.agent.address, token, amount: tokenAmount }, bearer: g.c.token });
      if (!j.data.success) return fail(`Not repaid: ${j.data.error ?? `status ${j.status}`}`);
      return text(`Sent ${tokenAmount} ${token} to the Token Jar. Repaid ${usd(j.data.repaidUsd)} (${j.data.repayTxHash}).`);
    }
    const amount = Math.min(amountUsd ?? owes, owes);
    if (fromChain) {
      const b = await api("/api/repay/crosschain", { body: { agentAddress: g.c.agent.address, fromChain, amountUsd: amount }, bearer: g.c.token });
      if (!b.data.success) return fail(`Not repaid: ${b.data.error ?? `status ${b.status}`}`);
      return text(`Bridged ${usd(b.data.bridgedUsd)} from ${fromChain} to Arc and repaid ${usd(b.data.repaidUsd)}.`);
    }
    const r = await api("/api/repay", { body: { agentAddress: g.c.agent.address, amount }, bearer: g.c.token });
    if (!r.data.success) {
      return fail(
        `Not repaid: ${r.data.error ?? `status ${r.status}`}` +
          (Number(me.data.walletUsd) < amount ? `\nThe agent's wallet holds ${usd(me.data.walletUsd)}; the human can repay by card or from their own wallet on the dashboard.` : "")
      );
    }
    return text(r.data.message ?? `Repaid ${usd(amount)}.`);
  }
);

server.registerTool(
  "lifeline_disconnect",
  {
    title: "Forget this agent's Lifeline access",
    description: "Deletes the local mandate. It does not revoke the agent; the human does that from the dashboard.",
    inputSchema: {},
  },
  async () => {
    save({});
    return text("Forgot the local credentials. The agent stays registered until the human revokes it on the dashboard.");
  }
);

server
  .connect(new StdioServerTransport())
  .then(() => console.error(`[lifeline-mcp] ready · ${BASE} · credentials ${CRED_FILE}`))
  .catch((err) => {
    console.error("[lifeline-mcp] failed to start:", err);
    process.exit(1);
  });
