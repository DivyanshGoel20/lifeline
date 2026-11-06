"use client";

import React, { useCallback, useEffect, useState } from "react";
import { WorldAuthGate } from "@/components/WorldAuthGate";
import { LifelineMark } from "@/components/Pulse";
import { ErrorNote, Readout, Section } from "@/components/arc/ui";

type Debt = { id: string; principalUsd: number; owedUsd: number; status: string; at: number; paymentTx: string };
type Account = {
  configured: boolean;
  explorer: string;
  line: { limitUsd: number; tierName: string; repayments: number; owedUsd: number; headroomUsd: number };
  agents: { address: string; name: string; usdt: number | null }[];
  debts: Debt[];
  catalogue: { id: string; title: string; priceUsd: number; url: string }[];
};

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

/**
 * Lifeline on Whitechain, for the human and their agents.
 *
 * Nothing here asks anyone to hold WBT, sign a transaction, or know what chain this is.
 * The agent buys in USDT, Lifeline's relayer pays the gas, and if the agent is short,
 * Lifeline lends it the price.
 */
export function WhitechainHome() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/whitechain", { cache: "no-store" });
    if (res.status === 401) return setSignedIn(false);
    setSignedIn(true);
    const data = await res.json().catch(() => null);
    if (data?.line) setAccount(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, body: Record<string, unknown>, after?: (d: any) => void) => {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch("/api/whitechain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentAddress: selected, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) throw new Error(data.error || "That did not go through.");
      after?.(data);
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Could not reach Lifeline.");
    } finally {
      setBusy(null);
    }
  };

  const addAgent = async () => {
    setBusy("add");
    setError(null);
    try {
      const res = await fetch("/api/agent/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rail: "arc", label: `agent-${Math.floor(Math.random() * 900 + 100)}`, capUsd: 2 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.agent) throw new Error(data.error || "Could not add an agent.");
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Could not reach Lifeline.");
    } finally {
      setBusy(null);
    }
  };

  if (signedIn === null) {
    return (
      <div className="min-h-screen grid place-items-center">
        <LifelineMark size={22} className="pulse-dot" />
      </div>
    );
  }
  if (!signedIn) return <WorldAuthGate onVerified={() => void load()} />;

  const selected = agent || account?.agents[0]?.address || "";
  const held = account?.agents.find((a) => a.address === selected)?.usdt ?? 0;

  return (
    <div className="min-h-screen">
      <header className="max-w-[1180px] w-full mx-auto px-6 sm:px-10 h-16 flex items-center justify-between rule-b">
        <div className="flex items-center gap-2.5">
          <LifelineMark size={18} />
          <span className="serif text-[25px] leading-none tracking-tight">Lifeline</span>
        </div>
        <div className="flex gap-4 mono text-[11px] ink-3">
          <a href="/arc" className="underline">Arc</a>
          <a href="/whitechain/merchant" className="underline">Merchant view</a>
        </div>
      </header>

      <main className="max-w-[1180px] mx-auto px-6 sm:px-10 py-10">
        <div className="lab mb-3">USDT line · paid in dollars, no gas, no crypto steps</div>
        <h1 className="serif text-[44px] leading-none mb-8">
          {account && account.line.owedUsd > 0 ? (
            <>Owes {usd(account.line.owedUsd)}.</>
          ) : (
            <>
              Resting. <em className="ink-3">Nothing owed.</em>
            </>
          )}
        </h1>

        {error && <div className="mb-6"><ErrorNote>{error}</ErrorNote></div>}
        {account && !account.configured && <ErrorNote>Lifeline is not set up on this network yet.</ErrorNote>}

        {account && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pb-10">
              <Readout label="Headroom" value={usd(account.line.headroomUsd)} />
              <Readout label="Owed" value={usd(account.line.owedUsd)} tone={account.line.owedUsd > 0 ? "alarm" : undefined} />
              <Readout label="Line" value={usd(account.line.limitUsd)} />
              <Readout label="Repayments" value={account.line.repayments} />
            </div>

            <Section title="Your agent" label="it pays, you owe">
              {account.agents.length === 0 ? (
                <button className="btn btn-solid" disabled={busy === "add"} onClick={addAgent}>
                  {busy === "add" ? "Adding…" : "Add an agent"}
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  <select className="field max-w-[260px]" value={selected} onChange={(e) => setAgent(e.target.value)}>
                    {account.agents.map((a) => (
                      <option key={a.address} value={a.address}>{a.name}</option>
                    ))}
                  </select>
                  <span className="mono text-[12px]">holds {usd(held)}</span>
                  <button className="btn btn-quiet" disabled={!!busy} onClick={() => act("earn", { action: "earn" })}>
                    {busy === "earn" ? "Paying…" : "A customer pays it $0.50"}
                  </button>
                  <button className="btn btn-solid" disabled={!!busy || account.line.owedUsd <= 0} onClick={() => act("repay", { action: "repay" })}>
                    {busy === "repay" ? "Repaying…" : `Repay ${usd(account.line.owedUsd)}`}
                  </button>
                </div>
              )}
            </Section>

            <Section title="Buy" label="what the agent sees">
              {account.catalogue.map((item) => {
                const covered = held >= item.priceUsd;
                return (
                  <div key={item.id} className="py-3 hair-b flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[14px]">{item.title}</div>
                      <div className="mono text-[11px] ink-3">
                        {usd(item.priceUsd)} · {covered ? "from the agent's balance" : "on your line"}
                      </div>
                    </div>
                    <button
                      className="btn btn-solid"
                      disabled={!!busy || !selected}
                      onClick={() => act(`buy-${item.id}`, { action: "buy", url: item.url }, setResult)}
                    >
                      {busy === `buy-${item.id}` ? "Paying…" : `Buy for ${usd(item.priceUsd)}`}
                    </button>
                  </div>
                );
              })}
              {result && (
                <div className="pt-4 space-y-2">
                  <div className="mono text-[11px]" style={{ color: result.fundingSource === "LIFELINE_CREDIT" ? "var(--alarm)" : "var(--steady)" }}>
                    {result.fundingSource === "LIFELINE_CREDIT" ? `Paid on credit. You owe ${usd(result.owedUsd)}.` : "Paid by the agent."}
                    {result.paymentTx && (
                      <>
                        {" "}
                        <a className="underline" target="_blank" rel="noreferrer" href={`${account.explorer}/tx/${result.paymentTx}`}>
                          receipt
                        </a>
                      </>
                    )}
                  </div>
                  <pre className="mono text-[11px] leading-relaxed overflow-auto max-h-56 p-3" style={{ background: "var(--ground-2)" }}>
                    {JSON.stringify(result.data?.data ?? result.data, null, 2)}
                  </pre>
                </div>
              )}
            </Section>

            <Section title="Record" label={account.line.tierName.replace(/^Tier \d+:\s*/, "")}>
              {account.debts.length === 0 && <p className="text-[12.5px] ink-3">No credit used yet.</p>}
              {account.debts.map((d) => (
                <div key={d.id} className="py-2 hair-b flex justify-between mono text-[11px]">
                  <span>{new Date(d.at).toLocaleString()}</span>
                  <span style={{ color: d.status === "open" ? "var(--alarm)" : "var(--steady)" }}>
                    {usd(d.principalUsd)} · {d.status === "open" ? `owes ${usd(d.owedUsd)}` : "repaid"}
                  </span>
                </div>
              ))}
            </Section>
          </>
        )}
      </main>
    </div>
  );
}
