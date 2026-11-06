import { NextRequest, NextResponse } from "next/server";
import { POST as borrowHandler } from "@/app/api/borrow/route";
import { LIFELINE_CREDIT_FACILITY_ADDRESS, ARC_CHAIN_ID, ARC_NAME } from "@/lib/arc";

/**
 * x402 Borrow API
 * Allows agents to draw down USDC against their authorized credit facility on Arc.
 */
export async function POST(req: NextRequest) {
  return borrowHandler(req);
}

export async function GET() {
  return NextResponse.json({
    protocol: "x402",
    action: "borrow",
    network: ARC_NAME,
    chainId: ARC_CHAIN_ID,
    facilityAddress: LIFELINE_CREDIT_FACILITY_ADDRESS,
    method: "POST",
    description: "Draw USDC against the the Lifeline facility on Arc. Underwritten by verified human World ID.",
    requestSchema: {
      agentAddress: "0x... (EVM Agent Wallet Address)",
      amount: "number (USDC to draw, e.g. 5.0)",
      memo: "optional string (purpose or x402 resource reference)"
    },
    authorization: "Bearer <LIFELINE_AGENT_TOKEN> or World ID session cookie"
  });
}
