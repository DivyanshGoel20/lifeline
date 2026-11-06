import { NextRequest, NextResponse } from "next/server";
import { getAgentByAddress, getHumanFacilityStats } from "@/lib/agentStore";
import { resolveAgentReader } from "@/lib/agentToken";
import { ARC_CHAIN_ID, ARC_NAME, ARC_RPC_URL } from "@/lib/arc";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const agentAddress =
      searchParams.get("agentAddress") ||
      searchParams.get("address") ||
      req.headers.get("x-agent-address");

    if (!agentAddress) {
      return NextResponse.json(
        {
          error:
            "Missing agent address. Provide ?agentAddress=0x... or x-agent-address header.",
        },
        { status: 400 }
      );
    }

    // The address is on chain, so it is not a secret and cannot be the
    // authorisation. A session or a mandate says who is asking; the agent has
    // to be theirs.
    const asked = resolveAgentReader(req, agentAddress);
    if ("error" in asked) return asked.error;

    const agent = getAgentByAddress(agentAddress);
    if (!agent) {
      return NextResponse.json(
        { error: `Agent ${agentAddress} not found in Lifeline registry.` },
        { status: 404 }
      );
    }

    /**
     * Headroom is the human's, not this agent's.
     *
     * This used to answer `creditLimit - outstandingDebt` for the one agent,
     * ignoring what the human's other agents had drawn and any debt on the
     * other rail. One human has one credit line, so an agent asking how much
     * it could spend was told the whole limit while most of it was already
     * gone - and then declined at borrow time with no way to see why. The
     * credit endpoint had this right; this one disagreed with it about the
     * same agent at the same moment.
     */
    const facility = getHumanFacilityStats(agent.humanOwner);

    return NextResponse.json({
      agentAddress: agent.address,
      name: agent.name,
      liquidBalanceUSDC: agent.currentBalance,
      outstandingDebtUSDC: agent.outstandingDebt,
      availableCreditUSDC: facility.totalAvailableCredit,
      creditLimitUSDC: facility.totalCreditLimit,
      // What this agent alone owes, against what the line as a whole has left,
      // because the difference is the thing that was confusing.
      humanFacility: {
        totalCreditLimit: facility.totalCreditLimit,
        totalOutstandingDebt: facility.totalOutstandingDebt,
        totalAvailableCredit: facility.totalAvailableCredit,
        agentCount: facility.agentCount,
      },
      network: `${ARC_NAME} (${ARC_CHAIN_ID})`,
      rpcUrl: ARC_RPC_URL,
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error("[GET /api/agent/balance] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch agent balance" },
      { status: 500 }
    );
  }
}
