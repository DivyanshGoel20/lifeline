"use client";

import React, { useEffect, useState } from "react";
import { Agent, Rail } from "@/types";
import { Sheet, Field, ErrorNote } from "./Sheet";
import { CardRepay } from "./CardRepay";
import { swapAndBridge } from "@/lib/tokenRepay";
import { useWallet } from "@/lib/useWallet";

type Method = "agent" | "wallet" | "token" | "card";
const UNBOOKED_KEY = "lifeline_unbooked_repayment";
const METHOD_NAMES: Record<Method, string> = { agent: "Agent's wallet", wallet: "Your wallet", token: "Any token", card: "Apple Pay · Google Pay" };

interface RepayModalProps {
  isOpen: boolean;
  onClose: () => void;
  rail: Rail;
  agents: Agent[];
  onDone: (message: string) => void;
  onSessionExpired: () => void;
}

type Obligation = {
  obligationId: string;
  agentAddress: string;
  suiAgent: string | null;
  status: string;
  owedUsd: number;
  drawnUsd: number;
  ceilingUsd: number | null;
  dueMs: number | null;
  purseUsd: number | null;
  draws: number;
  link: string | null;
};

const shortId = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");

/**
 * Repaying differs by rail. On Arc the debt can be paid three ways, whichever
 * apply: from the agent's own wallet (when Lifeline holds its key), from any
 * wallet the human connects - USDC to Lifeline's treasury, checked on chain -
 * or by card. The facility books it either way. On Sui the debt is a parked
 * obligation: settling early moves the agent's coins into its purse and
 * settles in one transaction the agent signs - or the human pays it by card,
 * and Lifeline sends the agent the shortfall to settle with.
 */
