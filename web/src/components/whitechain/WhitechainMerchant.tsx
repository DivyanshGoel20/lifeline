"use client";

import React, { useEffect, useState } from "react";
import { LifelineMark } from "@/components/Pulse";
import { ErrorNote, Readout, Section } from "@/components/arc/ui";

type View = {
  configured: boolean;
  explorer: string;
  totalUsd: number;
  receipts: { at: number; description: string; amountUsd: number; payer: string; txHash: string }[];
  relayer: {
    wbt: number | null;
    settledToday: number;
    gasTodayWbt: number;
    limits: { minPaymentUsd: number; maxPaymentUsd: number; perPayerDaily: number; perMerchantDaily: number; totalDaily: number };
  };
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The business's side: it sells to software, is paid in USDT, and sees what it costs.
 * Public, as a merchant dashboard for a shared demo merchant has nothing private in it.
 */
export function WhitechainMerchant() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/whitechain?view=merchant", { cache: "no-store" })
        .then((r) => r.json())
        .then(setView)
        .catch(() => setError("Could not reach Lifeline."));
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen">
      <header className="max-w-[1180px] w-full mx-auto px-6 sm:px-10 h-16 flex items-center justify-between rule-b">
        <div className="flex items-center gap-2.5">
          <LifelineMark size={18} />
          <span className="serif text-[25px] leading-none tracking-tight">Lifeline</span>
        </div>
        <a href="/whitechain" className="mono text-[11px] ink-3 underline">Buyer view</a>
      </header>

      <main className="max-w-[1180px] mx-auto px-6 sm:px-10 py-10">
        <div className="lab mb-3">Merchant · paid in USDT on Whitechain</div>
        <h1 className="serif text-[44px] leading-none mb-8">Software pays you. <em className="ink-3">It never runs short.</em></h1>
        {error && <ErrorNote>{error}</ErrorNote>}

        {view && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pb-10">
              <Readout label="Received" value={`$${view.totalUsd.toFixed(2)}`} tone="steady" />
              <Readout label="Payments" value={view.receipts.length} />
              <Readout label="Settled today" value={view.relayer.settledToday} />
              <Readout label="Gas today" value={`${view.relayer.gasTodayWbt.toFixed(6)} WBT`} />
            </div>

            <Section title="Payments received" label="each one settled before delivery">
              {view.receipts.length === 0 && <p className="text-[12.5px] ink-3">No payments yet.</p>}
              {view.receipts.map((r) => (
                <div key={r.txHash} className="py-2.5 hair-b flex flex-wrap justify-between gap-3 mono text-[11px]">
                  <span>{new Date(r.at).toLocaleString()} · {r.description} · from {short(r.payer)}</span>
                  <a className="underline" target="_blank" rel="noreferrer" href={`${view.explorer}/tx/${r.txHash}`}>
                    ${r.amountUsd.toFixed(2)} ↗
                  </a>
                </div>
              ))}
            </Section>

            <Section title="Who pays the gas" label="and what stops it being drained">
              <p className="text-[13px] ink-2 leading-relaxed max-w-[70ch]">
                Buyers hold no WBT. Lifeline&apos;s relayer pays it, currently holding{" "}
                {view.relayer.wbt === null ? "an unknown amount of" : view.relayer.wbt.toFixed(4)} WBT. It only spends gas after
                checking the signature, the funds and the merchant, so a bad request costs nothing. Payments must be between $
                {view.relayer.limits.minPaymentUsd} and ${view.relayer.limits.maxPaymentUsd}, and go to a registered merchant.
                Each day it settles at most {view.relayer.limits.perPayerDaily} per payer, {view.relayer.limits.perMerchantDaily}{" "}
                per merchant and {view.relayer.limits.totalDaily} in total.
              </p>
            </Section>
          </>
        )}
      </main>
    </div>
  );
}
