"use client";

import { ARC_NAME } from "@/lib/arc";
import React, { useEffect, useRef, useState } from "react";
import {
  ZERO_ADDRESS,
  describeError,
  getJson,
  isDecline,
  parseAmount,
  postJson,
  sameAddress,
  shortAddress,
  usd,
} from "./api";
import type { Wallet } from "./wallet";
import { ErrorNote, Field, Loading, Note, Readout, Section, useLoad } from "./ui";

type Secured =
  | { configured: false }
  | {
      configured: true;
      vault: string;
      assetsUsd: number;
      creditUsd: number;
      controller: string;
      pendingWithdrawalUsd: number;
      /** Unix seconds. */
      readyAt: number;
      line: { totalCreditLimit: number };
    };

type Calls = { calls: { to: string; data: string }[] };

const timeLeft = (seconds: number) => {
  if (seconds <= 0) return "ready now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m left` : m > 0 ? `${m}m ${String(s).padStart(2, "0")}s left` : `${s}s left`;
};

export const SecuredCredit: React.FC<{
  wallet: Wallet;
  refreshTrigger?: number;
  onChanged: (message: string) => void;
}> = ({ wallet, refreshTrigger, onChanged }) => {
  const { data, error, loading, reload } = useLoad<Secured>("/api/secured", refreshTrigger);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // The second call from a withdrawal request, kept so the final step needs no new request.
  const finalCall = useRef<{ to: string; data: string } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  /** Run one action: report a decline as a note, anything else as an error. */
  const act = async (name: string, work: () => Promise<string>) => {
    setBusy(name);
    setProblem(null);
    setNote(null);
    try {
      const message = await work();
      onChanged(message);
      reload();
    } catch (e) {
      if (isDecline(e)) setNote(describeError(e));
      else setProblem(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const sync = () => postJson("/api/secured", { action: "sync" });

  if (loading && !data) {
    return (
      <Section title="Deposit-backed credit" label="your deposit raises your line">
        <Loading what="your deposit" />
      </Section>
    );
  }

  const address = wallet.address;
  const secured = data && data.configured ? data : null;

  const link = () =>
    act("link", async () => {
      if (!address) throw new Error("Connect a wallet first.");
      const { nonce } = await getJson<{ nonce: string }>("/api/auth/wallet/nonce");
      const signature = await wallet.signMessage(`Link this wallet to my Lifeline account.\nNonce: ${nonce}`);
      await postJson("/api/secured", { action: "link", wallet: address, signature });
      await postJson("/api/secured", { action: "bind", wallet: address });
      return "This wallet now controls your deposit.";
    });

  const deposit = () => {
    const amountUsd = parseAmount(depositAmount);
    if (amountUsd === null) return setProblem("Enter an amount above zero, with at most 6 decimals.");
    return act("deposit", async () => {
      const { calls } = await postJson<Calls>("/api/secured", { action: "deposit", amountUsd });
      if (!calls?.length) throw new Error("Lifeline sent no transaction to sign.");
      await wallet.sendCalls(calls);
      await sync();
      setDepositAmount("");
      return `Deposited ${usd(amountUsd)}. Your line grows once it settles.`;
    });
  };

  const requestWithdrawal = () => {
    const amountUsd = parseAmount(withdrawAmount);
    if (amountUsd === null) return setProblem("Enter an amount above zero, with at most 6 decimals.");
    if (!address) return;
    return act("request", async () => {
      const { calls } = await postJson<Calls>("/api/secured", { action: "withdraw", amountUsd, to: address });
      if (!calls || calls.length < 2) throw new Error("Lifeline sent an incomplete withdrawal.");
      finalCall.current = calls[1];
      await wallet.sendCalls([calls[0]]);
      await sync();
      setWithdrawAmount("");
      return `Withdrawal of ${usd(amountUsd)} requested. It can be taken once the wait is over.`;
    });
  };

  const completeWithdrawal = (pendingUsd: number) => {
    if (!address) return;
    return act("withdraw", async () => {
      let call = finalCall.current;
      if (!call) {
        const { calls } = await postJson<Calls>("/api/secured", { action: "withdraw", amountUsd: pendingUsd, to: address });
        if (!calls || calls.length < 2) throw new Error("Lifeline sent an incomplete withdrawal.");
        call = calls[1];
      }
      await wallet.sendCalls([call]);
      finalCall.current = null;
      await sync();
      return `Withdrew ${usd(pendingUsd)} to your wallet.`;
    });
  };

  const cancel = () =>
    act("cancel", async () => {
      const { calls } = await postJson<Calls>("/api/secured", { action: "cancel" });
      if (!calls?.length) throw new Error("Lifeline sent no transaction to sign.");
      await wallet.sendCalls(calls);
      finalCall.current = null;
      await sync();
      return "Withdrawal cancelled. Your deposit stays in place.";
    });

  const body = () => {
    if (!data) return null;
    if (!secured) return <Note>Deposit-backed credit is not set up yet.</Note>;

    const unbound = sameAddress(secured.controller, ZERO_ADDRESS);
    const mine = sameAddress(secured.controller, address);
    const pending = secured.pendingWithdrawalUsd;
    const wait = Math.max(0, secured.readyAt - now);

    if (!wallet.available) return <Note>No wallet was found in this browser. Open this page where a wallet is installed.</Note>;

    if (!address)
      return (
        <div className="space-y-2">
          <Note>Connect the wallet you want to deposit from.</Note>
          <button className="btn btn-solid" disabled={wallet.connecting} onClick={() => void wallet.connect()}>
            {wallet.connecting ? "Connecting…" : "Connect wallet"}
          </button>
          {wallet.error ? <ErrorNote>{wallet.error}</ErrorNote> : null}
        </div>
      );

    if (!wallet.onArc)
      return (
        <div className="space-y-2">
          <Note>Your wallet is on another network. Switch it to {ARC_NAME}.</Note>
          <button className="btn" onClick={() => void wallet.connect()}>
            Switch to Arc
          </button>
        </div>
      );

    if (unbound)
      return (
        <div className="space-y-3">
          <Note>
            No wallet controls this deposit yet. Sign a message to link {shortAddress(address)} to your account. It
            costs nothing.
          </Note>
          <button className="btn btn-solid" disabled={busy !== null} onClick={() => void link()}>
            {busy === "link" ? "Linking…" : "Use this wallet"}
          </button>
        </div>
      );

    if (!mine)
      return (
        <Note>
          This deposit is controlled by another wallet, {shortAddress(secured.controller)}. Connect that wallet to
          deposit or withdraw.
        </Note>
      );

    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Field label="Deposit (USDC)">
            <input
              className="field"
              inputMode="decimal"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <div className="flex justify-end">
            <button className="btn btn-solid" disabled={busy !== null} onClick={() => void deposit()}>
              {busy === "deposit" ? "Depositing…" : "Deposit"}
            </button>
          </div>
        </div>

        <div className="space-y-3 pt-5 rule-t">
          {pending > 0 ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="lab">Withdrawal waiting</span>
                <span className="mono text-[11px]">
                  {usd(pending)} · {timeLeft(wait)}
                </span>
              </div>
              <div className="flex justify-end gap-2">
                <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void cancel()}>
                  {busy === "cancel" ? "Cancelling…" : "Cancel"}
                </button>
                <button
                  className="btn btn-solid"
                  disabled={busy !== null || wait > 0}
                  onClick={() => void completeWithdrawal(pending)}
                >
                  {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
                </button>
              </div>
            </>
          ) : (
            <>
              <Field label="Withdraw (USDC)" hint={`up to ${usd(secured.assetsUsd)}`}>
                <input
                  className="field"
                  inputMode="decimal"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <div className="flex justify-end">
                <button className="btn" disabled={busy !== null} onClick={() => void requestWithdrawal()}>
                  {busy === "request" ? "Requesting…" : "Request withdrawal"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <Section title="Deposit-backed credit" label="your deposit raises your line">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {secured ? (
        <div className="grid grid-cols-3 gap-x-6">
          <Readout label="Deposited" value={usd(secured.assetsUsd)} />
          <Readout label="Credit it adds" value={usd(secured.creditUsd)} />
          <Readout label="Credit line" value={usd(secured.line.totalCreditLimit)} />
        </div>
      ) : null}

      {body()}

      {note ? <Note>{note}</Note> : null}
      {problem ? <ErrorNote>{problem}</ErrorNote> : null}

      <Note>
        A deposit raises your credit line. If you default, it pays your debt. Withdrawals wait while drawdowns settle.
      </Note>
    </Section>
  );
};
