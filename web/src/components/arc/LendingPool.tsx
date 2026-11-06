"use client";

import React, { useState } from "react";
import { describeError, isDecline, parseAmount, postJson, usd } from "./api";
import type { Wallet } from "./wallet";
import { Bar, ErrorNote, Field, Loading, Note, Readout, Section, useLoad } from "./ui";

type Pool =
  | { configured: false }
  | {
      configured: true;
      pool: string;
      totalAssetsUsd: number;
      cashUsd: number;
      outstandingUsd: number;
      exposureCapUsd: number;
      maxUtilizationBps: number;
      utilizationBps: number;
      drawableUsd: number;
      interestEarnedUsd: number;
      writtenOffUsd: number;
      lenderAssetsUsd?: number;
      lockupSeconds?: number;
      lenderLockedUntil?: number;
    };

export const LendingPool: React.FC<{
  wallet: Wallet;
  refreshTrigger?: number;
  onChanged: (message: string) => void;
}> = ({ wallet, refreshTrigger, onChanged }) => {
  const path = wallet.address ? `/api/pool?lender=${encodeURIComponent(wallet.address)}` : "/api/pool";
  const { data, error, loading, reload } = useLoad<Pool>(path, refreshTrigger);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (action: "deposit" | "withdraw") => {
    const amountUsd = parseAmount(amount);
    if (amountUsd === null) {
      setProblem("Enter an amount above zero, with at most 6 decimals.");
      return;
    }
    setBusy(action);
    setProblem(null);
    setNote(null);
    try {
      const { calls } = await postJson<{ calls: { to: string; data: string }[] }>("/api/pool", { action, amountUsd });
      if (!Array.isArray(calls) || calls.length === 0) throw new Error("Lifeline sent no transaction to sign.");
      await wallet.sendCalls(calls);
      setAmount("");
      onChanged(action === "deposit" ? `Deposited ${usd(amountUsd)} into the pool.` : `Withdrew ${usd(amountUsd)} from the pool.`);
      reload();
    } catch (e) {
      if (isDecline(e)) setNote(describeError(e));
      else setProblem(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const ready = data?.configured === true;
  const lockedUntil = data?.configured ? (data.lenderAssetsUsd ? data.lenderLockedUntil ?? 0 : 0) : 0;
  const locked = lockedUntil * 1000 > Date.now();

  return (
    <Section title="Lending pool" label="lenders earn what borrowers pay">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loading && !data ? <Loading what="the pool" /> : null}
      {data && !data.configured ? <Note>The lending pool is not set up yet. Nothing can be deposited.</Note> : null}

      {data && data.configured ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-5">
            <Readout label="Pool total" value={usd(data.totalAssetsUsd)} />
            <Readout label="Cash" value={usd(data.cashUsd)} />
            <Readout label="Lent out" value={usd(data.outstandingUsd)} />
            <Readout label="Open to draw" value={usd(data.drawableUsd)} />
            <Readout label="Interest earned" value={usd(data.interestEarnedUsd)} />
            <Readout label="Written off" value={usd(data.writtenOffUsd)} tone={data.writtenOffUsd > 0 ? "alarm" : undefined} />
            <Readout label="Exposure cap" value={usd(data.exposureCapUsd)} />
            {typeof data.lenderAssetsUsd === "number" ? (
              <Readout label="Your deposit" value={usd(data.lenderAssetsUsd)} />
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex justify-between lab">
              <span>Utilization {(data.utilizationBps / 100).toFixed(1)}%</span>
              <span>limit {(data.maxUtilizationBps / 100).toFixed(1)}%</span>
            </div>
            <Bar
              label="Pool utilization"
              fraction={data.utilizationBps / 10000}
              limit={data.maxUtilizationBps / 10000}
              alarm={data.utilizationBps >= data.maxUtilizationBps}
            />
          </div>
        </>
      ) : null}

      {ready ? (
        !wallet.available ? (
          <Note>No wallet was found in this browser. Open this page where a wallet is installed to deposit.</Note>
        ) : !wallet.address ? (
          <div className="space-y-2">
            <button className="btn btn-solid" disabled={wallet.connecting} onClick={() => void wallet.connect()}>
              {wallet.connecting ? "Connecting…" : "Connect wallet"}
            </button>
            {wallet.error ? <ErrorNote>{wallet.error}</ErrorNote> : null}
          </div>
        ) : !wallet.onArc ? (
          <div className="space-y-2">
            <Note>Your wallet is on another network. Switch it to Arc Testnet.</Note>
            <button className="btn" onClick={() => void wallet.connect()}>
              Switch to Arc
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Amount (USDC)">
              <input
                className="field"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <button className="btn" disabled={busy !== null || locked} onClick={() => void run("withdraw")}>
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </button>
              <button className="btn btn-solid" disabled={busy !== null} onClick={() => void run("deposit")}>
                {busy === "deposit" ? "Depositing…" : "Deposit"}
              </button>
            </div>
            {locked ? <Note>Your deposit can be withdrawn from {new Date(lockedUntil * 1000).toLocaleString()}.</Note> : null}
            {note ? <Note>{note}</Note> : null}
            {problem ? <ErrorNote>{problem}</ErrorNote> : null}
          </div>
        )
      ) : null}

      <Note>
        Lenders can lose money. If borrowers do not repay, the loss is written off against every lender in the pool.
        Withdrawals can only use cash that is not lent out, and may be locked for a set time after a deposit.
      </Note>
    </Section>
  );
};
