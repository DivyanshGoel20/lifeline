/**
 * World ID for Agents, live - with a person holding the sandbox World ID app.
 *
 *   WORLD_AGENTS_CLIENT_ID / _SECRET in .env (portal: sandbox.auth.world.org/portal)
 *   npm run dev · npm run premium
 *   npm run e2e:world-agents            # approve in the app when asked
 *   npm run e2e:world-agents -- --deny  # deny it instead: nothing may be paid
 *
 * The script plays the agent. It holds only a mandate token - it cannot
 * approve anything itself. It buys a $0.45 report, is held, asks Lifeline for
 * its human's approval, and prints the code and link for that human. The
 * human answers in the World ID app; the script shows what happened.
 *
 * Only the IDKit sign-in is stood in for (the signed session cookie, as in
 * every other harness). The World ID for Agents link and approval are real.
 */
import crypto from "node:crypto";
import QRCode from "qrcode";
import { NextResponse } from "next/server";
import { attachSession } from "../../src/lib/session";
import { ensureHumanProfileOnChain } from "../../src/lib/facilityContract";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const PREMIUM = process.env.NEXT_PUBLIC_X402_RESOURCE_BASE || "http://localhost:4402";
const HUMAN = process.env.E2E_HUMAN || "0x" + crypto.randomBytes(32).toString("hex");
const DENY = process.argv.includes("--deny");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(headers: Record<string, string>) {
  return async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${APP}${route}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
}

async function ask(who: string, v: { userCode: string; verificationUriComplete: string }) {
  console.log(`\n  ${who}: open this in the World ID sandbox app, or scan it, and check the code.\n`);
  console.log(await QRCode.toString(v.verificationUriComplete, { type: "terminal", small: true }));
  console.log(`  ${v.verificationUriComplete}\n  code ${v.userCode}\n`);
}

async function waitFor(poll: () => Promise<any>, done: (b: any) => boolean) {
  for (let i = 0; i < 240; i++) {
    const r = await poll();
    if (done(r.body)) return r.body;
    process.stdout.write(".");
    await sleep(5000);
  }
  throw new Error("timed out");
}

async function main() {
  if (!process.env.WORLD_AGENTS_CLIENT_ID) throw new Error("Set WORLD_AGENTS_CLIENT_ID and WORLD_AGENTS_CLIENT_SECRET in .env");

  console.log(`\nhuman ${HUMAN}${DENY ? "   (deny run)" : ""}\n`);
  await ensureHumanProfileOnChain(HUMAN);
  const human = client({ cookie: `lifeline_session=${attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value}` });

  // Once per account: the human links World ID for Agents while signed in.
  let link = await human("GET", "/api/auth/world-agents/link");
  if (!link.body.linked) {
    const started = await human("POST", "/api/auth/world-agents/link");
    check("linking World ID for Agents starts", started.body.success && !!started.body.userCode, started.body.error);
    await ask("Link World ID for Agents to this Lifeline account", started.body);
    link.body = await waitFor(() => human("GET", "/api/auth/world-agents/link"), (b) => b.linked || (b.status && b.status !== "pending"));
    console.log("");
  }
  check("World ID for Agents is linked to the account", link.body.linked === true, link.body.reason ?? "");
  if (!link.body.linked) return finish();

  // The agent: a mandate token and nothing else.
  const agent = (await human("POST", "/api/agent/provision", { label: "e2e-world-agents", capUsd: 8 })).body.agent?.address as string;
  const token = (await human("POST", "/api/agent-token", { capUsd: 8, days: 1, label: "e2e agent" })).body.token as string;
  const asAgent = client({ authorization: `Bearer ${token}` });

  const held = await asAgent("POST", "/api/pay", { url: `${PREMIUM}/dossier`, agentAddress: agent });
  check("the agent's $0.45 purchase is held for its human", held.status === 202 && !!held.body.hold?.holdId, held.body.screening?.reasons?.[0] ?? held.body.error);
  const holdId = held.body.hold?.holdId;
  if (!holdId) return finish();

  const selfApprove = await asAgent("POST", `/api/pay/holds/${holdId}`, { action: "approve" });
  check("the agent cannot approve its own held payment", selfApprove.status === 401, `status ${selfApprove.status}`);
  const click = await human("POST", `/api/pay/holds/${holdId}`, { action: "approve" });
  check("nor can the human's session alone", click.status === 403 && click.body.code === "world_id_required", click.body.error);

  const requested = await asAgent("POST", `/api/pay/holds/${holdId}/approval`);
  check("the agent asks for its human's World ID approval", requested.body.success && !!requested.body.userCode, requested.body.error);
  await ask(DENY ? "Human: DENY this in World ID" : "Human: approve this $0.45 payment in World ID", requested.body);

  const outcome = await waitFor(
    () => asAgent("GET", `/api/pay/holds/${holdId}/approval`),
    (b) => (b.status === "approved" && !!b.payment) || (b.status && !["pending", "approved"].includes(b.status))
  );
  console.log("");

  const holds = (await human("GET", "/api/pay/holds")).body.holds ?? [];
  if (DENY) {
    check("denied in World ID", outcome.status === "denied", outcome.reason);
    check("and nothing was paid", !outcome.payment);
    check("the hold is declined", !holds.some((h: any) => h.holdId === holdId));
  } else {
    check("approved with a fresh World ID proof", outcome.status === "approved", outcome.reason ?? "");
    check("then released: screened again and paid on credit", outcome.payment?.success === true && outcome.payment?.screening?.approvedByHuman === true,
      outcome.payment?.error ?? `lent $${outcome.payment?.borrowed} · settled ${outcome.payment?.circleSettlementId ?? outcome.payment?.transactionId}`);
    const again = await asAgent("GET", `/api/pay/holds/${holdId}/approval`);
    check("polling again does not pay twice", again.body.payment?.transactionId === outcome.payment?.transactionId);
  }
  finish();
}

function finish() {
  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
