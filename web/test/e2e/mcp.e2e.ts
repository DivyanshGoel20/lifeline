/**
 * The Lifeline MCP server, driven the way Claude Code drives it: over stdio,
 * with an MCP client, against the running app and Arc testnet.
 *
 *   npm run dev            # the app
 *   npm run premium        # the Express seller
 *   npm run e2e:mcp
 *
 * What it shows:
 *   1. an agent with nothing asks, and gets a link for its human - no spending yet
 *   2. the human approves on the connect page; the agent picks up a mandate
 *      bound to its own new wallet, stored 0600, without anything pasted
 *   3. it browses, quotes and buys with it; Intercepta refuses the flagged
 *      seller; a private-network URL is refused; the mandate cannot spend
 *      through another of the human's agents
 *   4. revoking the agent on the dashboard ends the mandate, and the agent
 *      says so and asks again
 *   5. the same on Sui (needs `npm run sui:service`)
 *
 * The World ID scan is stood in for with a signed session, as in the others.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { attachSession } from "../../src/lib/session";
import { ensureHumanProfileOnChain } from "../../src/lib/facilityContract";
import { getAgentPrivateKey } from "../../src/lib/agentKeys";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const PREMIUM = process.env.NEXT_PUBLIC_X402_RESOURCE_BASE || "http://localhost:4402";
const HUMAN = "0x" + crypto.randomBytes(32).toString("hex");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-mcp-"));

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
const indent = (s: string) => s.split("\n").map((l) => `        │ ${l}`).join("\n");

async function main() {
  console.log(`\nhuman ${HUMAN}\nagent home ${HOME}\n`);
  await ensureHumanProfileOnChain(HUMAN);
  const cookie = `lifeline_session=${attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value}`;
  const human = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${APP}${route}`, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.resolve(__dirname, "../../../mcp/server.ts")],
    env: { ...(process.env as Record<string, string>), LIFELINE_URL: APP, LIFELINE_HOME: HOME, LIFELINE_AGENT_NAME: "e2e-claude" },
    stderr: "ignore",
  });
  const client = new Client({ name: "lifeline-e2e", version: "0.0.0" });
  await client.connect(transport);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join("\n") as string, isError: !!r.isError };
  };
  const creds = () => JSON.parse(fs.readFileSync(path.join(HOME, "credentials.json"), "utf8"))[APP];

  try {
    console.log("The server\n");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check("lists its tools", ["lifeline_status", "lifeline_catalogue", "lifeline_quote", "lifeline_buy", "lifeline_repay"].every((n) => names.includes(n)), names.join(", "));

    console.log("\n1. An agent with nothing\n");
    const first = await tool("lifeline_status");
    console.log(indent(first.text));
    const link = first.text.match(/https?:\/\/\S+\/connect\/([A-Z0-9]+)/);
    check("is told it is not connected, and given a link for its human", !!link && /ACTION NEEDED/.test(first.text));
    const code = link![1];
    const early = await tool("lifeline_buy", { url: `${PREMIUM}/premium-data` });
    check("cannot buy before the human approves", !/PAID/.test(early.text) && /ACTION NEEDED/.test(early.text));
    const again = await tool("lifeline_status");
    check("asking again reuses the same request", again.text.includes(code));

    console.log("\n2. The human approves\n");
    const anon = await fetch(`${APP}/api/agent/connect/${code}`);
    check("the request is not readable without signing in", anon.status === 401, `${anon.status}`);
    const seen = await human("GET", `/api/agent/connect/${code}`);
    check("the connect page shows who is asking", seen.status === 200 && seen.body.name === "e2e-claude" && seen.body.status === "pending", `arc headroom $${seen.body.headroom?.arc}`);
    const ok = await human("POST", `/api/agent/connect/${code}`, { action: "approve", rail: "arc", capUsd: 1, days: 1 });
    check("approving makes the agent a wallet, authorised on chain", ok.status === 200 && ok.body.authorizedOnChain === true, ok.body.agent?.address ?? ok.body.error);
    const twice = await human("POST", `/api/agent/connect/${code}`, { action: "approve" });
    check("a second approval mints nothing", twice.status === 409);

    const secret: string = creds().pending.secret;
    const status = await tool("lifeline_status");
    console.log(indent(status.text));
    check("the agent picks up its access by itself", /Connected to Lifeline/.test(status.text) && status.text.includes(ok.body.agent.address));
    const mode = fs.statSync(path.join(HOME, "credentials.json")).mode & 0o777;
    check("its credentials are stored owner-only", mode === 0o600, mode.toString(8));
    const token: string = creds().connected.token;
    const key = getAgentPrivateKey(ok.body.agent.address);
    const stored = fs.readFileSync(path.join(HOME, "credentials.json"), "utf8");
    check("the wallet's key stays with Lifeline, not the agent", !!key && !stored.includes(key.slice(2)) && !/privateKey/i.test(stored));
    const replay: any = await fetch(`${APP}/api/agent/connect/${code}`, { headers: { Authorization: `Bearer ${secret}` } }).then((r) => r.json());
    check("the mandate is handed out once", replay.status === "collected" && !replay.token, replay.status);

    console.log("\n3. Spending\n");
    const cat = await tool("lifeline_catalogue");
    console.log(indent(cat.text));
    check("sees what is for sale", /premium-data/.test(cat.text));
    const q = await tool("lifeline_quote", { url: `${PREMIUM}/premium-data` });
    console.log(indent(q.text));
    check("quotes without paying", /wants payment/.test(q.text));
    const tooDear = await tool("lifeline_buy", { url: `${PREMIUM}/risk-curve`, maxUsd: 0.1 });
    check("refuses a price over its own limit, before paying", tooDear.isError && /over your limit/.test(tooDear.text), tooDear.text);
    const ssrf = await tool("lifeline_buy", { url: "http://169.254.169.254/latest/meta-data" });
    check("Lifeline will not fetch a private-network URL", ssrf.isError && /private network/.test(ssrf.text), ssrf.text.split("\n")[0]);
    const flagged = await tool("lifeline_buy", { url: `${PREMIUM}/unvetted` });
    console.log(indent(flagged.text));
    check("Intercepta refuses the flagged seller; nothing is paid", !/^PAID/.test(flagged.text) && /Intercepta/.test(flagged.text));

    const other = await human("POST", "/api/agent/provision", { rail: "arc", label: "other-agent", capUsd: 0.5, days: 1 });
    const misuse = await fetch(`${APP}/api/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: `${PREMIUM}/premium-data`, agentAddress: other.body.agent.address }),
    });
    const misuseBody: any = await misuse.json();
    check("the mandate cannot spend through the human's other agent", misuse.status === 403 && misuseBody.code === "not_this_agent", misuseBody.code);

    const bought = await tool("lifeline_buy", { url: `${PREMIUM}/premium-data`, maxUsd: 0.05 });
    console.log(indent(bought.text));
    check("buys, on credit, and shows what it got", /^PAID/.test(bought.text) && /What it returned/.test(bought.text));
    const after = await tool("lifeline_status");
    check("its debt shows up", /owes\s+\$0\.01/.test(after.text), after.text.match(/owes.*$/m)?.[0]);

    console.log("\n4. Revoked\n");
    // An agent in debt cannot be revoked, and the first one now owes $0.01,
    // so this is a second agent: connected, approved, then revoked.
    await tool("lifeline_disconnect");
    const second = await tool("lifeline_connect", { name: "e2e-claude-2", capUsd: 0.5 });
    const code2 = second.text.match(/\/connect\/([A-Z0-9]+)/)![1];
    const ok2 = await human("POST", `/api/agent/connect/${code2}`, { action: "approve", rail: "arc", capUsd: 0.5, days: 1 });
    await tool("lifeline_status");
    const revoked = await human("DELETE", `/api/agents?address=${ok2.body.agent.address}`);
    check("the human revokes it on the dashboard", revoked.status === 200, `${revoked.status}`);
    const lost = await tool("lifeline_status");
    console.log(indent(lost.text));
    check("the agent is told its access ended", lost.isError && /no longer accepts/.test(lost.text));
    const asks = await tool("lifeline_status");
    check("and asks its human again with a new link", /ACTION NEEDED/.test(asks.text) && !asks.text.includes(code2));
    const denyCode = asks.text.match(/\/connect\/([A-Z0-9]+)/)![1];
    await human("POST", `/api/agent/connect/${denyCode}`, { action: "deny" });
    const denied = await tool("lifeline_status");
    check("a declined request is reported as declined", /DECLINED/.test(denied.text));

    console.log("\n5. On Sui\n");
    const sui = await tool("lifeline_connect", { name: "e2e-claude-sui", rail: "sui", capUsd: 0.5, replace: true });
    const suiCode = sui.text.match(/\/connect\/([A-Z0-9]+)/)![1];
    const suiOk = await human("POST", `/api/agent/connect/${suiCode}`, { action: "approve", capUsd: 0.5, days: 1 });
    check("a Sui agent is approved on the Sui line", suiOk.status === 200 && suiOk.body.agent?.rail === "sui", suiOk.body.agent?.suiAddress ?? suiOk.body.error);
    const suiStatus = await tool("lifeline_status");
    console.log(indent(suiStatus.text));
    check("it reports its Sui wallet", /Sui/.test(suiStatus.text) && !!suiOk.body.agent?.suiAddress && suiStatus.text.includes(suiOk.body.agent.suiAddress));
    const suiCat = await tool("lifeline_catalogue");
    const suiUrl = suiCat.text.match(/https?:\/\/\S+\/risk\?records=1\b/)?.[0];
    check("sees the Sui seller's catalogue", !!suiUrl, suiUrl ?? suiCat.text.split("\n")[0]);
    if (suiUrl) {
      const suiBuy = await tool("lifeline_buy", { url: suiUrl, maxUsd: 0.01 });
      console.log(indent(suiBuy.text));
      check("buys on Sui, on credit, with a repayment parked on chain", /^PAID/.test(suiBuy.text) && /repay due/.test(suiBuy.text));
    }
  } finally {
    await client.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("\ne2e failed:", err);
  process.exit(1);
});
