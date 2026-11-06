import { NextRequest, NextResponse } from "next/server";
import { getAgentByAddress, getHumanFacilityStats, agentRail } from "@/lib/agentStore";
import { resolveAgentReader } from "@/lib/agentToken";
import { ARC_CHAIN_ID, ARC_NAME, LIFELINE_CREDIT_FACILITY_ADDRESS } from "@/lib/arc";

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

    if (agentRail(agent) !== "arc") {
      return NextResponse.json(
        { error: "That agent is on the Sui line; its credit is on Sui.", code: "wrong_rail" },
        { status: 400 }
      );
    }

    const facility = getHumanFacilityStats(agent.humanOwner);
    const availableCredit = Math.max(0, agent.creditLimit - agent.outstandingDebt);
    const effectiveAvailable = Math.min(
      availableCredit,
      facility.totalAvailableCredit
    );
    const utilizationRatio = Math.min(
      100,
      Math.round((agent.outstandingDebt / (agent.creditLimit || 1)) * 100)
    );

    const canBorrow =
      (agent.status === "Healthy" || agent.status === "Active") &&
      effectiveAvailable > 0;

    return NextResponse.json({
      agentAddress: agent.address,
      name: agent.name,
      status: agent.status,
      creditLimit: agent.creditLimit,
      outstandingDebt: agent.outstandingDebt,
      availableCredit: effectiveAvailable,
      utilizationPercent: utilizationRatio,
      totalBorrowed: agent.totalBorrowed,
      totalRepaid: agent.totalRepaid,
      canBorrow,
      humanOwner: agent.humanOwner,
      humanFacility: {
        totalCreditLimit: facility.totalCreditLimit,
        totalOutstandingDebt: facility.totalOutstandingDebt,
        totalAvailableCredit: facility.totalAvailableCredit,
        agentCount: facility.agentCount,
      },
      network: `${ARC_NAME} (${ARC_CHAIN_ID})`,
      facilityContractAddress: LIFELINE_CREDIT_FACILITY_ADDRESS,
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error("[GET /api/agent/credit] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch agent credit details" },
      { status: 500 }
    );
  }
}
