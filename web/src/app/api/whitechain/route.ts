import { NextRequest, NextResponse } from "next/server";
import { getHuman, unauthenticated } from "@/lib/session";
import { hasCredential, resolveSpender } from "@/lib/agentToken";
import { recordMandateSpend } from "@/lib/mandateSpend";
import { getAgentsByOwner } from "@/lib/agentStore";
import { WC_EXPLORER, WC_NETWORK, WC_USDT, wcConfigured, wcFacilityAddress } from "@/lib/whitechain/config";
import { WC_ITEMS } from "@/lib/whitechain/catalogue";
import { relayerStatus } from "@/lib/whitechain/facilitator";
import { agentUsdt, payAgentForWork, repayOnWhitechain, buyOnWhitechain, wcDebts, wcLine } from "@/lib/whitechain/credit";
import { merchantReceipts } from "@/lib/whitechain/seller";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const appOrigin = (req: NextRequest) => (process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/$/, "");
/** Agents hold one EVM key, so an Arc agent's wallet also works here. Sui agents do not. */
const evmAgents = (human: string) => getAgentsByOwner(human).filter((a) => (a.rail ?? "arc") === "arc");

/** ?view=merchant is public, as the relayer's status is. Otherwise it is the human's own line. */
export async function GET(req: NextRequest) {
  const shared = { configured: wcConfigured(), network: WC_NETWORK, usdt: WC_USDT, facility: wcFacilityAddress(), explorer: WC_EXPLORER };
  if (new URL(req.url).searchParams.get("view") === "merchant") {
    const receipts = merchantReceipts();
    return NextResponse.json({
      ...shared,
      relayer: await relayerStatus(),
      receipts: receipts.slice(0, 50),
      totalUsd: Math.round(receipts.reduce((n, r) => n + r.amountUsd, 0) * 1e6) / 1e6,
    });
  }

  const human = getHuman(req);
  if (!human) return unauthenticated();
  const agents = await Promise.all(
    evmAgents(human).map(async (a) => ({ address: a.address, name: a.name, usdt: await agentUsdt(a.address).catch(() => null) }))
  );
  const { open, ...line } = wcLine(human);
  return NextResponse.json({
    ...shared,
    line,
    agents,
    debts: wcDebts(human).slice(-20).reverse(),
    catalogue: Object.entries(WC_ITEMS).map(([id, item]) => ({ id, ...item, url: `${appOrigin(req)}/api/whitechain/paid/${id}` })),
  });
}

/** What a signed-in human can do: buy for an agent, repay, or (testnet) pay an agent for its work. */
export async function POST(req: NextRequest) {
  if (!hasCredential(req)) return unauthenticated();
  const { action, agentAddress, url, amountUsd } = await req.json().catch(() => ({} as any));

  // A browser session, or an agent's own mandate: the same check as the other rails.
  const auth = resolveSpender(req, String(agentAddress ?? ""), "arc");
  if ("error" in auth) return auth.error;
  const { human, capUsd, mandateId, via } = auth.spender;

  const agent = evmAgents(human).find((a) => a.address.toLowerCase() === String(agentAddress ?? "").toLowerCase());
  if (!agent) return NextResponse.json({ success: false, error: "That is not one of your agents." }, { status: 404 });

  try {
    if (action === "buy") {
      // Only this app's own merchant: this request makes the server fetch the URL.
      const origin = appOrigin(req);
      if (typeof url !== "string" || !url.startsWith(`${origin}/api/whitechain/paid/`)) {
        return NextResponse.json({ success: false, error: "That is not one of this merchant's items." }, { status: 400 });
      }
      const bought = await buyOnWhitechain({ human, agent: agent.address, url, maxCreditUsd: capUsd });
      if (bought.borrowedUsd > 0) recordMandateSpend(mandateId, bought.borrowedUsd);
      return NextResponse.json({ success: true, ...bought });
    }
    if (action === "repay") {
      const amount = amountUsd === undefined ? undefined : Number(amountUsd);
      if (amount !== undefined && !(amount > 0)) return NextResponse.json({ success: false, error: "amountUsd must be positive." }, { status: 400 });
      return NextResponse.json({ success: true, ...(await repayOnWhitechain({ human, agent: agent.address, amountUsd: amount })) });
    }
    if (action === "earn") {
      if (via !== "session") return NextResponse.json({ success: false, error: "Only the human can do that." }, { status: 403 });
      return NextResponse.json({ success: true, txHash: await payAgentForWork(agent.address, 0.5) });
    }
    return NextResponse.json({ success: false, error: "action must be buy, repay or earn." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.shortMessage ?? err?.message ?? "Whitechain refused that." }, { status: 502 });
  }
}
