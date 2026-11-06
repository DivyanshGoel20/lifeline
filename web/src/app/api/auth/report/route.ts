import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { readAuthReports, recordAuthFailure } from "@/lib/authReports";
import { allow, clientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** The sign-in screens report where they failed. Short text only, and rate limited. */
export async function POST(req: NextRequest) {
  if (!allow(`auth-report:${clientIp(req)}`, 30, 10 * 60_000)) return NextResponse.json({ ok: false }, { status: 429 });
  const { step, code, detail } = await req.json().catch(() => ({} as any));
  recordAuthFailure({ step: `client:${typeof step === "string" ? step : "unknown"}`, code, detail });
  return NextResponse.json({ ok: true });
}

/** For the operator, with LIFELINE_CRON_SECRET. */
export async function GET(req: NextRequest) {
  const secret = process.env.LIFELINE_CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ reports: readAuthReports() });
}
