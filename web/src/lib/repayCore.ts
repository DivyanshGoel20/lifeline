import { Agent } from "@/types";
import { getAgentsByOwner, getHumanFacilityStats, updateAgentInStore } from "./agentStore";
import { flushAgent } from "./ledgerFlush";
import { processRepayment, getLoansByAgent, getActiveLoansByHuman } from "./loanStore";
import { calculateLoanAccrual } from "./reputationEngine";
import { executeOnChainRepayment } from "./facilityContract";
import { invalidateTelemetryCache } from "./telemetryCache";
import { claimReceipt } from "./receiptStore";
import { appliedStanding, enforceStanding } from "./standing";
import { returnRepaymentToPool } from "./poolFunding";

/**
 * An Arc repayment, however it was funded.
 *
 * Split in two so each way of paying can check its own evidence in between:
 * `prepareArcRepayment` settles pending debt and says how much can be repaid;
 * `commitArcRepayment` books it on the facility and the loan ledger.
 *
 *   agent wallet    the agent's USDC moves to the treasury, then it is booked
 *   browser wallet  a verified transfer receipt, then it is booked
 *   card            Stripe says the human paid (Apple Pay, Google Pay, card);
 *                   no USDC moves - Lifeline was paid in dollars - so only the
 *                   booking is written
 */

export async function prepareArcRepayment(
  humanOwner: string,
  requestedUsd: number
): Promise<{ ok: true; amount: number; owed: number } | { ok: false; error: string }> {
  // Settle every agent's pending nanopayments first. The contract subtracts
  // from the debt it can see, and a sibling's un-flushed drawdowns are not part
  // of that yet - repaying the full off-chain balance against a smaller
  // on-chain one would be refused, or clamped short.
  for (const sibling of getAgentsByOwner(humanOwner)) {
    await flushAgent(humanOwner, sibling.address, { force: true });
  }

  // Arc debt only: what is owed on Sui is repaid on Sui. Counted with the
  // interest accrued up to now, which the stored balances leave out until the
  // next repayment - otherwise "repay all" always left a sliver behind.
  const stored = getHumanFacilityStats(humanOwner).arcOutstandingDebt;
  const accrued = getActiveLoansByHuman(humanOwner).reduce((n, l) => n + calculateLoanAccrual(l).totalDue, 0);
  const owed = Math.max(stored, Math.round(accrued * 10000) / 10000);
  if (owed <= 0.0001) {
    return { ok: false, error: "No outstanding debt exists on this agent or human credit facility to repay." };
  }
  const amount = Math.min(requestedUsd, Math.round((owed + 0.0001) * 10000) / 10000);
  return { ok: true, amount, owed };
}

export async function commitArcRepayment(p: {
  humanOwner: string;
  payingAgent: Agent;
  beneficiaryAddress: string;
  amount: number;
  targetLoanId?: string;
  funding: { kind: "agent" } | { kind: "receipt"; txHash: `0x${string}` } | { kind: "card"; reference: string };
}) {
  const onChain = await executeOnChainRepayment({
    humanOwner: p.humanOwner,
    payerAddress: p.payingAgent.address,
    agentAddress: p.beneficiaryAddress,
    amountUsdc: p.amount,
    alreadyTransferred: p.funding.kind === "receipt" ? p.funding.txHash : undefined,
    fundedOffChain: p.funding.kind === "card" ? p.funding.reference : undefined,
  });

  // The agent's own transfer is a receipt too: claimed here, so nobody can
  // post its hash later as proof of a repayment of their own.
  if (onChain.transferTxHash) claimReceipt(onChain.transferTxHash, p.humanOwner);

  const result = await bookArcRepayment({
    humanOwner: p.humanOwner,
    payingAgent: p.payingAgent,
    beneficiaryAddress: p.beneficiaryAddress,
    amount: p.amount,
    targetLoanId: p.targetLoanId,
    txHash: onChain.txHash,
    // Only an agent paying from its wallet is poorer for it; a card payment
    // came from the human.
    agentPaid: p.funding.kind === "agent",
  });
  return { result, txHash: onChain.txHash, transferTxHash: onChain.transferTxHash };
}

/**
 * Book money that has already reached the facility: the loans, the agents, and
 * the line coming back if that was what stood in its way.
 */
export async function bookArcRepayment(p: {
  humanOwner: string;
  payingAgent: Agent;
  beneficiaryAddress: string;
  amount: number;
  targetLoanId?: string;
  txHash: string;
  agentPaid: boolean;
}) {
  // FIFO: oldest loan first, interest then principal.
  const result = processRepayment({
    payingAgentAddress: p.payingAgent.address,
    amount: p.amount,
    targetAgentAddress: p.beneficiaryAddress,
    targetLoanId: p.targetLoanId,
    humanOwner: p.humanOwner,
    txHash: p.txHash,
  });

  await returnRepaymentToPool(result.principalPaid, result.interestPaid);

  const agentPaid = p.agentPaid;
  for (const a of getAgentsByOwner(p.humanOwner)) {
    const remainingDebt =
      Math.round(
        getLoansByAgent(a.address)
          .filter((l) => l.status === "ACTIVE" && (l.outstandingAmount || 0) > 0.0001)
          .reduce((sum, l) => sum + l.outstandingAmount, 0) * 10000
      ) / 10000;
    const isPayer = a.address.toLowerCase() === p.payingAgent.address.toLowerCase();
    updateAgentInStore(a.address, {
      outstandingDebt: remainingDebt,
      currentBalance:
        isPayer && agentPaid
          ? Math.max(0, Math.round((a.currentBalance - result.amountRepaid) * 10000) / 10000)
          : a.currentBalance,
      totalRepaid: isPayer ? Math.round((a.totalRepaid + result.amountRepaid) * 10000) / 10000 : a.totalRepaid,
      status: remainingDebt === 0 ? "Healthy" : "Active",
    });
  }

  invalidateTelemetryCache(p.humanOwner);
  // A line suspended or in default comes back as soon as what was overdue is paid.
  if (appliedStanding(p.humanOwner).arc?.status && appliedStanding(p.humanOwner).arc?.status !== "good") {
    await enforceStanding(p.humanOwner).catch((err: any) => console.warn("[standing]", err?.message ?? err));
  }
  return result;
}
