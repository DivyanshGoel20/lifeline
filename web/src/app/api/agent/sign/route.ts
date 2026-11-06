import { NextRequest, NextResponse } from "next/server";
import {
  getAgentPrivateKey,
  getAgentAccount,
  getAgentWalletClient,
  hasAgentPrivateKey,
} from "@/lib/agentKeys";
import { getPublicClient, arcTestnetChain, LIFELINE_CREDIT_FACILITY_ABI } from "@/lib/facilityContract";
import { LIFELINE_CREDIT_FACILITY_ADDRESS, ARC_LABEL } from "@/lib/arc";
import { resolveSpender } from "@/lib/agentToken";
import { getHuman, unauthenticated } from "@/lib/session";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address") || searchParams.get("agentAddress");

    if (!address) {
      return NextResponse.json(
        { error: "Missing address query parameter" },
        { status: 400 }
      );
    }

    const auth = resolveSpender(req, address);
    if ("error" in auth) return auth.error;

    const isAutonomous = hasAgentPrivateKey(address);
    const account = getAgentAccount(address);

    return NextResponse.json({
      address,
      isAutonomous,
      signingCapable: isAutonomous,
      derivedAddress: account?.address || null,
      message: isAutonomous
        ? "Agent private key is configured for autonomous transaction signing."
        : "No private key configured for this agent address.",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agentAddress, message, action } = body;

    if (!agentAddress) {
      return NextResponse.json(
        { error: "agentAddress is required" },
        { status: 400 }
      );
    }

    // This endpoint signs arbitrary text with a custodied key. Unauthenticated,
    // an agent address - which the dashboard used to publish - was the only
    // thing standing between an attacker and a signature from that key. It is
    // the human's, in person: a spending mandate is a card, and a card does not
    // get to sign anything the agent's wallet could be held to.
    if (!getHuman(req)) return unauthenticated();
    const auth = resolveSpender(req, agentAddress);
    if ("error" in auth) return auth.error;

    const account = getAgentAccount(agentAddress);
    if (!account) {
      return NextResponse.json(
        {
          error: `No private key found for agent ${agentAddress}. Cannot sign autonomously.`,
        },
        { status: 404 }
      );
    }

    // Handle test signing of message or structured challenge
    if (action === "sign_message" || message) {
      const msgToSign = message || `Lifeline autonomous authorization for agent ${agentAddress} at ${new Date().toISOString()}`;
      const signature = await account.signMessage({ message: msgToSign });

      return NextResponse.json({
        success: true,
        agentAddress: account.address,
        message: msgToSign,
        signature,
        verified: true,
        timestamp: Date.now(),
      });
    }

    // Default: Check signer status and readiness
    const publicClient = getPublicClient();
    const blockNumber = await publicClient.getBlockNumber();

    return NextResponse.json({
      success: true,
      agentAddress: account.address,
      status: "READY",
      network: ARC_LABEL,
      latestBlock: Number(blockNumber),
      message: "Agent signer is active and ready on Arc.",
    });
  } catch (err: any) {
    console.error("[POST /api/agent/sign] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Failed to execute agent signing" },
      { status: 500 }
    );
  }
}
