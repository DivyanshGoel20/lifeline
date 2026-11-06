import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAllAgents } from "@/lib/agentStore";
import { enforceStanding, standingHumans } from "@/lib/standing";
import { reconcileSui, suiConfigured } from "@/lib/suiRail";
import { seizeCollateral, vaultAddress } from "@/lib/securedLine";

export const dynamic = "force-dynamic";

/**
 * Check every human's standing and act on it - suspend, default, restore.
 * For a scheduled job (a Railway cron), with LIFELINE_CRON_SECRET as a
 * bearer token. Sui parked repayments that fell due are collected first.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.LIFELINE_CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok =
    !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "Not allowed." }, { status: 401 });

  const sui = suiConfigured() ? await reconcileSui().catch((err) => ({ error: String(err?.message ?? err) })) : null;
  const humans = new Set([...getAllAgents().map((a) => a.humanOwner).filter(Boolean), ...standingHumans()]);
  const changed: { human: string; arc: string; sui: string }[] = [];
  const seized: unknown[] = [];
  for (const h of humans) {
    const r = await enforceStanding(h).catch(() => null);
    if (r && (r.arc.status !== "good" || r.sui.status !== "good")) {
      changed.push({ human: `${h.slice(0, 10)}…`, arc: r.arc.status, sui: r.sui.status });
    }
    // In default with a deposit: the deposit pays first. Anyone could call this
    // on chain; the sweep just means nobody has to.
    if (r?.arc.status === "defaulted" && vaultAddress()) {
      const s = await seizeCollateral(h).catch((err) => ({ error: String(err?.message ?? err), takenUsd: 0 }));
      if (s.takenUsd > 0 || "error" in s) seized.push({ human: `${h.slice(0, 10)}…`, ...s });
    }
  }
  return NextResponse.json({ checked: humans.size, notGood: changed, seized, sui });
}

/** Vercel's cron calls with GET, and the same bearer token. */
export const GET = POST;
