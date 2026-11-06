"use client";

import React, { useState } from "react";
import { describeError, parseAmount, postJson, shortAddress, usd } from "./api";
import { ErrorNote, Field, Note, Section } from "./ui";

const CHAINS: { id: string; name: string }[] = [
  { id: "Ethereum_Sepolia", name: "Ethereum Sepolia" },
  { id: "Base_Sepolia", name: "Base Sepolia" },
  { id: "Arbitrum_Sepolia", name: "Arbitrum Sepolia" },
];

type Step = { name: string; state: string; txHash?: string };
type Result = { success: boolean; bridgedUsd: number; repaidUsd: number; steps: Step[]; error?: string };

export const CrossChainRepay: React.FC<{
  agents: { address: string; name: string }[];
  onChanged: (message: string) => void;
}> = ({ agents, onChanged }) => {
  const [agent, setAgent] = useState("");
  const [chain, setChain] = useState(CHAINS[0].id);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const chosen = agent || agents[0]?.address || "";

  const submit = async () => {
    const amountUsd = parseAmount(amount);
    if (!chosen) return setProblem("Choose an agent.");
    if (amountUsd === null) return setProblem("Enter an amount above zero, with at most 6 decimals.");
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      const r = await postJson<Result>("/api/repay/crosschain", {
        agentAddress: chosen,
        fromChain: chain,
        amountUsd,
      });
      setResult(r);
      if (r.success) {
        onChanged(`Repaid ${usd(r.repaidUsd)} from ${CHAINS.find((c) => c.id === chain)?.name ?? chain}.`);
        setAmount("");
      }
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Repay from another chain" label="bridge, then repay">
      {agents.length === 0 ? (
        <Note>There are no agents to repay for yet.</Note>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Agent">
              <select className="field" value={chosen} onChange={(e) => setAgent(e.target.value)} disabled={busy}>
                {agents.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name} · {shortAddress(a.address)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From chain">
              <select className="field" value={chain} onChange={(e) => setChain(e.target.value)} disabled={busy}>
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Amount (USDC)">
            <input
              className="field"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              disabled={busy}
            />
          </Field>
          <Note>
            The agent needs this much USDC, plus gas, on the chain you pick. Lifeline bridges it to Arc and repays the
            debt. This can take a few minutes.
          </Note>
          <div className="flex justify-end">
            <button className="btn btn-solid" disabled={busy} onClick={() => void submit()}>
              {busy ? "Bridging and repaying…" : "Repay"}
            </button>
          </div>
        </>
      )}

      {problem ? <ErrorNote>{problem}</ErrorNote> : null}

      {result ? (
        <div className="space-y-2">
          {result.steps.map((s, i) => (
            <div key={`${s.name}-${i}`} className="flex justify-between gap-4 py-2 hair-b mono text-[11px]">
              <span>{s.name}</span>
              <span
                style={{
                  color: /fail|error|revert/i.test(s.state)
                    ? "var(--alarm)"
                    : /complete|success|done|confirmed/i.test(s.state)
                      ? "var(--steady)"
                      : undefined,
                }}
              >
                {s.state}
                {s.txHash ? ` · ${shortAddress(s.txHash)}` : ""}
              </span>
            </div>
          ))}
          {result.success ? (
            <p className="mono text-[11.5px]">
              Bridged {usd(result.bridgedUsd)}. Repaid {usd(result.repaidUsd)}.
            </p>
          ) : (
            <ErrorNote>{result.error ?? "The repayment did not finish. Check the steps above."}</ErrorNote>
          )}
        </div>
      ) : null}
    </Section>
  );
};
