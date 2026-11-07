"use client";

import React, { useEffect, useState } from "react";
import { describeError, getJson, parseAmount, postJson, usd } from "./api";
import { ErrorNote, Field, Loading, Note, Readout, Section, useLoad } from "./ui";

type Status = {
  open: boolean;
  supported: string[];
  jar: string;
  releaser: string;
  worthUsd?: number;
  costToClearUsd?: number;
  nonce?: string;
  limits: { haircutBps: number; maxPerRepaymentUsd: number };
};
type Quote = { worthUsd: number; creditUsd: number };

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const ContractLink: React.FC<{ name: string; address: string }> = ({ name, address }) => (
  <div className="flex items-baseline justify-between gap-4">
    <span className="mono text-[11px] ink-2">{name}</span>
    <a className="mono text-[11px] underline" target="_blank" rel="noreferrer" href={`https://basescan.org/address/${address}`}>
      {short(address)}
    </a>
  </div>
);

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
    setProblem(null);
    if (parseAmount(amount) === null) return;
    let current = true;
    const t = setTimeout(() => {
      getJson<Quote>(`/api/jar?token=${token}&amount=${encodeURIComponent(amount.trim())}`)
        .then((q) => current && setQuote(q))
        .catch((e) => current && setProblem(describeError(e)));
    }, 350);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [amount, token]);

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
    <Section title="Repay in any token" label="uniswap token jar · base mainnet">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loading && !data ? <Loading what="the jar" /> : null}

      {data ? (
        <>
          {data.worthUsd !== undefined ? (
            <div className="grid grid-cols-3 gap-x-6 gap-y-5">
              <Readout label="In the jar" value={usd(data.worthUsd)} />
              <Readout label="Clears at" value={usd(data.costToClearUsd ?? 0)} />
              <Readout label="Times cleared" value={data.nonce ?? "0"} />
            </div>
          ) : (
            <Note>Base did not answer just now, so the balance is not shown.</Note>
          )}

          <div className="space-y-1">
            <ContractLink name="Lifeline Token Jar" address={data.jar} />
            <ContractLink name="ExchangeReleaser" address={data.releaser} />
          </div>

          <div className="space-y-3">
            {data.open && agents.length > 0 ? (
              <Field label="Agent">
                <select className="field" value={selected} onChange={(e) => setAgent(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.address} value={a.address}>{a.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
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
            {data.open && agents.length > 0 ? (
              <div className="flex justify-end">
                <button className="btn btn-solid" disabled={busy || !quote} onClick={() => void repay()}>
                  {busy ? "Sending…" : "Repay"}
                </button>
              </div>
            ) : null}
          </div>

          {data.open ? null : (
            <Note>
              Prices are live from Uniswap on Base. Sending opens when credit moves to Arc mainnet: these tokens are real money,
              and credit here is on testnet.
            </Note>
          )}
          <Note>
            The token goes into a jar and does not come back. Your debt falls by what Uniswap says it is worth, less{" "}
            {(data.limits.haircutBps / 100).toFixed(0)}% in case the price falls before the jar clears.
          </Note>
        </>
      ) : null}
    </Section>
  );
};
