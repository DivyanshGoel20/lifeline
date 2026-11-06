import { ARC_GATEWAY_CHAIN } from "./arc";
import { GatewayClient } from "@circle-fin/x402-batching/client";

/**
 * Putting money where an agent can actually spend it.
 *
 * Drawing on a credit line has to hand the borrower something. Until this
 * existed, `recordDrawdown` booked the debt and nothing moved, so a draw was a
 * liability with no matching asset - the agent owed Lifeline for a payment that
 * never happened.
 *
 * The deposit goes into the agent's Circle Gateway balance rather than its
 * wallet, because Gateway balance is what settles an x402 charge. USDC sitting
 * in the wallet cannot pay for anything over x402, which is the whole point of
 * the facility.
 */
export async function depositToAgentGateway(
  agentAddress: string,
  amountUsdc: number
): Promise<{ depositTxHash?: string }> {
  const key = (process.env.LIFELINE_FUNDING_PRIVATE_KEY ||
    process.env.PRIVATE_KEY) as `0x${string}`;
  if (!key) throw new Error("Missing LIFELINE_FUNDING_PRIVATE_KEY for disbursement");

  const client = new GatewayClient({ chain: ARC_GATEWAY_CHAIN, privateKey: key });

  // depositFor credits the balance to `depositor` rather than to the caller,
  // so the funds become the agent's spending capacity while the debt stays
  // recorded against the human.
  const result: any = await client.depositFor(
    amountUsdc.toFixed(6),
    agentAddress as `0x${string}`
  );

  return { depositTxHash: result?.depositTxHash ?? result?.txHash };
}
