import { NextRequest, NextResponse } from "next/server";
import { unauthenticated } from "@/lib/session";
import { hasCredential, resolveSpender } from "@/lib/agentToken";
import { getAgentByAddress } from "@/lib/agentStore";
import { isJarToken, JAR_TOKENS, jarConfigured, jarSummary, quoteCredit, repayWithToken } from "@/lib/lifelineJar";
import { invalidateTelemetryCache } from "@/lib/telemetryCache";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The Token Jar: what is in it, or what an amount of a token would pay off. Public. */
export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams;
  const token = p.get("token");
  const amount = p.get("amount");
  try {
    if (token || amount) {
      if (!jarConfigured()) return NextResponse.json({ configured: false });
      if (!isJarToken(token) || !amount) {
        return NextResponse.json({ error: `token must be one of ${Object.keys(JAR_TOKENS).join(", ")}, with an amount.` }, { status: 400 });
      }
      return NextResponse.json({ configured: true, ...(await quoteCredit(token, amount)) });
    }
    return NextResponse.json({ supported: Object.keys(JAR_TOKENS), ...(await jarSummary()) });
  } catch (err: any) {
    return NextResponse.json({ error: err?.shortMessage ?? err?.message ?? "Could not read the jar" }, { status: 502 });
  }
}

/** Repay Arc debt with a token the agent holds on Base. */
export async function POST(req: NextRequest) {
  if (!hasCredential(req)) return unauthenticated();
  const { agentAddress, token, amount } = await req.json().catch(() => ({} as any));
  if (!agentAddress || !isJarToken(token) || typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
    return NextResponse.json({ success: false, error: `agentAddress, an amount as a string, and a token (${Object.keys(JAR_TOKENS).join(", ")}) are required.` }, { status: 400 });
  }
  const auth = resolveSpender(req, agentAddress, "arc");
  if ("error" in auth) return auth.error;
  const agent = getAgentByAddress(agentAddress);
  if (!agent) return NextResponse.json({ success: false, error: "Agent not found." }, { status: 404 });

  try {
    const done = await repayWithToken({ human: auth.spender.human, agent, token, amount });
    invalidateTelemetryCache(auth.spender.human);
    return NextResponse.json({ success: true, ...done });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.shortMessage ?? err?.message ?? "The repayment failed" }, { status: 502 });
  }
}
