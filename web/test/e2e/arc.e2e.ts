/**
 * The Arc rail, end to end, against a running app and the live testnet.
 *
 *   npm run dev            # in one terminal
 *   npm run premium        # in another
 *   npm run e2e:arc        # here
 *
 * World ID cannot be scripted - it needs a phone - so the harness stands in for
 * the one step it replaces: it provisions the human's profile exactly as the
 * verify route does and mints the same signed session cookie. Everything after
 * that goes through the app's HTTP API and settles on Arc for real.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { attachSession } from "../../src/lib/session";
import { createWalletClient, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnetChain,
  ensureHumanProfileOnChain,
  getArcTransport,
  getOnChainProfile,
  getPublicClient,
} from "../../src/lib/facilityContract";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const PREMIUM = process.env.NEXT_PUBLIC_X402_RESOURCE_BASE || "http://localhost:4402";
const HUMAN = process.env.E2E_HUMAN || "0x" + crypto.randomBytes(32).toString("hex");

/** Native USDC from Lifeline's operator to the agent: the customer, played by the demo. */
async function payAgent(to: `0x${string}`, usdc: number): Promise<string> {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain: arcTestnetChain, transport: getArcTransport() });
  const hash = await wallet.sendTransaction({ to, value: parseUnits(usdc.toFixed(6), 18) });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log(`\nhuman ${HUMAN}\n`);

  const profile = await ensureHumanProfileOnChain(HUMAN);
  check("credit profile on Arc", true, profile.txHash ?? "(already existed)");

  const token = attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value;
  const cookie = `lifeline_session=${token}`;

  const call = async (method: string, route: string, body?: unknown, auth = true) => {
    const res = await fetch(`${APP}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const session = await call("GET", "/api/auth/session");
  check("session names the human", session.body.nullifierHash === HUMAN);

  const anon = await call("POST", "/api/borrow", { agentAddress: "0x" + "1".repeat(40), amount: 0.01 }, false);
  check("borrowing without a session is refused", anon.status === 401, `status ${anon.status}`);

  const provisioned = await call("POST", "/api/agent/provision", { label: "e2e-arc", capUsd: 8 });
  const agent = provisioned.body.agent?.address as string;
  check("agent provisioned", provisioned.status === 200 && !!agent, agent);
  check("agent authorised on the facility", provisioned.body.authorizedOnChain === true, provisioned.body.authorizationError ?? "");

  const borrow = await call("POST", "/api/borrow", { agentAddress: agent, amount: 0.1, memo: "e2e" });
  check("direct drawdown", borrow.status === 200 && borrow.body.success, borrow.body.txHash ?? borrow.body.error);

  const over = await call("POST", "/api/borrow", { agentAddress: agent, amount: 50 });
  check("drawdown beyond the line is refused", over.status >= 400, over.body.error ?? "");

  const catalogue = await call("GET", "/api/x402/catalogue");
  check("catalogue lists resources", (catalogue.body.resources ?? []).length > 0, catalogue.body.base);

  // The drawdown above landed in the agent's own Gateway balance, so cent
  // purchases are paid by the agent and owe nothing. The dollar one is more
  // than it holds, and Lifeline covers the shortfall on credit.
  const purchases: [string, string][] = [
    [`${APP}/api/paid/signal`, "AGENT_GATEWAY"],
    [`${PREMIUM}/premium-data`, "AGENT_GATEWAY"],
    [`${APP}/api/paid/risk-curve`, "LIFELINE_FACILITY"],
  ];
  for (const [url, expected] of purchases) {
    const paid = await call("POST", "/api/pay", { url, agentAddress: agent });
    check(
      `x402 ${new URL(url).pathname} paid by ${expected}`,
      paid.status === 200 && paid.body.success && paid.body.fundingSource === expected,
      paid.body.success
        ? `${paid.body.fundingSource} borrowed ${paid.body.borrowed} settlement ${paid.body.transactionId ?? "-"}`
        : paid.body.error
    );
  }

  const forged = await fetch(`${APP}/api/paid/dossier`, {
    headers: { "payment-signature": Buffer.from("{}").toString("base64") },
  });
  check("an empty payment header buys nothing", forged.status !== 200, `status ${forged.status}`);

  // Well-formed, on the right network, signed by nobody: the facilitator has
  // to be the one that says no.
  const quote = await fetch(`${APP}/api/paid/dossier`);
  const accepted = JSON.parse(
    Buffer.from(quote.headers.get("payment-required") || "", "base64").toString()
  ).accepts[0];
  const unsigned = await fetch(`${APP}/api/paid/dossier`, {
    headers: {
      "payment-signature": Buffer.from(
        JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x" + "00".repeat(65) } })
      ).toString("base64"),
    },
  });
  check("an unsigned Arc payment buys nothing", unsigned.status !== 200, `status ${unsigned.status}`);

  const agents = await call("GET", "/api/agents");
  const mine = (agents.body.agents ?? []).find((a: any) => a.address.toLowerCase() === agent.toLowerCase());
  check("agent carries the debt", !!mine && mine.outstandingDebt > 0.25, `owes ${mine?.outstandingDebt}`);

  const payments = await call("GET", "/api/payments");
  check("payments recorded", (payments.body.payments ?? []).length >= 3, `${payments.body.payments?.length ?? 0} rows`);

  const telemetry = await call("GET", "/api/contract-telemetry");
  check("telemetry reads the facility", telemetry.status === 200, telemetry.body.contract?.address ?? "");

  // The agent repays out of its own wallet, which is empty: everything it has
  // is in Gateway. Stand in for a customer paying it for its work.
  const owed = mine?.outstandingDebt ?? 0;
  const earnings = await payAgent(agent as `0x${string}`, owed + 0.05);
  check("agent earned enough to repay", true, earnings);

  const repay = await call("POST", "/api/repay", { agentAddress: agent, amount: owed });
  check("repayment booked on Arc", repay.status === 200 && repay.body.success, repay.body.txHash ?? repay.body.error);

  const onChain = await getOnChainProfile(HUMAN);
  check("facility shows the debt cleared", Number(onChain?.outstandingDebt ?? 1) === 0, `outstanding ${onChain?.outstandingDebt}`);

  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
