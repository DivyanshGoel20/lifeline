import { NextRequest, NextResponse } from "next/server";
import { unauthenticated } from "@/lib/session";
import { hasCredential, resolveSpender } from "@/lib/agentToken";
import { getAgentByAddress } from "@/lib/agentStore";
import { BRIDGE_CHAINS, isBridgeChain, repayFromOtherChain } from "@/lib/crosschainRepay";
import { invalidateTelemetryCache } from "@/lib/telemetryCache";

export const dynamic = "force-dynamic";
// A bridge waits on two chains.
export const maxDuration = 300;

/** Repay Arc debt from USDC the agent holds on another chain. */
export async function POST(req: NextRequest) {
  if (!hasCredential(req)) return unauthenticated();
  const { agentAddress, fromChain, amountUsd } = await req.json().catch(() => ({} as any));
  const amount = Number(amountUsd);

  if (!agentAddress || !(amount > 0)) {
    return NextResponse.json({ success: false, error: "agentAddress and a positive amountUsd are required." }, { status: 400 });
  }
  if (!isBridgeChain(fromChain)) {
    return NextResponse.json({ success: false, error: `fromChain must be one of: ${BRIDGE_CHAINS.join(", ")}.` }, { status: 400 });
  }

  const auth = resolveSpender(req, agentAddress, "arc");
  if ("error" in auth) return auth.error;
  const agent = getAgentByAddress(agentAddress);
  if (!agent) return NextResponse.json({ success: false, error: "Agent not found." }, { status: 404 });

  try {
    const done = await repayFromOtherChain({ human: auth.spender.human, agent, from: fromChain, amountUsd: amount });
    invalidateTelemetryCache(auth.spender.human);
    return NextResponse.json({ success: true, ...done });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? "The cross-chain repayment failed", steps: err?.steps }, { status: 502 });
  }
}
