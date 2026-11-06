import { NextRequest, NextResponse } from "next/server";
import { getHuman, unauthenticated } from "@/lib/session";
import { getAgentWalletUsdc } from "@/lib/walletBalance";
import { Agent } from "@/types";
import { getAllAgents, addAgentToStore, getAgentByAddress, getAgentsByOwner, removeAgentFromStore, agentRail, getHumanFacilityStats } from "@/lib/agentStore";
import { validateArcAgentWallet, ARC_LABEL } from "@/lib/arc";
import { LifelineSigner } from "@/lib/lifelineSigner";
import { syncAgentToContractOnChain } from "@/lib/facilityContract";
import { hasAgentPrivateKey } from "@/lib/agentKeys";
import { enforceStanding } from "@/lib/standing";
import { withSuiState } from "@/lib/suiRail";

function sanitizeAgentForClient(agent: Agent): Agent {
  // Records written before AgentKit was removed may still carry its human id.
  const { agentBookHumanId: _hidden, ...rest } = agent as Agent & { agentBookHumanId?: string };
  return rest as Agent;
}

export async function GET(req: NextRequest) {
  try {
    // Scoped to the session rather than to an `owner` query param. Listing every
    // agent also published `isAutonomous` per address, which amounted to an
    // index of exactly which keys this server holds.
    const human = getHuman(req);
    if (!human) return unauthenticated();

    // Anything fallen due since the last look is acted on: the dashboard polls
    // this, so a human sees their line suspended the moment it is.
    await enforceStanding(human).catch((err: any) => console.warn("[standing]", err?.message ?? err));

    const rawAgents = getAgentsByOwner(human);

    // Query live Circle Gateway balance for each registered agent
    let lifelineSigner: LifelineSigner | null = null;
    try {
      lifelineSigner = new LifelineSigner();
    } catch (e) {
      console.warn("Could not initialize LifelineSigner for balance queries:", e);
    }

    const enrichedAgents = await Promise.all(
      rawAgents.map(async (agent) => {
        // Each agent is read on its own rail only.
        if (agentRail(agent) === "sui") return { ...agent, rail: "sui" as const, isAutonomous: hasAgentPrivateKey(agent.address) };
        let liveGw = (agent.currentBalance || 0).toFixed(2);
        if (lifelineSigner) {
          try {
            const bal = await lifelineSigner.getAgentGatewayBalance(agent.address);
            liveGw = bal.formattedAvailable;
          } catch (err) {
            // fallback to stored balance
          }
        }
        // The wallet balance and the Gateway balance answer different questions:
        // what the agent holds, and what it can actually spend through x402.
        const walletUsdc = await getAgentWalletUsdc(agent.address);

        return {
          ...agent,
          rail: "arc" as const,
          currentBalance: parseFloat(liveGw) || 0,
          gatewayBalanceUSDC: liveGw,
          walletUsdc,
          isAutonomous: hasAgentPrivateKey(agent.address),
        };
      })
    );

    // Sui agents: their address there, what they hold, what they owe.
    const agents = (await withSuiState(enrichedAgents as Agent[], human)).map(sanitizeAgentForClient);

    return NextResponse.json({
      agents,
      totalCount: agents.length,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Registering an agent binds it to a credit line, so it takes a verified
    // human. The owner comes from the session: taking it from the body let a
    // caller register agents under anyone's profile - or under a string they
    // invented, which the chain would then underwrite.
    const human = getHuman(req);
    if (!human) return unauthenticated();

    const body = await req.json();
    // No private key: Lifeline never takes one for a wallet it did not create.
    // Such an agent's debts are repaid from a wallet the human connects, or by card.
    const { name, walletAddress, capUsd } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { error: "Agent name is required." },
        { status: 400 }
      );
    }

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json(
        { error: "Agent wallet address is required." },
        { status: 400 }
      );
    }

    // Strict Arc Testnet validation
    const validation = await validateArcAgentWallet(walletAddress);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "This address is not a valid/usable Arc Testnet agent wallet." },
        { status: 400 }
      );
    }

    const formattedAddress = walletAddress.trim().toLowerCase() as `0x${string}`;

    // An address is registered once. Re-registering it used to merge over the
    // existing record - owner, debt and all - so anyone could claim another
    // human's agent, and with it the key Lifeline holds for it.
    if (getAgentByAddress(formattedAddress) || hasAgentPrivateKey(formattedAddress)) {
      return NextResponse.json(
        { error: "That address is already registered with Lifeline.", code: "already_registered" },
        { status: 409 }
      );
    }


    const newAgent: Agent = {
      agentId: `agent_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      address: formattedAddress,
      name: name.trim(),
      humanOwner: human,
      // A wallet registered by address is an Arc agent; Sui agents are
      // provisioned, so Lifeline holds the key that signs on Sui.
      rail: "arc",
      network: ARC_LABEL,
      // The cap asked for, held to the Arc line's headroom.
      creditLimit: Math.min(
        Math.max(Number.isFinite(Number(capUsd)) ? Number(capUsd) : 10, 0),
        getHumanFacilityStats(human).totalAvailableCredit
      ),
      outstandingDebt: 0,
      totalBorrowed: 0,
      totalRepaid: 0,
      currentBalance: validation.balanceUsdc || 0,
      status: "Healthy",
      registeredAt: Date.now(),
      isAutonomous: hasAgentPrivateKey(formattedAddress),
    };

    const saved = addAgentToStore(newAgent);

    // Authorize the agent against the human's existing profile. This no longer
    // creates the profile - if World verification never provisioned one, the
    // agent stays unauthorized and the caller is told why, rather than being
    // handed a credit line nobody underwrote.
    let authorizedOnChain = true;
    let authorizationError: string | undefined;
    try {
      const synced = await syncAgentToContractOnChain(newAgent.address, newAgent.humanOwner);
      if (!synced) {
        authorizedOnChain = false;
        authorizationError = "Arc authorization did not complete.";
      }
    } catch (contractErr: any) {
      authorizedOnChain = false;
      authorizationError = contractErr?.message || String(contractErr);
      console.warn("[Agents-API] On-chain agent authorization failed:", authorizationError);
    }

    return NextResponse.json({
      success: true,
      agent: sanitizeAgentForClient(saved),
      authorizedOnChain,
      ...(authorizationError ? { authorizationError } : {}),
      message: authorizedOnChain
        ? `Agent ${saved.name} verified on Arc and authorized against your credit facility.`
        : `Agent ${saved.name} registered, but it is not yet authorized on Arc and cannot draw credit.`,
    });
  } catch (error: any) {
    console.error("[Agents-API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process agent request" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address");

    if (!address) {
      return NextResponse.json(
        { error: "Agent address is required." },
        { status: 400 }
      );
    }

    const human = getHuman(req);
    if (!human) return unauthenticated();

    const all = getAllAgents();
    const existing = all.find(
      (a) => a.address.toLowerCase() === address.toLowerCase()
    );

    if (existing && (existing.humanOwner || "").toLowerCase() !== human.toLowerCase()) {
      return NextResponse.json(
        { error: "That agent belongs to a different human.", code: "not_your_agent" },
        { status: 403 }
      );
    }

    if (!existing) {
      return NextResponse.json(
        { error: "Agent not found in Lifeline registry." },
        { status: 404 }
      );
    }

    // Check if agent has unsettled debt
    if (existing.outstandingDebt > 0) {
      return NextResponse.json(
        {
          error: `Cannot remove agent with an active credit draw ($${existing.outstandingDebt.toFixed(2)} USDC). Please repay the debt before removing.`,
        },
        { status: 403 }
      );
    }

    const removed = removeAgentFromStore(address);
    if (!removed) {
      return NextResponse.json(
        { error: "Failed to remove agent from registry." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Agent ${existing.name} disconnected from Lifeline credit facility.`,
    });
  } catch (error: any) {
    console.error("[Agents-API] Delete error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to remove agent" },
      { status: 500 }
    );
  }
}
