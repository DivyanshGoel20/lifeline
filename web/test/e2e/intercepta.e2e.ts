/**
 * Intercepta in the Arc payment flow, live: real API, real mainnet risk data,
 * real Arc testnet settlement. No stand-ins.
 *
 *   INTERCEPTA_API_KEY in .env
 *   npm run dev            # the app
 *   npm run premium        # the Express seller
 *   npm run e2e:intercepta
 *
 * What it shows:
 *   1. a payment to a clean seller is screened, cleared, signed and settled
 *   2. a payment to a seller whose payee has a mainnet record is refused
 *      before anything is signed, with the reason
 *   3. a payment over the auto-approve limit is held for the human, who can
 *      decline it (or approve it, and it is screened again)
 *   4. both sellers screen the payer before settling, and refuse a flagged one
 *
 * As with the other harnesses, only the World ID scan is stood in for.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { attachSession } from "../../src/lib/session";
import { ensureHumanProfileOnChain } from "../../src/lib/facilityContract";
import { quickScan, deepScan, DEMO_RISKY_PAYTO, ARC_USDC } from "../../src/lib/intercepta";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const PREMIUM = process.env.NEXT_PUBLIC_X402_RESOURCE_BASE || "http://localhost:4402";
const HUMAN = "0x" + crypto.randomBytes(32).toString("hex");
// A flagged payer for the sellers to turn away. Override with an address from
// Intercepta's pinned test list.
const RISKY_PAYER = process.env.INTERCEPTA_DEMO_PAYER || DEMO_RISKY_PAYTO;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
const say = (v: any) => (v ? `${v.decision}: ${v.reasons?.[0] ?? ""}` : "(no verdict)");

/** A payment header claiming to come from `from`. The seller must look before it verifies. */
async function claimedFrom(url: string, from: string) {
  const quote = await fetch(url);
  const accepted = JSON.parse(Buffer.from(quote.headers.get("PAYMENT-REQUIRED")!, "base64").toString()).accepts[0];
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      payload: {
        authorization: { from, to: accepted.payTo, value: accepted.amount, validAfter: String(now - 600), validBefore: String(now + 604900), nonce: "0x" + crypto.randomBytes(32).toString("hex") },
        signature: "0x" + "00".repeat(65),
      },
    })
  ).toString("base64");
  const res = await fetch(url, { headers: { "Payment-Signature": header } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function main() {
  if (!process.env.INTERCEPTA_API_KEY) throw new Error("INTERCEPTA_API_KEY is not set in .env");

  console.log("\nIntercepta, direct\n");
  const risky = await deepScan(DEMO_RISKY_PAYTO);
  check("the demo payee has a record on mainnet", risky.data.toxicScore > 0 || risky.data.traits.length > 0,
    `score ${risky.data.toxicScore} · ${risky.data.traits.map((t) => t.name).join(", ")} · ${risky.ms}ms`);
  const quick = await quickScan(RISKY_PAYER);
  console.log(`        quick-scan ${RISKY_PAYER}: score ${quick.data.toxicScore} · ${quick.data.traits.map((t) => t.name).join(", ")}`);

  console.log(`\nhuman ${HUMAN}\n`);
  await ensureHumanProfileOnChain(HUMAN);
  const cookie = `lifeline_session=${attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value}`;
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${APP}${route}`, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };

  const agent = (await call("POST", "/api/agent/provision", { label: "e2e-intercepta", capUsd: 8 })).body.agent?.address as string;
  check("agent provisioned", !!agent, agent);

  console.log("\nThe paying agent\n");
  const cleared = await call("POST", "/api/pay", { url: `${PREMIUM}/premium-data`, agentAddress: agent });
  check("a clean seller is cleared, then paid", cleared.status === 200 && cleared.body.success && ["pay", "cap"].includes(cleared.body.screening?.decision),
    `${say(cleared.body.screening)} · settled ${cleared.body.transactionId ?? "?"}`);
  // The authorisation is scanned live every time; the payee's record may be
  // reused from a scan made seconds earlier (a five-minute cache).
  const checks = cleared.body.screening?.checks ?? [];
  const auth = checks.find((c: any) => c.subject === "authorization");
  const payee = checks.find((c: any) => c.subject === "payTo");
  check("the verdict came from live Intercepta calls", !!auth && !auth.cached && auth.ms > 0 && !!payee,
    checks.filter((c: any) => c.ms || c.cached).map((c: any) => `${c.endpoint} ${c.cached ? "cached" : `${c.ms}ms`}`).join(", "));
  check("the asset was Arc's USDC", cleared.body.screening?.checks?.some((c: any) => c.subject === "token" && c.target.toLowerCase() === ARC_USDC && c.level === "clean"));

  const refused = await call("POST", "/api/pay", { url: `${PREMIUM}/unvetted`, agentAddress: agent });
  check("a payee with a mainnet record is refused before signing", refused.status === 403 && refused.body.screening?.decision === "refuse",
    say(refused.body.screening));
  const inApp = await call("POST", "/api/pay", { url: `${APP}/api/paid/unvetted`, agentAddress: agent });
  check("the same payee behind the app's own seller is refused too", inApp.status === 403, say(inApp.body.screening));

  // A clean payee, but a quote in a lookalike USDC that Intercepta calls fake.
  const fake = await call("POST", "/api/pay", { url: `${PREMIUM}/lookalike`, agentAddress: agent });
  const tokenCheck = fake.body.screening?.checks?.find((c: any) => c.subject === "token");
  check("a quote in fake USDC is refused before signing", fake.status === 403 && fake.body.screening?.decision === "refuse", say(fake.body.screening));
  check("Intercepta names it: FAKE_TOKEN, KNOWN_MALICIOUS", ["FAKE_TOKEN", "KNOWN_MALICIOUS"].every((c) => tokenCheck?.detectors?.some((d: any) => d.code === c)),
    (tokenCheck?.detectors ?? []).map((d: any) => d.code).join(", "));
  const fakeInApp = await call("POST", "/api/pay", { url: `${APP}/api/paid/lookalike`, agentAddress: agent });
  check("the app's own fake-USDC seller is refused too", fakeInApp.status === 403, say(fakeInApp.body.screening));

  const held = await call("POST", "/api/pay", { url: `${PREMIUM}/dossier`, agentAddress: agent });
  check("a $0.45 purchase is held for the human", held.status === 202 && !!held.body.hold?.holdId, say(held.body.screening));
  const holds = await call("GET", "/api/pay/holds");
  check("the hold is listed for its human", holds.body.holds?.some((h: any) => h.holdId === held.body.hold?.holdId));
  const declined = await call("POST", `/api/pay/holds/${held.body.hold?.holdId}`, { action: "decline" });
  check("the human declines it", declined.status === 200 && declined.body.declined);
  const again = await call("POST", `/api/pay/holds/${held.body.hold?.holdId}`, { action: "approve" });
  check("a declined hold cannot then be approved", again.status === 409, again.body.error);

  const second = await call("POST", "/api/pay", { url: `${PREMIUM}/dossier`, agentAddress: agent });
  // Before the next purchase: on a small line, $0.45 fits only with nothing owed.
  const heldAgain = await call("POST", "/api/pay", { url: `${PREMIUM}/risk-curve`, agentAddress: agent });
  // $0.20 is under the $0.40 auto-approve line, so this one should simply clear.
  check("a clean $0.20 purchase on credit clears on its own", heldAgain.status === 200 && heldAgain.body.screening?.decision === "pay",
    `${say(heldAgain.body.screening)} · lent $${heldAgain.body.borrowed}`);
  const approved = await call("POST", `/api/pay/holds/${second.body.hold?.holdId}`, { action: "approve" });
  if (process.env.WORLD_AGENTS_CLIENT_ID) {
    // Releasing it takes a fresh World ID approval (npm run e2e:world-agents).
    check("a click cannot release a held payment; World ID must approve", approved.status === 403 && approved.body.code === "world_id_required", approved.body.error);
  } else {
    check("an approved hold is screened again, then paid on credit", approved.status === 200 && approved.body.success && approved.body.screening?.approvedByHuman === true,
      approved.body.error ?? `lent $${approved.body.borrowed} · settled ${approved.body.circleSettlementId ?? approved.body.transactionId}`);
  }

  const payments = await call("GET", "/api/payments");
  const statuses = (payments.body.payments ?? []).map((p: any) => p.status);
  check("refusals and holds are on the payment trail", statuses.includes("REFUSED_RISK") && statuses.includes("HELD"), statuses.join(","));

  console.log("\nThe paid service\n");
  const nextSeller = await claimedFrom(`${APP}/api/paid/signal`, RISKY_PAYER);
  check("the app's seller refuses a flagged payer before verifying", nextSeller.status === 402 && /Payer refused/.test(nextSeller.body.error ?? ""),
    nextSeller.body.reason);
  const expressSeller = await claimedFrom(`${PREMIUM}/premium-data`, RISKY_PAYER);
  check("the Express seller refuses a flagged payer before verifying", expressSeller.status === 402 && /Intercepta refuse/.test(expressSeller.body.reason ?? ""),
    expressSeller.body.reason);

  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