export const RepayModal: React.FC<RepayModalProps> = ({ isOpen, onClose, rail, agents, onDone, onSessionExpired }) => {
  const owing = agents.filter((a) => a.outstandingDebt > 0);
  const [agentAddress, setAgentAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [obligations, setObligations] = useState<Obligation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Who pays: the agent from its wallet, the human from a wallet they connect, or by card.
  const [method, setMethod] = useState<Method>("agent");
  const wallet = useWallet();
  const [card, setCard] = useState<{ enabled: boolean; publishableKey: string | null; minimumUsd: number } | null>(null);
  const [paying, setPaying] = useState(false);
  // Sui: the obligation being paid by card, if any.
  const [cardFor, setCardFor] = useState<Obligation | null>(null);

  useEffect(() => {
    fetch("/api/repay/card")
      .then((r) => r.json())
      .then(setCard)
      .catch(() => setCard(null));
  }, []);

  // Repaying in any token: what Uniswap can swap, and how far along it is.
  const [swap, setSwap] = useState<{ configured: boolean; tokens: string[]; chainName: string } | null>(null);
  const [token, setToken] = useState("ETH");
  const [swapStep, setSwapStep] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/uniswap/repay", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSwap)
      .catch(() => setSwap(null));
  }, [isOpen]);

  const selected = owing.find((a) => a.address === agentAddress);
  const methods: Method[] = [
    ...(selected?.isAutonomous ? (["agent"] as const) : []),
    ...(wallet.available ? (["wallet"] as const) : []),
    ...(wallet.available && swap?.configured ? (["token"] as const) : []),
    ...(card?.enabled ? (["card"] as const) : []),
  ];
  // Keep a method that applies to the agent in hand.
  useEffect(() => {
    if (methods.length && !methods.includes(method)) setMethod(methods[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods.join(","), method]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setPaying(false);
    setCardFor(null);
    if (rail === "arc") {
      const first = owing[0];
      setAgentAddress(first?.address ?? "");
      setAmount(first ? first.outstandingDebt.toFixed(2) : "");
    } else {
      setObligations(null);
      fetch("/api/sui/obligations")
        .then((r) => r.json())
        .then((d) => setObligations((d.obligations ?? []).filter((o: Obligation) => o.owedUsd > 0)))
        .catch(() => setObligations([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, rail]);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      onSessionExpired();
      throw new Error("Your World session expired. Verify again to repay.");
    }
    if (!res.ok || !data.success) throw new Error(data.error || "Repayment did not settle.");
    return data;
  };

  // A wallet transfer that went out but is not booked yet. Kept (here and in
  // the browser) so a failed booking is retried with the same transfer, never
  // by sending the money a second time.
  const [unbooked, setUnbooked] = useState<{ txHash: string; amount: number; agentAddress: string } | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(UNBOOKED_KEY);
      if (saved) setUnbooked(JSON.parse(saved));
    } catch {
      /* nothing saved */
    }
  }, [isOpen]);
  const keepUnbooked = (u: typeof unbooked) => {
    setUnbooked(u);
    try {
      if (u) localStorage.setItem(UNBOOKED_KEY, JSON.stringify(u));
      else localStorage.removeItem(UNBOOKED_KEY);
    } catch {
      /* best effort */
    }
  };

  const arcOwed = owing.reduce((n, a) => n + a.outstandingDebt, 0);

  const repayArc = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseFloat(amount) || 0;
    if (!agentAddress || value <= 0) return;
    if (method === "card") return setPaying(true);
    if ((method === "wallet" || method === "token") && !wallet.address && !unbooked) return wallet.connect();
    if ((method === "wallet" || method === "token") && !unbooked && value > arcOwed + 0.01) {
      return setError(`That is more than is owed ($${arcOwed.toFixed(2)}). The excess would not come back.`);
    }
    setBusy("arc");
    setError(null);
    try {
      // From a connected wallet: USDC to the treasury first, then the hash -
      // which the server checks on Arc before it books anything. A transfer
      // already sent is booked as it is, not sent again.
      let pending = method === "wallet" ? unbooked : null;
      if (method === "wallet" && !pending) {
        const txHash = await wallet.payTreasury(value);
        pending = { txHash, amount: value, agentAddress };
        keepUnbooked(pending);
      }
      if (method === "token") {
        // Swapped and bridged into the person's own wallet, then paid like any wallet
        // repayment, so it passes the same check before anything is booked.
        await swapAndBridge({ eth: wallet.provider()!, wallet: wallet.address!, token, amountUsd: value, post, onStep: setSwapStep });
        setSwapStep("Pay the treasury from your wallet…");
        const txHash = await wallet.payTreasury(value);
        pending = { txHash, amount: value, agentAddress };
        keepUnbooked(pending);
        setSwapStep(null);
      }
      const data = await post("/api/repay", {
        agentAddress: pending?.agentAddress ?? agentAddress,
        amount: pending?.amount ?? value,
        ...(pending ? { txHash: pending.txHash } : {}),
      });
      keepUnbooked(null);
      onDone(`Repaid $${Number(data.amount).toFixed(2)} on Arc`);
      onClose();
    } catch (err: any) {
      // A transfer that was refused for good is not retried forever.
      if (/already been counted|too old|not Lifeline's treasury|reverted|less than/.test(err?.message ?? "")) keepUnbooked(null);
      setError(err?.code === 4001 ? "You declined in your wallet. Nothing was sent." : err.message);
    } finally {
      setBusy(null);
    }
  };

  const settle = async (o: Obligation) => {
    setBusy(o.obligationId);
    setError(null);
    try {
      await post("/api/sui/settle", { obligationId: o.obligationId });
      onDone(`Settled $${o.owedUsd.toFixed(3)} on Sui`);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (addr: string) => agents.find((a) => a.address.toLowerCase() === addr.toLowerCase())?.name ?? addr.slice(0, 10);

  return (
    <Sheet open={isOpen} onClose={onClose} kicker={rail === "arc" ? "Arc · booked on the facility" : "Sui · settle before the date"} title="Repay">
      {rail === "arc" ? (
        owing.length === 0 ? (
          <p className="serif text-[18px]">Nothing is owed on Arc.</p>
        ) : paying && card?.publishableKey ? (
          <CardRepay
            publishableKey={card.publishableKey}
            agentAddress={agentAddress}
            amountUsd={parseFloat(amount) || 0}
            onBooked={(m) => {
              onDone(m);
              onClose();
            }}
            onCancel={() => setPaying(false)}
          />
        ) : (
          <form onSubmit={repayArc} className="space-y-4">
            {methods.length > 1 && (
              <div className={`grid ${methods.length === 3 ? "grid-cols-3" : "grid-cols-2"}`} style={{ border: "1px solid var(--rule)" }}>
                {methods.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMethod(id)}
                    className="h-9 px-1 mono text-[10px] sm:text-[10.5px] uppercase tracking-[0.04em]"
                    style={{
                      background: method === id ? "var(--solid-bg)" : "transparent",
                      color: method === id ? "var(--solid-fg)" : "var(--ink-2)",
                    }}
                  >
                    {METHOD_NAMES[id]}
                  </button>
                ))}
              </div>
            )}
            {methods.length === 0 ? (
              <p className="text-[13px] ink-2 leading-relaxed">
                Lifeline does not hold this agent&apos;s key. Open Lifeline in a browser with a wallet to repay from it, or
                set up card payments.
              </p>
            ) : (
              <p className="text-[13px] ink-2 leading-relaxed">
                {method === "agent"
                  ? "The agent pays from its own Arc wallet; the facility books it."
                  : method === "token"
                    ? `Pay from ${swap?.tokens.join(", ") ?? "other tokens"} on ${swap?.chainName ?? "another chain"}. Uniswap swaps it to USDC and Circle bridges that to Arc. You confirm each step in your wallet, and it takes a minute or two.`
                  : method === "wallet"
                    ? wallet.address
                      ? `From ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}: USDC goes to Lifeline's treasury on Arc, and once the chain confirms it the facility books the repayment.`
                      : "Pay from any wallet you hold - MetaMask, Rabby, Coinbase Wallet. USDC goes to Lifeline's treasury on Arc, checked on chain, then booked."
                    : `You pay by Apple Pay, Google Pay or card, in dollars. Once Stripe confirms it, the repayment is booked on the Arc facility. From $${(card?.minimumUsd ?? 0.5).toFixed(2)}.`}
              </p>
            )}
            <Field label={method === "agent" ? "Paying agent" : "Debt of"}>
              <select
                className="field"
                value={agentAddress}
                onChange={(e) => {
                  setAgentAddress(e.target.value);
                  const a = owing.find((x) => x.address === e.target.value);
                  if (a) setAmount(a.outstandingDebt.toFixed(2));
                }}
              >
                {owing.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name} - owes ${a.outstandingDebt.toFixed(2)}
                  </option>
                ))}
              </select>
            </Field>
            {method === "token" && (
              <Field label="Pay with">
                <select className="field" value={token} onChange={(e) => setToken(e.target.value)}>
                  {swap?.tokens.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>
            )}
            {swapStep && <p className="mono text-[11px] ink-2">{swapStep}</p>}
            <Field label="Amount" hint={method === "card" ? "USD" : "USDC"}>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max={method === "wallet" || method === "token" ? Math.ceil(arcOwed * 100) / 100 : undefined}
                className="field"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            {method === "wallet" && unbooked && (
              <p className="mono text-[10.5px] leading-relaxed" style={{ color: "var(--alarm)" }}>
                ${unbooked.amount.toFixed(2)} was sent from your wallet ({unbooked.txHash.slice(0, 10)}…) but not booked yet. Repay
                books that transfer; nothing is sent again.
              </p>
            )}
            {(error || wallet.error) && <ErrorNote>{error || wallet.error}</ErrorNote>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="btn btn-quiet">
                Cancel
              </button>
              <button type="submit" disabled={!!busy || wallet.connecting || methods.length === 0} className="btn btn-solid">
                {busy
                  ? method === "wallet" || method === "token"
                    ? "Confirm in your wallet…"
                    : "Settling on Arc…"
                  : method === "wallet" && unbooked
                    ? "Book the transfer already sent"
                  : method === "card"
                    ? "Continue to pay"
                    : (method === "wallet" || method === "token") && !wallet.address
                      ? wallet.connecting
                        ? "Connecting…"
                        : "Connect wallet"
                      : "Repay"}
              </button>
            </div>
          </form>
        )
      ) : obligations === null ? (
        <p className="mono text-[11px] ink-3">reading obligations from chain…</p>
      ) : obligations.length === 0 ? (
        <p className="serif text-[18px]">Nothing is owed on Sui.</p>
      ) : (
        cardFor && card?.publishableKey ? (
          <div className="space-y-3">
            <p className="text-[13px] ink-2 leading-relaxed">
              {nameOf(cardFor.agentAddress)}&apos;s obligation, settled whole. You pay what its purse is short; once the payment
              clears, Lifeline puts that in the purse and the agent settles on Sui.
            </p>
            <CardRepay
              publishableKey={card.publishableKey}
              agentAddress={cardFor.agentAddress}
              amountUsd={cardFor.owedUsd}
              obligationId={cardFor.obligationId}
              onBooked={(m) => {
                onDone(m);
                onClose();
              }}
              onCancel={() => setCardFor(null)}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[13px] ink-2 leading-relaxed">
              Each draw is a parked repayment on Sui, due on its date. Settle one early from the agent&apos;s own coins
              {card?.enabled ? ", or pay it by Apple Pay, Google Pay or card" : ""}.
            </p>
            {obligations.map((o) => (
              <div key={o.obligationId} className="pb-4 hair-b space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[14px] min-w-0">
                    {nameOf(o.agentAddress)} owes{" "}
                    <span className="mono" style={{ color: "var(--alarm)" }}>
                      ${o.owedUsd.toFixed(3)}
                    </span>
                  </div>
                  <span className="lab shrink-0" style={{ color: o.status === "defaulted" ? "var(--alarm)" : undefined }}>
                    {o.status}
                  </span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mono text-[10.5px]">
                  <dt className="ink-3">due</dt>
                  <dd>{o.dueMs ? new Date(o.dueMs).toLocaleString() : "-"}</dd>
                  <dt className="ink-3">drawn</dt>
                  <dd>
                    ${o.drawnUsd.toFixed(3)}
                    {o.ceilingUsd != null && <span className="ink-3"> of ${o.ceilingUsd.toFixed(2)} ceiling</span>}
                    <span className="ink-3">
                      {" "}
                      · {o.draws} draw{o.draws === 1 ? "" : "s"}
                    </span>
                  </dd>
                  <dt className="ink-3">purse</dt>
                  <dd>
                    {o.purseUsd != null ? `$${o.purseUsd.toFixed(3)}` : "-"}
                    {o.purseUsd != null && o.purseUsd < o.owedUsd && (
                      <span className="ink-3"> · short ${(o.owedUsd - o.purseUsd).toFixed(3)}</span>
                    )}
                  </dd>
                  <dt className="ink-3">agent</dt>
                  <dd>{shortId(o.suiAgent)}</dd>
                  <dt className="ink-3">obligation</dt>
                  <dd>
                    {o.link ? (
                      <a href={o.link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        {shortId(o.obligationId)} ↗
                      </a>
                    ) : (
                      shortId(o.obligationId)
                    )}
                  </dd>
                </dl>
                <div className="flex flex-wrap justify-end gap-2">
                  {card?.enabled && (
                    <button onClick={() => setCardFor(o)} disabled={!!busy} className="btn btn-quiet">
                      Apple Pay · Google Pay
                    </button>
                  )}
                  <button onClick={() => settle(o)} disabled={!!busy} className="btn btn-solid">
                    {busy === o.obligationId ? "Settling…" : o.status === "defaulted" ? "Cure from agent" : "Settle from agent"}
                  </button>
                </div>
              </div>
            ))}
            {error && <ErrorNote>{error}</ErrorNote>}
          </div>
        )
      )}
    </Sheet>
  );
};
