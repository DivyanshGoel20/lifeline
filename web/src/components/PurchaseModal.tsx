"use client";

import React, { useEffect, useState } from "react";
import { Agent, Rail } from "@/types";
import { Sheet, Field, ErrorNote } from "./Sheet";
import { Verdict } from "./Verdict";
import { X402Receipt } from "./X402Receipt";
import { WorldAgentApproval } from "./WorldAgentApproval";

type Resource = { path: string; price: number; title: string; artifact?: string };

interface PurchaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  /** Pre-selects the agent when opened from its lead. */
  initialAgent?: string | null;
  rail: Rail;
  headroom: number;
  onDone: (message: string) => void;
  onSessionExpired: () => void;
}

/**
 * An agent hits a paywall. If it holds enough it pays; if not, Lifeline covers
 * the shortfall on the human's line - on Arc through Circle Gateway, on Sui by
 * drawing against a repayment the agent has already parked.
 */
export const PurchaseModal: React.FC<PurchaseModalProps> = ({
  isOpen,
  onClose,
  agents,
  initialAgent,
  rail,
  headroom,
  onDone,
  onSessionExpired,
}) => {
  const [catalogue, setCatalogue] = useState<{ base: string; resources: Resource[] } | null>(null);
  const [agentAddress, setAgentAddress] = useState("");
  const [choice, setChoice] = useState("");
  const [directAmount, setDirectAmount] = useState("0.20");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  // A held payment waiting on a fresh World ID approval.
  const [worldApproval, setWorldApproval] = useState(false);

  // Reset on open and on a rail change only. Keyed on `agents` too, it wiped
  // the receipt the moment the dashboard refreshed after a purchase.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setResult(null);
    setWorldApproval(false);
    setCatalogue(null);
    fetch(rail === "arc" ? "/api/x402/catalogue" : "/api/sui/status")
      .then((r) => r.json())
      .then((d) => {
        const resources: Resource[] = d.resources ?? [];
        setCatalogue({ base: d.base ?? "", resources });
        setChoice(resources[0]?.path ?? (rail === "arc" ? "direct" : ""));
      })
      .catch(() => setCatalogue({ base: "", resources: [] }));
  }, [isOpen, rail]);

  useEffect(() => {
    if (isOpen) setAgentAddress(initialAgent || agents[0]?.address || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialAgent]);

  const selected = catalogue?.resources.find((r) => r.path === choice);
  const price = choice === "direct" ? parseFloat(directAmount) || 0 : selected?.price ?? 0;
  const agent = agents.find((a) => a.address === agentAddress);
  const holds = rail === "arc" ? Number(agent?.gatewayBalanceUSDC ?? 0) : agent?.suiWalletUsd ?? 0;
  const willBorrow = Math.max(0, price - holds);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentAddress || !choice) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const [route, body] =
        choice === "direct"
          ? ["/api/borrow", { agentAddress, amount: price, memo: "dashboard draw" }]
          : [rail === "arc" ? "/api/pay" : "/api/sui/pay", { url: `${catalogue!.base}${choice}`, agentAddress }];

      const res = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        onSessionExpired();
        throw new Error("Your World session expired. Verify again to keep spending.");
      }
      // Intercepta stopped it before signing. Not an error: a verdict to show.
      if (!data.success && data.screening) {
        setResult(data);
        onDone(
          data.hold
            ? `${agent?.name ?? "Agent"}'s payment is held for you - ${data.screening.reasons[0] ?? ""}`
            : `Refused before signing - ${data.screening.reasons[0] ?? ""}`
        );
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || "That did not settle.");

      setResult(data);
      const borrowed = Number(data.borrowed ?? data.amount ?? 0);
      onDone(
        choice === "direct"
          ? `Drew $${price.toFixed(2)} on Arc`
          : borrowed > 0
            ? `${agent?.name ?? "Agent"} bought ${selected?.title} - Lifeline lent $${borrowed.toFixed(3)}`
            : `${agent?.name ?? "Agent"} bought ${selected?.title} and paid for it`
      );
    } catch (err: any) {
      setError(err.message || "Payment failed.");
    } finally {
      setBusy(false);
    }
  };

  const answerHold = async (action: "approve" | "decline") => {
    if (!result?.hold) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay/holds/${result.hold.holdId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        onSessionExpired();
        throw new Error("Your World session expired. Verify again to answer.");
      }
      if (action === "decline") {
        if (!res.ok) throw new Error(data.error || "Could not decline.");
        onDone("Declined. Nothing was signed.");
        return onClose();
      }
      // Releasing it takes a fresh World ID approval, not this click.
      if (data.code === "world_id_required") return setWorldApproval(true);
      if (!data.success) {
        if (data.screening) return setResult(data);
        throw new Error(data.error || "That did not settle.");
      }
      setResult(data);
      onDone(`Approved - ${agent?.name ?? "Agent"} bought ${selected?.title ?? "it"}`);
    } catch (err: any) {
      setError(err.message || "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const link = result?.explorer ?? result?.arcTxLink ?? null;
  const tx = result?.digest ?? result?.arcTxHash ?? result?.txHash ?? result?.circleSettlementId ?? result?.transactionId;
  const onCredit = result && (result.fundingSource === "LIFELINE_CREDIT" || result.fundingSource === "LIFELINE_FACILITY" || choice === "direct");

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      kicker={rail === "arc" ? "Arc · Circle Gateway" : "Sui · parked repayment"}
      title="x402 purchase"
      width={result?.x402 ? 580 : 460}
    >
      {agents.length === 0 ? (
        <p className="serif text-[18px]">Authorize an agent first.</p>
      ) : result && !result.success && result.screening ? (
        <div className="space-y-5">
          <div className="flex items-baseline justify-between rule-b pb-4">
            <span className="serif text-[22px]">{result.hold ? "Held. Your call." : "Refused. Nothing signed."}</span>
            <span className="readout text-[26px]" style={{ color: "var(--alarm)" }}>
              ${Number(result.amount ?? price).toFixed(3)}
            </span>
          </div>
          <Verdict verdict={result.screening} />
          {error && <ErrorNote>{error}</ErrorNote>}
          {worldApproval && result.hold ? (
            <div className="rule-t pt-4">
              <WorldAgentApproval
                holdId={result.hold.holdId}
                onDone={({ approved, message, payment }) => {
                  setWorldApproval(false);
                  onDone(message);
                  if (approved && payment?.success) setResult(payment);
                  else if (payment?.screening) setResult(payment);
                }}
                onCancel={() => setWorldApproval(false)}
              />
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              {result.hold ? (
                <>
                  <button onClick={() => answerHold("decline")} disabled={busy} className="btn btn-quiet">
                    Decline
                  </button>
                  <button onClick={() => answerHold("approve")} disabled={busy} className="btn btn-solid">
                    {busy ? "Settling…" : "Approve and pay"}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setResult(null)} className="btn btn-quiet">
                    Back
                  </button>
                  <button onClick={onClose} className="btn btn-solid">
                    Done
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      ) : result ? (
        <div className="space-y-5">
          <div className="flex items-baseline justify-between rule-b pb-4">
            <span className="serif text-[22px]">{onCredit ? "Paid, on credit." : "Paid by the agent."}</span>
            <span className="readout text-[26px]" style={{ color: onCredit ? "var(--alarm)" : "var(--steady)" }}>
              ${Number(result.amount ?? price).toFixed(3)}
            </span>
          </div>
          <dl className="grid grid-cols-[120px_1fr] gap-y-2.5 mono text-[11px]">
            {Number(result.borrowed ?? 0) > 0 && (
              <>
                <dt className="ink-3">lent</dt>
                <dd style={{ color: "var(--alarm)" }}>${Number(result.borrowed).toFixed(3)}</dd>
              </>
            )}
            {result.obligationId && (
              <>
                <dt className="ink-3">obligation</dt>
                <dd className="truncate">{result.obligationId}</dd>
              </>
            )}
            {result.dueMs && (
              <>
                <dt className="ink-3">due</dt>
                <dd>{new Date(result.dueMs).toLocaleString()}</dd>
              </>
            )}
            {tx && (
              <>
                <dt className="ink-3">settled</dt>
                <dd className="truncate">
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                      {String(tx).slice(0, 22)}… ↗
                    </a>
                  ) : (
                    String(tx)
                  )}
                </dd>
              </>
            )}
          </dl>
          {result.screening && <Verdict verdict={result.screening} />}
          {result.x402 && (
            <div className="rule-t pt-4">
              <X402Receipt trace={result.x402} data={result.data} settlementLink={result.explorer ?? null} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setResult(null)} className="btn btn-quiet">
              Buy another
            </button>
            <button onClick={onClose} className="btn btn-solid">
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Agent">
            <select className="field" value={agentAddress} onChange={(e) => setAgentAddress(e.target.value)}>
              {agents.map((a) => (
                <option key={a.address} value={a.address} disabled={rail === "sui" && !a.suiAddress}>
                  {a.name}
                  {rail === "sui" && !a.suiAddress ? " - no Sui key" : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Resource" hint={catalogue ? `${catalogue.resources.length} for sale` : "loading…"}>
            {catalogue && catalogue.resources.length === 0 && rail === "sui" ? (
              <div className="mono text-[11px] ink-3 py-2">The Sui feed is not running (npm run sui:service).</div>
            ) : (
              <select className="field" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!catalogue}>
                {catalogue?.resources.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.title} - ${r.price.toFixed(3)}
                  </option>
                ))}
                {rail === "arc" && <option value="direct">Direct draw - no purchase</option>}
              </select>
            )}
          </Field>

          {choice === "direct" && (
            <Field label="Amount" hint="USDC">
              <input type="number" step="0.01" min="0.01" className="field" value={directAmount} onChange={(e) => setDirectAmount(e.target.value)} />
            </Field>
          )}

          <div className="grid grid-cols-3 rule-t pt-4">
            <div>
              <div className="lab mb-1.5">price</div>
              <div className="readout text-[20px]">${price.toFixed(3)}</div>
            </div>
            <div>
              <div className="lab mb-1.5">agent holds</div>
              <div className="readout text-[20px]">${holds.toFixed(2)}</div>
            </div>
            <div>
              <div className="lab mb-1.5">would borrow</div>
              <div className="readout text-[20px]" style={{ color: willBorrow > 0 ? "var(--alarm)" : "var(--ink-3)" }}>
                ${willBorrow.toFixed(3)}
              </div>
            </div>
          </div>
          <div className="mono text-[10.5px] ink-3">${headroom.toFixed(2)} of headroom left on the {rail === "arc" ? "Arc" : "Sui"} line</div>

          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn btn-quiet">
              Cancel
            </button>
            <button type="submit" disabled={busy || !choice || price <= 0} className="btn btn-solid">
              {busy ? "Settling…" : choice === "direct" ? "Draw" : "Buy"}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
};
