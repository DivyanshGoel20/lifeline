import { NextRequest, NextResponse } from "next/server";
import { getHumanReputationRecord } from "@/lib/reputationStore";
import { resolveReader } from "@/lib/agentToken";
import { unauthenticated } from "@/lib/session";
import { getAllLoans } from "@/lib/loanStore";
import { computeHumanReputation, SUI_TIERS } from "@/lib/reputationEngine";
import { railDebtsFor } from "@/lib/railDebt";
import { collateralCreditUsd } from "@/lib/collateralStore";
import type { Loan } from "@/types";

export async function GET(req: NextRequest) {
  try {
    // Whose reputation is not the caller's to choose - a credit score read by
    // anyone who knows a nullifier is not a credit score.
    const reader = resolveReader(req);
    if (!reader) return unauthenticated();
    const humanOwner = reader.human;

    // Each rail is its own line with its own record.
    const rail = new URL(req.url).searchParams.get("rail") === "sui" ? "sui" : "arc";
    const record = getHumanReputationRecord(humanOwner, rail);

    const summary =
      rail === "arc"
        ? computeHumanReputation(
            humanOwner,
            getAllLoans().filter((l) => l.humanOwner.toLowerCase() === humanOwner.toLowerCase()),
            record.repaymentsCount,
            record.totalInterestPaid
          )
        : computeHumanReputation(
            humanOwner,
            // Sui's debts, read as loans: one per draw, owed until its
            // obligation is collected.
            railDebtsFor(humanOwner).map(
              (d): Loan => ({
                loanId: `${d.obligationId}:${d.createdAt}`,
                agentAddress: d.agentAddress,
                agentName: "",
                humanOwner: d.humanOwner,
                amount: d.amountUsd,
                originationFee: 0,
                outstandingAmount: d.status === "settled" ? 0 : d.amountUsd,
                totalRepaid: d.status === "settled" ? d.amountUsd : 0,
                status: d.status === "settled" ? "SETTLED" : d.status === "defaulted" ? "DEFAULTED" : "ACTIVE",
                borrowedAt: d.createdAt,
                settledAt: d.settledAt,
                borrowTxHash: d.digest ?? "",
                repayTxHashes: [],
              })
            ),
            record.repaymentsCount,
            0,
            Date.now(),
            SUI_TIERS
          );

    return NextResponse.json({
      success: true,
      summary,
      // The whole line: what the record earned, plus what a deposit backs.
      ...(rail === "arc" ? { lineUsd: summary.currentTier.creditLimit + collateralCreditUsd(humanOwner) } : {}),
      fifoModelExplanation:
        "Tranche-based FIFO: Repayments clear your oldest active loans first, immediately pushing forward your facility maturity deadline.",
    });
  } catch (error: any) {
    console.error("[GET /api/reputation] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch reputation summary" },
      { status: 500 }
    );
  }
}
