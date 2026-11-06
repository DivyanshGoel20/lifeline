import { acquireLedgerLock } from "@/lib/ledgerLock";
import { NextRequest, NextResponse } from "next/server";
import { unauthenticated } from "@/lib/session";
import { ARC_TREASURY } from "@/lib/browserChain";
import { hasCredential, resolveSpender } from "@/lib/agentToken";
import { prepareArcRepayment, commitArcRepayment } from "@/lib/repayCore";
import { getAgentPrivateKey } from "@/lib/agentKeys";
import { RepayRequest, RepayResponse } from "@/types";
import { getAgentByAddress, getHumanFacilityStats } from "@/lib/agentStore";
import { ARC_CHAIN_ID, ARC_NAME, LIFELINE_CREDIT_FACILITY_ADDRESS } from "@/lib/arc";
import { verifyArcRepayment } from "@/lib/facilityContract";
import { claimReceipt, releaseReceipt } from "@/lib/receiptStore";

export async function POST(req: NextRequest) {
  // One ledger change at a time for this human (see ledgerLock).
  let release: (() => void) | undefined;
  try {
    // Turn an anonymous caller away before discussing the request shape.
    if (!hasCredential(req)) return unauthenticated();

    const body: RepayRequest = await req.json();
    const { agentAddress, amount, targetAgentAddress, targetLoanId, txHash } =
      body;

    if (!agentAddress) {
      return NextResponse.json(
        { success: false, error: "Missing required field: agentAddress" },
        { status: 400 }
      );
    }

    if (amount === undefined || amount === null) {
      return NextResponse.json(
        { success: false, error: "Missing required field: amount" },
        { status: 400 }
      );
    }

    const repayAmount = parseFloat(amount.toString());
    if (isNaN(repayAmount) || repayAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid amount. Must be a positive number." },
        { status: 400 }
      );
    }

    // 1. Verify Paying Agent
    // Gated so one human cannot write entries into another's ledger.
    const auth = resolveSpender(req, agentAddress, "arc");
    if ("error" in auth) return auth.error;
    release = await acquireLedgerLock(auth.spender.human);

    const payingAgent = getAgentByAddress(agentAddress);
    if (!payingAgent) {
      return NextResponse.json(
        {
          success: false,
          error: `Paying agent ${agentAddress} is not registered in Lifeline registry.`,
        },
        { status: 404 }
      );
    }

    // 2. Resolve Beneficiary / Target Agent
    // In Lifeline, the Human is the actual borrower.
    // Sibling agents under the same human can repay each other's debt seamlessly.
    let beneficiaryAddress = payingAgent.address;
    if (targetAgentAddress) {
      const targetAgent = getAgentByAddress(targetAgentAddress);
      if (!targetAgent) {
        return NextResponse.json(
          {
            success: false,
            error: `Target agent ${targetAgentAddress} not found.`,
          },
          { status: 404 }
        );
      }
      if (
        targetAgent.humanOwner.toLowerCase() !==
        payingAgent.humanOwner.toLowerCase()
      ) {
        return NextResponse.json(
          {
            success: false,
            error: `Cross-agent repayment permitted only between agents owned by the same verified Human Operator (${payingAgent.humanOwner.slice(
              0,
              10
            )}...).`,
          },
          { status: 403 }
        );
      }
      beneficiaryAddress = targetAgent.address;
    }

    // Paying from the agent's wallet means Lifeline signs the transfer, so it
    // needs the agent's key. Refused up front, before anything is flushed.
    if (!txHash && !getAgentPrivateKey(payingAgent.address)) {
      return NextResponse.json(
        {
          success: false,
          code: "no_agent_key",
          error:
            "Lifeline does not hold this agent's key, so it cannot pay from the agent's wallet. Repay from a wallet you connect, or by card.",
        },
        { status: 400 }
      );
    }

    // 3. Settle pending debt, and how much of the request can be repaid.
    const prepared = await prepareArcRepayment(payingAgent.humanOwner, repayAmount);
    if (!prepared.ok) {
      return NextResponse.json({ success: false, error: prepared.error }, { status: 400 });
    }
    const effectiveRepayAmount = prepared.amount;

    // 4. Real On-Chain Arc Testnet Settlement
    let arcTxHash = txHash;
    let transferTxHash: string | undefined = undefined;

    // A hash from the browser is a claim, not a receipt. Taking it on trust
    // meant the debt cleared on the strength of a string: a wallet left on
    // another chain produced a real hash for a transfer that never arrived,
    // and nothing stopped a caller posting arbitrary hex to the same end.
    if (arcTxHash) {
      const proof = await verifyArcRepayment({
        txHash: arcTxHash as `0x${string}`,
        expectedTo: ARC_TREASURY,
        minAmountUsdc: effectiveRepayAmount,
      });
      if (!proof.ok) {
        return NextResponse.json(
          { success: false, error: proof.reason, code: "unverified_repayment" },
          { status: 400 }
        );
      }
      if (!claimReceipt(arcTxHash, payingAgent.humanOwner)) {
        return NextResponse.json(
          {
            success: false,
            error: "That transfer has already been counted as a repayment.",
            code: "receipt_reused",
          },
          { status: 409 }
        );
      }
    }

    // 5-6. Booked on the facility and the loan ledger, agents synchronised.
    let result;
    try {
      const committed = await commitArcRepayment({
        humanOwner: payingAgent.humanOwner,
        payingAgent,
        beneficiaryAddress,
        amount: effectiveRepayAmount,
        targetLoanId,
        funding: txHash ? { kind: "receipt", txHash: txHash as `0x${string}` } : { kind: "agent" },
      });
      result = committed.result;
      transferTxHash = committed.transferTxHash;
      arcTxHash = committed.txHash;
    } catch (err) {
      // The receipt was not spent after all; let it be presented again.
      if (txHash) releaseReceipt(txHash);
      throw err;
    }

    const updatedFacility = getHumanFacilityStats(payingAgent.humanOwner);
    const updatedBeneficiary = getAgentByAddress(beneficiaryAddress);

    const { getHumanCreditTier } = await import("@/lib/reputationStore");
    const currentTier = getHumanCreditTier(payingAgent.humanOwner);

    const response: RepayResponse = {
      success: true,
      txHash: arcTxHash,
      transferTxHash,
      amount: result.amountRepaid,
      remainingDebt: updatedBeneficiary?.outstandingDebt || 0,
      refundExcess: result.remainingExcessAmount,
      agentAddress: payingAgent.address,
      beneficiaryAgentAddress: beneficiaryAddress,
      facilityTotalDebt: updatedFacility.totalOutstandingDebt,
      settledLoans: result.settledLoans,
      interestPaid: result.interestPaid,
      principalPaid: result.principalPaid,
      currentTierName: currentTier.name,
      newCreditLimit: currentTier.creditLimit,
    };

    const message =
      result.remainingExcessAmount > 0
        ? `Repaid $${result.amountRepaid.toFixed(
            2
          )} USDC on Arc (principal: $${result.principalPaid.toFixed(
            2
          )}, interest/fee: $${result.interestPaid.toFixed(
            2
          )}). Unapplied excess of $${result.remainingExcessAmount.toFixed(
            2
          )} USDC was NOT deducted and remains in agent wallet.`
        : `Repaid $${result.amountRepaid.toFixed(
            2
          )} USDC on Arc (principal: $${result.principalPaid.toFixed(
            2
          )}, interest/fee: $${result.interestPaid.toFixed(
            2
          )}). Facility outstanding debt: $${updatedFacility.totalOutstandingDebt.toFixed(
            2
          )} USDC.`;

    return NextResponse.json({
      ...response,
      payingAgentName: payingAgent.name,
      beneficiaryAgentName: updatedBeneficiary?.name || payingAgent.name,
      network: `${ARC_NAME} (${ARC_CHAIN_ID})`,
      facilityContractAddress: LIFELINE_CREDIT_FACILITY_ADDRESS,
      message,
    });
  } catch (error: any) {
    console.error("[POST /api/repay] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to process repayment" },
      { status: 500 }
    );
  } finally {
    release?.();
  }
}
