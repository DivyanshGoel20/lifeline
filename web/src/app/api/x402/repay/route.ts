import { NextRequest, NextResponse } from "next/server";
import { POST as repayHandler } from "@/app/api/repay/route";
import { LIFELINE_CREDIT_FACILITY_ADDRESS, ARC_CHAIN_ID, ARC_NAME } from "@/lib/arc";

/**
 * x402 Repay API
 * Settles outstanding agent debt on the Lifeline Credit Facility on Arc.
 */
export async function POST(req: NextRequest) {
  return repayHandler(req);
}

export async function GET() {
  return NextResponse.json({
    protocol: "x402",
    action: "repay",
    network: ARC_NAME,
    chainId: ARC_CHAIN_ID,
    facilityAddress: LIFELINE_CREDIT_FACILITY_ADDRESS,
    method: "POST",
    description: "Settle outstanding debt on the the Lifeline facility on Arc. Increases reputation tier upon graduation.",
    requestSchema: {
      agentAddress: "0x... (EVM Agent Wallet Address)",
      amount: "number (USDC to repay, e.g. 5.0)",
      targetAgentAddress: "optional 0x... (sibling agent or self)",
      targetLoanId: "optional string (specific loan tranche)"
    },
    authorization: "Bearer <LIFELINE_AGENT_TOKEN> or World ID session cookie"
  });
}
