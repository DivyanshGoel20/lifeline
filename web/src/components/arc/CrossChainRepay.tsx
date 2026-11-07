"use client";

import React, { useState } from "react";
import { bridgeFromWallet } from "@/lib/tokenRepay";
import { describeError, parseAmount, postJson, shortAddress, usd } from "./api";
import type { Wallet } from "./wallet";
import { ErrorNote, Field, Note, Section } from "./ui";

const CHAINS: { id: string; name: string }[] = [
  { id: "Ethereum_Sepolia", name: "Ethereum Sepolia" },
  { id: "Base_Sepolia", name: "Base Sepolia" },
  { id: "Arbitrum_Sepolia", name: "Arbitrum Sepolia" },
];

type Step = { name: string; state: string; txHash?: string };
type Result = { success: boolean; bridgedUsd: number; repaidUsd: number; steps: Step[]; error?: string };

export const CrossChainRepay: React.FC<{
  wallet: Wallet & { provider: () => any; payTreasury: (usd: number) => Promise<string> };
  agents: { address: string; name: string }[];
  onChanged: (message: string) => void;
}> = ({ wallet, agents, onChanged }) => {
  // Whose money: yours, in the wallet you connect, or what the agent holds there.
  const [source, setSource] = useState<"wallet" | "agent">("wallet");
  const [step, setStep] = useState<string | null>(null);
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
    if (source === "wallet") {
      try {
        if (!wallet.address) {
          await wallet.connect();
          return;
        }
        const { arrivedUsd, steps } = await bridgeFromWallet({ eth: wallet.provider(), wallet: wallet.address, fromChain: chain, amountUsd, onStep: setStep });
        setStep("Pay the treasury from your wallet…");
        const txHash = await wallet.payTreasury(arrivedUsd);
        setStep("Booking the repayment…");
        const booked = await postJson<{ amount: number }>("/api/repay", { agentAddress: chosen, amount: arrivedUsd, txHash });
        const repaid = Number(booked.amount ?? arrivedUsd);
        setResult({ success: true, bridgedUsd: arrivedUsd, repaidUsd: repaid, steps });
        onChanged(`Repaid ${usd(repaid)} from ${CHAINS.find((c) => c.id === chain)?.name ?? chain}.`);
        setAmount("");
      } catch (e) {
        setProblem(describeError(e));
      } finally {
        setStep(null);
        setBusy(false);
      }
      return;
    }
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
          <Field label="Pay from">
            <select className="field" value={source} onChange={(e) => setSource(e.target.value as "wallet" | "agent")} disabled={busy}>
              <option value="wallet">{wallet.address ? `Your wallet · ${shortAddress(wallet.address)}` : "Your wallet"}</option>
              <option value="agent">The agent&apos;s wallet</option>
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Debt of">
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
            {source === "wallet"
              ? "Your wallet needs this much USDC and a little ETH for gas on the chain you pick, and a little USDC on Arc for gas. You confirm each step."
              : "The agent's own wallet needs this much USDC, plus ETH for gas, on the chain you pick. Lifeline signs for it."}{" "}
            Circle bridges it to Arc and the debt is repaid. It usually takes under a minute.
          </Note>
          <div className="flex justify-end">
            <button className="btn btn-solid" disabled={busy} onClick={() => void submit()}>
              {busy ? "Bridging and repaying…" : source === "wallet" && !wallet.address ? "Connect wallet" : "Repay"}
            </button>
          </div>
        </>
      )}

      {step ? <p className="mono text-[11px] ink-2">{step}</p> : null}
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
