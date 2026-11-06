import { NextRequest, NextResponse } from "next/server";
import { getAgentByAddress } from "@/lib/agentStore";
import { resolveAgentReader, resolveReader } from "@/lib/agentToken";
import { unauthenticated } from "@/lib/session";
import { getLoansByAgent, getLoansByHuman, getAllLoans } from "@/lib/loanStore";
import { ARC_CHAIN_ID, ARC_NAME } from "@/lib/arc";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const agentAddress =
      searchParams.get("agentAddress") ||
      searchParams.get("address") ||
      req.headers.get("x-agent-address");

    const includeShared = searchParams.get("includeShared") !== "false";
    const statusFilter = searchParams.get("status")?.toUpperCase(); // "ACTIVE" | "SETTLED" | "ALL"

    if (!agentAddress) {
      // Without an agent, this is a read of the caller's own book. `?owner=`
      // used to name whose - which made every human's loan history public to
      // anyone holding a nullifier.
      const reader = resolveReader(req);
      if (!reader) return unauthenticated();

      const ownerLoans = getLoansByHuman(reader.human);
      return NextResponse.json({
        humanOwner: reader.human,
        totalLoansCount: ownerLoans.length,
        loans: ownerLoans,
      });
    }

    const asked = resolveAgentReader(req, agentAddress);
    if ("error" in asked) return asked.error;

    const agent = getAgentByAddress(agentAddress);
    if (!agent) {
      return NextResponse.json(
        { error: `Agent ${agentAddress} not found in Lifeline registry.` },
        { status: 404 }
      );
    }

    // Retrieve loans: either all loans in the human's facility, or strictly for this agent
    let loans = includeShared
      ? getLoansByHuman(agent.humanOwner)
      : getLoansByAgent(agent.address);

    // Filter by status if specified
    if (statusFilter && statusFilter !== "ALL") {
      loans = loans.filter((l) => l.status === statusFilter);
    }

    const activeLoans = loans.filter((l) => l.status === "ACTIVE");
    const totalOutstanding = activeLoans.reduce(
      (sum, l) => sum + l.outstandingAmount,
      0
    );

    return NextResponse.json({
      agentAddress: agent.address,
      agentName: agent.name,
      humanOwner: agent.humanOwner,
      isSharedFacilityView: includeShared,
      totalLoansCount: loans.length,
      activeLoansCount: activeLoans.length,
      totalOutstandingUSDC: totalOutstanding,
      loans,
      network: `${ARC_NAME} (${ARC_CHAIN_ID})`,
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error("[GET /api/agent/loans] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch loans" },
      { status: 500 }
    );
  }
}
