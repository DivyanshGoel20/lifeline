import fs from "./storeFs";
import { writeJsonAtomic } from "./atomicWrite";
import path from "path";
import { Loan } from "@/types";
import { calculateLoanAccrual } from "./reputationEngine";
import { recordRepaymentInReputation } from "./reputationStore";

function getLoansFilePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "loans.json"),
    path.resolve(process.cwd(), "data", "loans.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), "data", "loans.json");
}

function ensureDirectoryExists() {
  const filePath = getLoansFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAllLoans(): Loan[] {
  try {
    ensureDirectoryExists();
    const filePath = getLoansFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error("[LoanStore] Error reading loans file:", error);
    return [];
  }
}

export function saveAllLoans(loans: Loan[]) {
  try {
    ensureDirectoryExists();
    const primary = getLoansFilePath();
    // One file. A second copy, mirrored on every write, was never read and
    // could only drift from the first.
    writeJsonAtomic(primary, loans);
  } catch (error) {
    console.error("[LoanStore] Error writing loans file:", error);
  }
}

export function getLoansByAgent(agentAddress: string): Loan[] {
  const all = getAllLoans();
  return all.filter(
    (l) => l.agentAddress.toLowerCase() === agentAddress.toLowerCase()
  );
}

export function getLoansByHuman(humanOwner: string): Loan[] {
  const all = getAllLoans();
  return all.filter(
    (l) => l.humanOwner.toLowerCase() === humanOwner.toLowerCase()
  );
}

export function getActiveLoansByHuman(humanOwner: string): Loan[] {
  const all = getAllLoans();
  return all.filter(
    (l) =>
      l.humanOwner.toLowerCase() === humanOwner.toLowerCase() &&
      l.status === "ACTIVE" &&
      (l.outstandingAmount || 0) > 0.0001
  );
}

/**
 * Creates a new loan with 1.0% origination fee and strict 7-day maturity cap.
 */
export function createLoan(params: {
  agentAddress: string;
  agentName: string;
  humanOwner: string;
  amount: number;
  txHash: string;
  memo?: string;
}): Loan {
  const all = getAllLoans();
  const now = Date.now();
  const originationFee = Math.round(params.amount * 0.01 * 10000) / 10000;
  const initialTotalDue = Math.round((params.amount + originationFee) * 10000) / 10000;
  // Due after the loan term (7 days unless LIFELINE_LOAN_TERM_DAYS says otherwise).
  const termDays = Number(process.env.LIFELINE_LOAN_TERM_DAYS) > 0 ? Number(process.env.LIFELINE_LOAN_TERM_DAYS) : 7;
  const dueAt = now + termDays * 24 * 60 * 60 * 1000;

  const newLoan: Loan = {
    loanId: `loan_${now}_${Math.random().toString(36).substring(2, 7)}`,
    agentAddress: params.agentAddress.toLowerCase() as `0x${string}`,
    agentName: params.agentName,
    humanOwner: params.humanOwner,
    amount: params.amount,
    originationFee,
    accruedInterest: 0,
    outstandingAmount: initialTotalDue,
    totalRepaid: 0,
    status: "ACTIVE",
    borrowedAt: now,
    dueAt,
    borrowTxHash: params.txHash,
    repayTxHashes: [],
    memo: params.memo || "Lifeline draw on Arc Testnet",
  };

  all.unshift(newLoan);
  saveAllLoans(all);
  return newLoan;
}

/**
 * Stamp the settling transaction onto loans that were booked before it existed.
 *
 * A loan created from an x402 nanopayment has no drawdown tx of its own - the
 * debt waits in the pending ledger and reaches the chain as part of a batch.
 * Until that batch lands the loan is real but unproven, which is what the UI
 * shows as pending.
 */
export function attachBorrowTx(loanIds: string[], txHash: string): void {
  if (loanIds.length === 0) return;
  const wanted = new Set(loanIds);
  const all = getAllLoans();
  let touched = false;

  for (const loan of all) {
    if (wanted.has(loan.loanId) && !loan.borrowTxHash) {
      loan.borrowTxHash = txHash;
      touched = true;
    }
  }

  if (touched) saveAllLoans(all);
}

/**
 * Flexible repayment engine:
 * Follows FIFO (First-In, First-Out) Tranche settlement:
 * Oldest loan is settled first. Settling the oldest loan immediately rolls forward
 * the facility's overall maturity deadline to the next earliest loan tranche.
 */
export function processRepayment(params: {
  payingAgentAddress: string;
  amount: number;
  targetAgentAddress?: string;
  targetLoanId?: string;
  humanOwner: string;
  txHash: string;
}): {
  amountRepaid: number;
  beneficiaryAgentAddress: string;
  settledLoans: string[];
  remainingExcessAmount: number;
  interestPaid: number;
  principalPaid: number;
} {
  const all = getAllLoans();
  let remainingToApply = params.amount;
  const settledLoans: string[] = [];
  const payingAddress = params.payingAgentAddress.toLowerCase();
  const targetAddress = params.targetAgentAddress
    ? params.targetAgentAddress.toLowerCase()
    : payingAddress;

  let totalInterestPaid = 0;
  let totalPrincipalPaid = 0;
  let totalServicedDurationDays = 0;

  // 1. If a specific loan ID was targeted
  if (params.targetLoanId) {
    // Only one of this human's own loans.
    const loan = all.find(
      (l) => l.loanId === params.targetLoanId && (l.humanOwner || "").toLowerCase() === params.humanOwner.toLowerCase()
    );
    if (loan && loan.status === "ACTIVE" && (loan.outstandingAmount || 0) > 0.0001) {
      const accrual = calculateLoanAccrual(loan);
      const totalDue = accrual.totalDue;
      const payment = Math.min(remainingToApply, totalDue);

      const feePart = accrual.originationFee + accrual.accruedInterest;
      const interestPayment = Math.min(payment, feePart);
      const principalPayment = Math.max(0, payment - interestPayment);
      totalInterestPaid += interestPayment;
      totalPrincipalPaid += principalPayment;

      const remainingDebt = Math.max(0, Math.round((totalDue - payment) * 10000) / 10000);
      loan.outstandingAmount = remainingDebt <= 0.0001 ? 0 : remainingDebt;
      loan.totalRepaid = Math.round((loan.totalRepaid + payment) * 10000) / 10000;
      loan.accruedThrough = Date.now();
      loan.repayTxHashes.push(params.txHash);
      remainingToApply = Math.max(0, Math.round((remainingToApply - payment) * 10000) / 10000);

      if (loan.outstandingAmount === 0) {
        loan.status = "SETTLED";
        loan.settledAt = Date.now();
        settledLoans.push(loan.loanId);
        totalServicedDurationDays += accrual.daysOutstanding;
      }

      // Anything left over goes on to the rest of what is owed, below: the
      // whole amount was already paid on chain, so none of it can be dropped.
    }
  }

  // 2. Primary target: Repay active loans of the target agent (FIFO: oldest first)
  const targetLoans = all
    .filter(
      (l) =>
        l.agentAddress.toLowerCase() === targetAddress &&
        l.status === "ACTIVE" &&
        (l.outstandingAmount || 0) > 0.0001
    )
    .sort((a, b) => (a.borrowedAt || 0) - (b.borrowedAt || 0));

  for (const loan of targetLoans) {
    if (remainingToApply <= 0.0001) break;
    const accrual = calculateLoanAccrual(loan);
    const totalDue = accrual.totalDue;
    const payment = Math.min(remainingToApply, totalDue);

    const feePart = accrual.originationFee + accrual.accruedInterest;
    const interestPayment = Math.min(payment, feePart);
    const principalPayment = Math.max(0, payment - interestPayment);
    totalInterestPaid += interestPayment;
    totalPrincipalPaid += principalPayment;

    const remainingDebt = Math.max(0, Math.round((totalDue - payment) * 10000) / 10000);
    loan.outstandingAmount = remainingDebt <= 0.0001 ? 0 : remainingDebt;
    loan.totalRepaid = Math.round((loan.totalRepaid + payment) * 10000) / 10000;
    loan.accruedThrough = Date.now();
    loan.repayTxHashes.push(params.txHash);
    remainingToApply = Math.max(0, Math.round((remainingToApply - payment) * 10000) / 10000);

    if (loan.outstandingAmount === 0) {
      loan.status = "SETTLED";
      loan.settledAt = Date.now();
      settledLoans.push(loan.loanId);
      totalServicedDurationDays += accrual.daysOutstanding;
    }
  }

  // 3. Shared Human Borrower Feature:
  // If excess payment remains, apply it to other active loans under the SAME human borrower (FIFO)!
  if (remainingToApply > 0.0001 && params.humanOwner) {
    const otherHumanLoans = all
      .filter(
        (l) =>
          l.humanOwner.toLowerCase() === params.humanOwner.toLowerCase() &&
          l.agentAddress.toLowerCase() !== targetAddress &&
          l.status === "ACTIVE" &&
          (l.outstandingAmount || 0) > 0.0001
      )
      .sort((a, b) => (a.borrowedAt || 0) - (b.borrowedAt || 0));

    for (const loan of otherHumanLoans) {
      if (remainingToApply <= 0.0001) break;
      const accrual = calculateLoanAccrual(loan);
      const totalDue = accrual.totalDue;
      const payment = Math.min(remainingToApply, totalDue);

      const feePart = accrual.originationFee + accrual.accruedInterest;
      const interestPayment = Math.min(payment, feePart);
      const principalPayment = Math.max(0, payment - interestPayment);
      totalInterestPaid += interestPayment;
      totalPrincipalPaid += principalPayment;

      const remainingDebt = Math.max(0, Math.round((totalDue - payment) * 10000) / 10000);
      loan.outstandingAmount = remainingDebt <= 0.0001 ? 0 : remainingDebt;
      loan.totalRepaid = Math.round((loan.totalRepaid + payment) * 10000) / 10000;
      loan.accruedThrough = Date.now();
      loan.repayTxHashes.push(params.txHash);
      remainingToApply = Math.max(0, Math.round((remainingToApply - payment) * 10000) / 10000);

      if (loan.outstandingAmount === 0) {
        loan.status = "SETTLED";
        loan.settledAt = Date.now();
        settledLoans.push(loan.loanId);
        totalServicedDurationDays += accrual.daysOutstanding;
      }
    }
  }

  saveAllLoans(all);

  // Synchronize reputation engine & check for tier upgrade
  recordRepaymentInReputation({
    humanOwner: params.humanOwner,
    interestPaid: totalInterestPaid,
    loanDurationDays: totalServicedDurationDays,
  }).catch((err) => console.warn("[LoanStore] Reputation sync warning:", err));

  return {
    amountRepaid: Math.round((params.amount - remainingToApply) * 10000) / 10000,
    beneficiaryAgentAddress: targetAddress,
    settledLoans,
    remainingExcessAmount: remainingToApply,
    interestPaid: totalInterestPaid,
    principalPaid: totalPrincipalPaid,
  };
}
