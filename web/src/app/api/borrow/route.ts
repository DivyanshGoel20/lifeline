import { fundLoanFromPool } from "@/lib/poolFunding";
import { acquireLedgerLock, syncAgentDebts } from "@/lib/ledgerLock";
import { NextRequest, NextResponse } from "next/server";
import { recordMandateSpend } from "@/lib/mandateSpend";
import { borrowingBlocked } from "@/lib/standing";
import { creditRefusal } from "@/lib/riskControls";
import { unauthenticated } from "@/lib/session";
import { hasCredential, overMandate, resolveSpender } from "@/lib/agentToken";
import { BorrowRequest, BorrowResponse } from "@/types";
import {
  getAgentByAddress,
  updateAgentInStore,
  getHumanFacilityStats,
} from "@/lib/agentStore";
import { createLoan } from "@/lib/loanStore";
import { shortRef } from "@/lib/paymentRef";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_NAME, LIFELINE_CREDIT_FACILITY_ADDRESS } from "@/lib/arc";
import { executeOnChainDrawdown } from "@/lib/facilityContract";
import { invalidateTelemetryCache } from "@/lib/telemetryCache";

export async function POST(req: NextRequest) {
  // One ledger change at a time for this human (see ledgerLock).
  let release: (() => void) | undefined;
  try {
    // Turn an anonymous caller away before discussing the request shape.
    if (!hasCredential(req)) return unauthenticated();

    const body: BorrowRequest = await req.json();
    const { agentAddress, amount, memo } = body;

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

    const borrowAmount = parseFloat(amount.toString());
    if (isNaN(borrowAmount) || borrowAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid amount. Must be a positive number." },
        { status: 400 }
      );
    }

    // Drawing on a credit line is the human's call, not anyone who knows an
    // agent address. This is the same hole as /api/pay, reachable by a
    // different door.
    const auth = resolveSpender(req, agentAddress, "arc");
    if ("error" in auth) return auth.error;
    release = await acquireLedgerLock(auth.spender.human);

    // A mandate caps what an agent may draw. A human here in person is bounded
    // only by their facility limit, which the contract enforces anyway.
    const { capUsd } = auth.spender;
    if (capUsd !== undefined && borrowAmount > capUsd) {
      return overMandate(borrowAmount, capUsd);
    }

    // 1. Check Agent in Store
    const agent = getAgentByAddress(agentAddress);
    if (!agent) {
      return NextResponse.json(
        {
          success: false,
          error: `Agent ${agentAddress} is not registered with Lifeline credit facility. Please add the agent first.`,
        },
        { status: 404 }
      );
    }

    // 2. Check Agent Status
    const lineBlocked = borrowingBlocked(auth.spender.human, "arc");
    if (lineBlocked) {
      return NextResponse.json({ success: false, error: lineBlocked, code: "line_suspended" }, { status: 403 });
    }
    const refused = creditRefusal({ human: auth.spender.human, amountUsd: borrowAmount });
    if (refused) {
      return NextResponse.json({ success: false, error: refused, code: "credit_paused" }, { status: 403 });
    }

    if (agent.status === "Suspended" || agent.status === "Delinquent") {
      return NextResponse.json(
        {
          success: false,
          error: `Agent credit facility is currently ${agent.status.toLowerCase()}. Draws are restricted.`,
        },
        { status: 403 }
      );
    }

    // 2b. The agent's own cap. A purchase on credit already respects it; a
    // direct draw did not, so an agent capped at fifty cents could draw
    // whatever the human's line had left.
    const agentAvailable = Math.max(0, (agent.creditLimit || 0) - (agent.outstandingDebt || 0));
    if (borrowAmount > agentAvailable + 0.0001) {
      return NextResponse.json(
        {
          success: false,
          error: `Draw exceeds this agent's cap. It may borrow $${agentAvailable.toFixed(2)} more; requested $${borrowAmount.toFixed(2)}.`,
        },
        { status: 403 }
      );
    }

    // 3. Human Borrower Credit Limits & Outstanding Headroom (Strictly Shared Pool)
    const facility = getHumanFacilityStats(agent.humanOwner);
    const facilityAvailable = facility.totalAvailableCredit;

    if (borrowAmount > facilityAvailable + 0.0001) {
      return NextResponse.json(
        {
          success: false,
          error: `Draw exceeds shared facility credit limit. Combined available across all your agents: $${facilityAvailable.toFixed(
            2
          )} USDC. Requested: $${borrowAmount.toFixed(2)} USDC.`,
        },
        { status: 403 }
      );
    }

    // 4. Real On-Chain Arc Testnet Settlement
    const onChainResult = await executeOnChainDrawdown({
      agentAddress: agent.address,
      humanOwner: agent.humanOwner,
      amountUsdc: borrowAmount,
      // Capped to one storage slot; the full memo stays on the loan record.
      paymentReference: shortRef(memo || "draw"),
      // A draw the human asked for has to deliver the money, not just the debt.
      disburse: true,
    });
    const arcTxHash = onChainResult.txHash;

    // 5. Create atomic Loan record (1.0% origination fee + 7-day maturity)
    const loan = createLoan({
      agentAddress: agent.address,
      agentName: agent.name,
      humanOwner: agent.humanOwner,
      amount: borrowAmount,
      txHash: arcTxHash,
      memo: memo || "Credit Facility Draw on Arc Testnet",
    });

    await fundLoanFromPool(borrowAmount);

    // 6. Update Agent Financials (Principal + 1.0% Origination Fee)
    // Debt comes from the loans themselves; the other figures are read again,
    // not from before the seconds-long wait for Arc.
    const originationFee = loan.originationFee || Math.round(borrowAmount * 0.01 * 10000) / 10000;
    syncAgentDebts(agent.humanOwner);
    const fresh = getAgentByAddress(agent.address) ?? agent;
    const newDebt = fresh.outstandingDebt;
    updateAgentInStore(agent.address, {
      totalBorrowed: Math.round((fresh.totalBorrowed + borrowAmount) * 10000) / 10000,
      currentBalance: Math.round((fresh.currentBalance + borrowAmount) * 10000) / 10000,
      status: "Active",
    });

    recordMandateSpend(auth.spender.mandateId, borrowAmount);
    const updatedFacility = getHumanFacilityStats(agent.humanOwner);

    const response: BorrowResponse = {
      success: true,
      loanId: loan.loanId,
      txHash: arcTxHash,
      amount: borrowAmount,
      newOutstandingDebt: newDebt,
      facilityTotalDebt: updatedFacility.totalOutstandingDebt,
      agentAddress: agent.address,
      humanOwner: agent.humanOwner,
    };

    invalidateTelemetryCache(agent.humanOwner);

    return NextResponse.json({
      ...response,
      agentName: agent.name,
      originationFee,
      initialTotalDue: Math.round((borrowAmount + originationFee) * 10000) / 10000,
      agentAvailableCredit: updatedFacility.totalAvailableCredit,
      facilityAvailableCredit: updatedFacility.totalAvailableCredit,
      network: `${ARC_TESTNET_NAME} (${ARC_TESTNET_CHAIN_ID})`,
      facilityContractAddress: LIFELINE_CREDIT_FACILITY_ADDRESS,
      message: `Successfully disbursed $${borrowAmount.toFixed(
        2
      )} USDC on Arc Testnet (1.0% fee: $${originationFee.toFixed(2)} USDC, 7-day maturity).`,
    });
  } catch (error: any) {
    console.error("[POST /api/borrow] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to execute borrow draw" },
      { status: 500 }
    );
  } finally {
    release?.();
  }
}
