"use client";

import React, { useEffect, useState } from "react";
import { describeError, getJson, parseAmount, postJson, usd } from "./api";
import { ErrorNote, Field, Loading, Note, Readout, Section, useLoad } from "./ui";

type Status =
  | { configured: false; supported: string[] }
  | {
      configured: true;
      supported: string[];
      jar: string;
      worthUsd: number;
      costToClearUsd: number;
      tokens: { token: string; amount: string; worthUsd: number }[];
      limits: { haircutBps: number; maxPerRepaymentUsd: number };
    };
type Quote = { worthUsd: number; creditUsd: number };

/** Pay what is owed with a token the agent holds on Base, through the Uniswap Token Jar. */
export const RepayAnyToken: React.FC<{
  agents: { address: string; name: string }[];
  refreshTrigger?: number;
  onChanged: (message: string) => void;
}> = ({ agents, refreshTrigger, onChanged }) => {
  const { data, error, loading, reload } = useLoad<Status>("/api/jar", refreshTrigger);
  const [agent, setAgent] = useState("");
  const [token, setToken] = useState("WETH");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const selected = agent || agents[0]?.address || "";

  useEffect(() => {
    setQuote(null);
    if (parseAmount(amount) === null || !data?.configured) return;
    const t = setTimeout(() => {
      getJson<Quote>(`/api/jar?token=${token}&amount=${encodeURIComponent(amount.trim())}`)
        .then(setQuote)
        .catch((e) => setProblem(describeError(e)));
    }, 350);
    return () => clearTimeout(t);
  }, [amount, token, data?.configured]);

  const repay = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const done = await postJson<{ repaidUsd: number }>("/api/jar", { agentAddress: selected, token, amount: amount.trim() });
      setAmount("");
      onChanged(`Paid ${usd(done.repaidUsd)} of the debt with ${token}.`);
      reload();
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Repay in any token" label="uniswap token jar · base">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loading && !data ? <Loading what="the jar" /> : null}
      {data && !data.configured ? (
        <Note>
          Not switched on yet. The{" "}
          <a className="underline" target="_blank" rel="noreferrer" href="https://basescan.org/address/0x9282BCCAda9C009CCC4c80e52a0A02b342fc0e8B">
            Token Jar is deployed on Base
          </a>
          , but tokens sent to it are real money and credit here is still on testnet, so repayments wait until credit is on mainnet.
        </Note>
      ) : null}

      {data?.configured ? (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <Readout label="In the jar" value={usd(data.worthUsd)} />
            <Readout label="Clears at" value={usd(data.costToClearUsd)} />
          </div>
          {agents.length === 0 ? (
            <Note>There are no agents to repay for yet.</Note>
          ) : (
            <div className="space-y-3">
              <Field label="Agent">
                <select className="field" value={selected} onChange={(e) => setAgent(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.address} value={a.address}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-[1fr_2fr] gap-3">
                <Field label="Token">
                  <select className="field" value={token} onChange={(e) => setToken(e.target.value)}>
                    {data.supported.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount">
                  <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </Field>
              </div>
              {quote ? (
                <p className="mono text-[11px] ink-2">
                  Worth {usd(quote.worthUsd)} on Uniswap. Pays {usd(quote.creditUsd)} of the debt.
                </p>
              ) : null}
              {problem ? <ErrorNote>{problem}</ErrorNote> : null}
              <div className="flex justify-end">
                <button className="btn btn-solid" disabled={busy || !quote} onClick={() => void repay()}>
                  {busy ? "Sending…" : "Repay"}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}

      <Note>
        The token goes into a jar and does not come back. Your debt falls by what Uniswap says it is worth, less{" "}
        {data?.configured ? (data.limits.haircutBps / 100).toFixed(0) : 3}% in case the price falls before the jar clears.
      </Note>
    </Section>
  );
};
