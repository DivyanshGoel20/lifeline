import { mintAgentToken, type AgentGrant } from "./agentToken";
import { getHumanFacilityStats, getSuiFacilityStats, addAgentToStore } from "./agentStore";
import { provisionArcAgentWallet, ARC_LABEL } from "./arc";
import { setAgentPrivateKey } from "./agentKeys";
import { syncAgentToContractOnChain } from "./facilityContract";
import { suiAddressFor } from "./suiRail";
import type { Rail } from "@/types";

export type ProvisionedAgent = {
  agent: { address: string; rail: Rail; suiAddress?: string | null; apiKey: string; label: string; network: string };
  authorizedOnChain: boolean;
  authorizationError?: string;
  grant: AgentGrant;
  token: string;
};

/** What a human can still hand to a new agent on one rail. */
export const headroomFor = (human: string, rail: Rail) =>
  rail === "arc" ? getHumanFacilityStats(human).totalAvailableCredit : getSuiFacilityStats(human).availableCredit;

/**
 * A new agent for a verified human: a wallet Lifeline holds the key to, on one
 * rail only, authorised on the Arc facility when it is an Arc agent, and a
 * mandate token bound to it.
 *
 * The token names the agent, so it spends through that agent and no other of
 * the human's, and revoking the agent ends it.
 */
export async function provisionAgent(
  human: string,
  opts: { rail: Rail; label: string; capUsd?: number; days: number }
): Promise<ProvisionedAgent | { error: string; code: string }> {
  const available = headroomFor(human, opts.rail);
  const asked = Number.isFinite(opts.capUsd) ? Number(opts.capUsd) : available;
  const capUsd = Math.min(Math.max(asked, 0), available);
  if (!(capUsd > 0)) return { error: "No credit headroom to delegate.", code: "no_headroom" };

  // One secp256k1 key: on Arc it is the agent's address; on Sui the same key
  // gives its Sui address. Either way the agent lives on one rail only.
  const wallet = provisionArcAgentWallet();
  // No stored key, no agent: registered without one, it would be handed a
  // mandate and credit for a wallet nobody can sign for.
  const stored = setAgentPrivateKey(wallet.address, wallet.privateKey);
  if (!stored.ok) return { error: stored.error ?? "Lifeline could not store the agent's key.", code: "keystore_unavailable" };

  addAgentToStore({
    address: wallet.address,
    name: opts.label,
    humanOwner: human,
    rail: opts.rail,
    creditLimit: capUsd,
    outstandingDebt: 0,
    totalBorrowed: 0,
    totalRepaid: 0,
    currentBalance: 0,
    apiKey: wallet.apiKey,
    status: "Healthy",
    isAutonomous: true,
    isPlatformCreated: true,
    registeredAt: Date.now(),
  });

  // Awaited: the agent is handed back ready to spend, and a drawdown the
  // moment provisioning returns used to race an authorisation still in flight
  // and be refused by the facility. Only an Arc agent is authorised on the
  // Arc contract.
  let authorizedOnChain = true;
  let authorizationError: string | undefined;
  if (opts.rail === "arc") {
    try {
      authorizedOnChain = !!(await syncAgentToContractOnChain(wallet.address, human));
      if (!authorizedOnChain) authorizationError = "Arc authorization did not complete.";
    } catch (err: any) {
      authorizedOnChain = false;
      authorizationError = err?.message || String(err);
      console.warn("[Provision] On-chain authorization failed:", authorizationError);
    }
  }

  const { token, grant } = mintAgentToken(human, {
    capUsd,
    days: opts.days,
    label: opts.label,
    agentAddress: wallet.address,
  });

  return {
    agent: {
      address: wallet.address,
      rail: opts.rail,
      ...(opts.rail === "sui" ? { suiAddress: suiAddressFor(wallet.address) } : {}),
      apiKey: wallet.apiKey,
      label: opts.label,
      network: opts.rail === "arc" ? ARC_LABEL : `Sui ${process.env.SUI_NETWORK ?? ""}`.trim(),
    },
    authorizedOnChain,
    ...(authorizationError ? { authorizationError } : {}),
    grant,
    token,
  };
}
