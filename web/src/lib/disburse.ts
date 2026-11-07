import { ARC_GATEWAY_CHAIN } from "./arc";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_USDC_ADDRESS } from "./arc";
import { getArcTransport, healthyArcEndpoint } from "./arcRpc";

const BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

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

  const funder = privateKeyToAccount(key).address;
  const client = () => {
    const c = new GatewayClient({ chain: ARC_GATEWAY_CHAIN, privateKey: key, rpcUrl: healthyArcEndpoint() });
    // The SDK does not expose this, and its default waits 4 seconds per check on a chain
    // that finalises in under one. A draw makes two of these waits.
    (c as any).publicClient.pollingInterval = 500;
    return c;
  };
  const usdcHeld = () =>
    createPublicClient({ transport: getArcTransport() }).readContract({ address: ARC_USDC_ADDRESS, abi: BALANCE_ABI, functionName: "balanceOf", args: [funder] });
  const units = parseUnits(amountUsdc.toFixed(6), 6);

  // A rate limit can fail this after the deposit already went through, and depositing
  // again would pay the agent twice. So a retry first checks whether the money left.
  const before = await usdcHeld();
  for (let attempt = 1; ; attempt++) {
    try {
      // depositFor credits the balance to `depositor` rather than to the caller,
      // so the funds become the agent's spending capacity while the debt stays
      // recorded against the human.
      const result: any = await client().depositFor(amountUsdc.toFixed(6), agentAddress as `0x${string}`);
      return { depositTxHash: result?.depositTxHash ?? result?.txHash };
    } catch (err: any) {
      const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
      if (attempt >= 4 || !/limit|429|too long|timeout|fetch failed|network/i.test(text)) throw err;
      await new Promise((r) => setTimeout(r, attempt * 3000));
      if (before - (await usdcHeld()) >= units) return {};
    }
  }
}
