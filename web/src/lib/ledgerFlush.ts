import { fundLoanFromPool } from "./poolFunding";
import { executeOnChainDrawdown } from "./facilityContract";
import {
  claimForFlush,
  dropBatch,
  releaseBatch,
  shouldFlush,
  type PendingDrawdown,
} from "./pendingLedger";
import { attachBorrowTx } from "./loanStore";

/**
 * Settling accumulated nanopayments as one drawdown.
 *
 * The whole saving is here: one row, one write, one gas bill, covering however
 * many payments have piled up since the last flush.
 */
export interface FlushResult {
  flushed: boolean;
  txHash?: string;
  paymentCount?: number;
  amountUsdc?: number;
  reason?: string;
}

export async function flushAgent(
  humanOwner: string,
  agentAddress: string,
  opts?: { force?: boolean }
): Promise<FlushResult> {
  if (!opts?.force && !shouldFlush(humanOwner, agentAddress)) {
    return { flushed: false, reason: "below threshold" };
  }

  const { batchId, entries } = claimForFlush(humanOwner, agentAddress);
  if (entries.length === 0) return { flushed: false, reason: "nothing pending" };

  const amountUsdc = round(entries.reduce((n, e) => n + e.amountUsdc, 0));

  try {
    const result = await executeOnChainDrawdown({
      agentAddress,
      humanOwner,
      amountUsdc,
      paymentReference: entries.length === 1 ? entries[0].reference : "x402-batch",
      paymentCount: entries.length,
      // The money already reached the seller on each individual payment; this
      // is only the ledger catching up.
      disburse: false,
    });

    // Entries only leave the store once the write is confirmed, so a crash
    // between the two leaves them claimed and recoverable rather than lost.
    dropBatch(batchId);
    backfillLoans(entries, result.txHash);
    // Batched with the drawdowns, so a cent purchase does not pay gas of its own.
    await fundLoanFromPool(amountUsdc);

    return {
      flushed: true,
      txHash: result.txHash,
      paymentCount: entries.length,
      amountUsdc,
    };
  } catch (err: any) {
    releaseBatch(batchId);
    const reason = err?.shortMessage || err?.message || String(err);
    console.error(`[LedgerFlush] Could not settle ${entries.length} payment(s):`, reason);
    return { flushed: false, reason };
  }
}

/** Loans created while pending carry no tx hash until their batch lands. */
function backfillLoans(entries: PendingDrawdown[], txHash: string) {
  try {
    attachBorrowTx(
      entries.map((e) => e.loanId).filter((id): id is string => !!id),
      txHash
    );
  } catch {
    // The loan record is a convenience; the chain is the ledger of record.
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
