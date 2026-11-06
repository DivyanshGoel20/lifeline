import { NextRequest, NextResponse } from "next/server";
import { unauthenticated } from "@/lib/session";
import { resolveReader } from "@/lib/agentToken";
import { suiStatus } from "@/lib/suiRail";

/**
 * What a resource server is selling.
 * Returns the active catalogue of x402 pay-per-call services: `?rail=sui` for
 * the Sui seller, otherwise Arc's (port 4402 if running, else /api/paid).
 * Readable with a session or a mandate.
 */
export async function GET(req: NextRequest) {
  if (!resolveReader(req)) return unauthenticated();

  if (new URL(req.url).searchParams.get("rail") === "sui") {
    try {
      const s = await suiStatus();
      return NextResponse.json({ rail: "sui", base: "base" in s ? s.base : null, resources: s.resources ?? [] });
    } catch (err: any) {
      return NextResponse.json({ rail: "sui", base: null, resources: [], reason: err?.message });
    }
  }

  const base = process.env.NEXT_PUBLIC_X402_RESOURCE_BASE || "http://localhost:4402";

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/catalogue`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.resources) && data.resources.length > 0) {
        return NextResponse.json({
          rail: "arc",
          base,
          resources: data.resources,
        });
      }
    }
  } catch {}

  // Native internal catalogue fallback
  const appBase = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return NextResponse.json({
    rail: "arc",
    base: appBase,
    resources: [
      { path: "/api/paid/signal", price: 0.01, title: "Alpha Signal Intelligence", artifact: "json" },
      { path: "/api/paid/risk-curve", price: 0.2, title: "Exposure curve · 30d", artifact: "svg" },
      { path: "/api/paid/dossier", price: 0.45, title: "Underwriting dossier", artifact: "svg" },
      { path: "/api/paid/unvetted", price: 0.01, title: "Unvetted feed", artifact: "json" },
      { path: "/api/paid/lookalike", price: 0.01, title: "Discount feed (pays in \"USDC\")", artifact: "json" },
    ],
  });
}
