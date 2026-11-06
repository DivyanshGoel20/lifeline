import { arcTxUrl } from "@/lib/arc";
import { NextRequest, NextResponse } from "next/server";
import { fetchCompleteContractTelemetry } from "@/lib/facilityContract";
import { getAgentsByOwner } from "@/lib/agentStore";
import { getAllLoans } from "@/lib/loanStore";
import { getCachedTelemetry, setCachedTelemetry } from "@/lib/telemetryCache";
import { getPending } from "@/lib/pendingLedger";
import { resolveReader } from "@/lib/agentToken";
import { unauthenticated } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // `?human=` was believed. The dashboard passes its own nullifier and holds
    // the cookie anyway, so taking it from the session costs the caller nothing
    // and stops it naming someone else's facility.
    const reader = resolveReader(req);
    if (!reader) return unauthenticated();

    const humanOwner = reader.human;
    const cacheKey = humanOwner.toLowerCase();

    // Check recent in-memory cache to prevent Arc RPC hammering
    const cached = getCachedTelemetry(cacheKey);
    if (cached) {
      return NextResponse.json({
        ...cached,
        cached: true,
      });
    }

    // Retrieve known agents and recorded loan hashes from store to enrich telemetry
    // This human's agents only. Every agent in the system, checked on every
    // refresh, was two RPC calls apiece - the burst that got Arc's RPC
    // throttling the whole dashboard.
    const agents = getAgentsByOwner(humanOwner);
    const knownAgentAddresses = agents.map((a) => a.address);
    const recordedLoans = getAllLoans();

    const telemetry = await fetchCompleteContractTelemetry(humanOwner, knownAgentAddresses);

    // Correlate on-chain drawdowns with recorded txHashes if available
    const enrichedDrawdowns = telemetry.drawdowns.map((d: any) => {
      const matchedLoan = recordedLoans.find(
        (l) =>
          l.loanId === String(d.loanId) ||
          (l.agentAddress.toLowerCase() === d.agentAddress.toLowerCase() &&
            Math.abs(l.amount - d.amountUsdc) < 0.0001)
      );

      const txHash = matchedLoan?.borrowTxHash || undefined;
      return {
        ...d,
        txHash,
        txLink: txHash && txHash.startsWith("0x") ? arcTxUrl(txHash) : undefined,
      };
    });

    const responsePayload = {
      success: true,
      telemetry: {
        ...telemetry,
        drawdowns: enrichedDrawdowns,
        // Nanopayments booked but not yet settled on chain. Real debt the
        // operator owes, just not provable on Arc until its batch lands.
        pending: humanOwner
          ? getPending(humanOwner).map((e) => ({
              id: e.id,
              agentAddress: e.agentAddress,
              amountUsdc: e.amountUsdc,
              reference: e.reference,
              timestamp: Math.floor(e.createdAt / 1000),
              timestampIso: new Date(e.createdAt).toISOString(),
              settling: !!e.claimedAt,
            }))
          : [],
      },
      cachedAgentsCount: agents.length,
      timestamp: Date.now(),
    };

    setCachedTelemetry(cacheKey, responsePayload);

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error("[GET /api/contract-telemetry] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to fetch on-chain smart contract telemetry",
      },
      { status: 500 }
    );
  }
}
