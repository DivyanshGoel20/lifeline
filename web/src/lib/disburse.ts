import { createPublicClient, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_USDC_ADDRESS } from "./arc";
import { getArcTransport } from "./arcRpc";
import { arcGatewayClient, depositReallyFailed } from "./arcGateway";

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
      const result: any = await arcGatewayClient(key).depositFor(amountUsdc.toFixed(6), agentAddress as `0x${string}`);
      return { depositTxHash: result?.depositTxHash ?? result?.txHash };
    } catch (err: any) {
      const checked = await depositReallyFailed(err);
      if (checked?.succeeded) return { depositTxHash: checked.hash };
      if (checked) throw err;
      const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
      if (attempt >= 4 || !/limit|429|too long|timeout|fetch failed|network/i.test(text)) throw err;
      await new Promise((r) => setTimeout(r, attempt * 3000));
      if (before - (await usdcHeld()) >= units) return {};
    }
  }
}
