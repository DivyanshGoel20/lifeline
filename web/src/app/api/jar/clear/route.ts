import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { clearJar } from "@/lib/lifelineJar";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Lifeline's keeper clears the jar when it is worth it. For a scheduled job, with LIFELINE_CRON_SECRET. */
export async function POST(req: NextRequest) {
  const secret = process.env.LIFELINE_CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  try {
    return NextResponse.json(await clearJar());
  } catch (err: any) {
    return NextResponse.json({ cleared: false, error: err?.shortMessage ?? err?.message ?? "Could not clear the jar" }, { status: 502 });
  }
}

export const GET = POST;
