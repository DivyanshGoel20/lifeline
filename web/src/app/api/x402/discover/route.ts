import { NextRequest, NextResponse } from "next/server";
import { unauthenticated } from "@/lib/session";
import { resolveReader } from "@/lib/agentToken";
import { discoverServices } from "@/lib/discovery";

export const dynamic = "force-dynamic";

/**
 * Real services an agent can buy on credit: Circle's marketplace, narrowed to
 * sellers Lifeline can pay on Arc and ranked by how they have delivered.
 * Readable with a session or a mandate.
 */
export async function GET(req: NextRequest) {
  if (!resolveReader(req)) return unauthenticated();

  const p = new URL(req.url).searchParams;
  const maxUsd = p.get("maxUsd");
  const limit = p.get("limit");
  const parsedMax = maxUsd === null ? undefined : Number(maxUsd);
  const parsedLimit = limit === null ? undefined : Number(limit);
  if ((parsedMax !== undefined && !(parsedMax >= 0)) || (parsedLimit !== undefined && !(parsedLimit > 0))) {
    return NextResponse.json({ error: "maxUsd and limit must be positive numbers." }, { status: 400 });
  }

  try {
    const found = await discoverServices({
      query: p.get("query") ?? undefined,
      category: p.get("category") ?? undefined,
      maxUsd: parsedMax,
      limit: parsedLimit,
    });
    return NextResponse.json({ network: "Arc Testnet (5042002)", ...found });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "The marketplace did not answer", services: [] }, { status: 502 });
  }
}
