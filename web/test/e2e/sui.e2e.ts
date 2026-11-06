/**
 * The Sui rail through the app, end to end.
 *
 *   npm run sui:service    # the Sui x402 feed
 *   npm run dev            # the app, with SUI_NETWORK and SUI_PRIVATE_KEY set
 *   npm run e2e:sui
 *
 * Like the Arc harness, it stands in only for the World ID scan: it mints the
 * signed session the verify route would. Everything else goes through the
 * app's HTTP API and settles on Sui for real.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { attachSession } from "../../src/lib/session";
import { ensureHumanProfileOnChain } from "../../src/lib/facilityContract";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const FEED = process.env.SUI_SERVICE_URL || "http://localhost:4031";
const HUMAN = "0x" + crypto.randomBytes(32).toString("hex");
const STRANGER = "0x" + crypto.randomBytes(32).toString("hex");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const cookieFor = (human: string) =>
  `lifeline_session=${attachSession(NextResponse.json({}), human).cookies.get("lifeline_session")!.value}`;

function client(headers: Record<string, string>) {
  return async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${APP}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
}

async function main() {
  console.log(`\nhuman ${HUMAN}\n`);
  await ensureHumanProfileOnChain(HUMAN);
  const call = client({ cookie: cookieFor(HUMAN) });
  const stranger = client({ cookie: cookieFor(STRANGER) });

  const status = await call("GET", "/api/sui/status");
  check("the Sui rail is configured", status.body.configured === true, `${status.body.network} ${status.body.facilityId}`);
  check("the Sui feed is up and listed", status.body.sellerUp === true && status.body.resources.length > 0);

  const anon = await client({})("POST", "/api/sui/pay", { url: `${FEED}/risk`, agentAddress: "0x" + "1".repeat(40) });
  check("paying on Sui without a session is refused", anon.status === 401, `status ${anon.status}`);

  const provisioned = await call("POST", "/api/agent/provision", { label: "e2e-sui", capUsd: 8, rail: "sui" });
  const agent = provisioned.body.agent?.address as string;
  check("provisioning returns the agent's Sui address", /^0x[0-9a-f]{64}$/.test(provisioned.body.agent?.suiAddress ?? ""), provisioned.body.agent?.suiAddress);

  const bought = await call("POST", "/api/sui/pay", { url: `${FEED}/risk?records=4`, agentAddress: agent });
  check(
    "a broke agent buys on credit",
    bought.status === 200 && bought.body.fundingSource === "LIFELINE_CREDIT" && bought.body.borrowed === "0.020000",
    bought.body.error ?? `obligation ${bought.body.obligationId} tx ${bought.body.digest}`
  );
  check("the seller was paid and the records delivered", Array.isArray(bought.body.data?.records) && bought.body.data.records.length === 4);

  const agents = await call("GET", "/api/agents");
  const mine = agents.body.agents?.find((a: any) => a.address.toLowerCase() === agent.toLowerCase());
  check("the dashboard sees the agent's Sui debt", mine?.suiDebt === 0.02, `suiDebt ${mine?.suiDebt}`);

  // Separate lines and separate agents: what Sui drew is Sui's alone, Arc's
  // line is whole, and a Sui agent cannot be spent on Arc.
  const arcAgent = (await call("POST", "/api/agent/provision", { label: "e2e-sui-arc", capUsd: 8 })).body.agent?.address as string;
  const credit = await call("GET", `/api/agent/credit?agentAddress=${arcAgent}`);
  const available = credit.body.humanFacility?.totalAvailableCredit;
  check("Arc's line is untouched by what Sui drew", available === 0.5, `Arc available ${available}`);
  const crossed = await call("POST", "/api/borrow", { agentAddress: agent, amount: 0.5 });
  check("a Sui agent cannot borrow on Arc", crossed.status === 400 && crossed.body.code === "wrong_rail", crossed.body.error);

  const obligations = await call("GET", "/api/sui/obligations");
  const ob = obligations.body.obligations?.[0];
  check("the parked repayment is listed from chain", ob?.status === "open" && ob?.owedUsd === 0.02, `due ${ob?.dueMs ? new Date(ob.dueMs).toISOString() : "?"}`);

  const theirs = await stranger("GET", "/api/sui/obligations");
  check("another human sees none of it", (theirs.body.obligations ?? []).length === 0);
  const theirSettle = await stranger("POST", "/api/sui/settle", { obligationId: ob?.obligationId });
  check("another human cannot settle it", theirSettle.status === 400, theirSettle.body.error);

  const token = await call("POST", "/api/agent-token", { capUsd: 0.004, days: 1, label: "tiny" });
  const mandate = client({ authorization: `Bearer ${token.body.token}` });
  const overCap = await mandate("POST", "/api/sui/pay", { url: `${FEED}/risk?records=2`, agentAddress: agent });
  check("a mandate's cap binds on Sui", overCap.status === 400 && /exceeds/i.test(overCap.body.error ?? ""), overCap.body.error);
  const mandateSettle = await mandate("POST", "/api/sui/settle", { obligationId: ob?.obligationId });
  check("a mandate cannot settle debts", mandateSettle.status === 401, `status ${mandateSettle.status}`);

  const broke = await call("POST", "/api/sui/settle", { obligationId: ob?.obligationId });
  check("settling needs the agent to hold the money", broke.status === 400 && /needs/.test(broke.body.error ?? ""), broke.body.error);

  const earned = await call("POST", "/api/sui/earn", { agentAddress: agent, amount: 0.05 });
  check("the agent is paid for its work", earned.status === 200, earned.body.digest ?? earned.body.error);

  const settled = await call("POST", "/api/sui/settle", { obligationId: ob?.obligationId });
  check("the agent settles early", settled.status === 200 && settled.body.success, settled.body.digest ?? settled.body.error);

  const after = await call("GET", "/api/sui/obligations");
  check("the obligation reads settled on chain", after.body.obligations?.[0]?.status === "settled" && after.body.owedUsd === 0);

  const selfPaid = await call("POST", "/api/sui/pay", { url: `${FEED}/risk?records=2`, agentAddress: agent });
  check("with coins of its own, it pays for itself", selfPaid.body.fundingSource === "AGENT_WALLET" && selfPaid.body.borrowed === "0.000000", selfPaid.body.digest ?? selfPaid.body.error);

  const payments = await call("GET", "/api/payments");
  const suiRows = (payments.body.payments ?? []).filter((p: any) => p.rail === "sui");
  check("both Sui purchases are on the payment trail", suiRows.length === 2, `${suiRows.length} rows`);

  const other = await call("POST", "/api/agent/provision", { label: "e2e-sui-idle", capUsd: 8, rail: "sui" });
  await call("POST", "/api/sui/pay", { url: `${FEED}/risk?records=1`, agentAddress: other.body.agent.address });
  const reconciled = await call("POST", "/api/sui/reconcile");
  check("reconciliation leaves an undue obligation open", reconciled.body.success && reconciled.body.pending === 1, JSON.stringify({ checked: reconciled.body.checked, pending: reconciled.body.pending }));

  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
