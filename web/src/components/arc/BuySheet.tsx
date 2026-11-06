"use client";

import React, { useEffect, useState } from "react";
import type { Agent } from "@/types";
import { Sheet, Field, ErrorNote } from "../Sheet";
import type { MarketService } from "./Marketplace";
import { price } from "./api";

/** An agent buys a marketplace service: from its own balance, or on the human's line. */
export const BuySheet: React.FC<{
  service: MarketService | null;
  agents: Agent[];
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ service, agents, onClose, onDone }) => {
  const arcAgents = agents.filter((a) => (a.rail ?? "arc") === "arc");
  const [agent, setAgent] = useState("");
  const [body, setBody] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const firstAgent = arcAgents[0]?.address ?? "";

  useEffect(() => {
    if (!service) return;
    setAgent(firstAgent);
    setBody("{}");
    setError(null);
    setResult(null);
  }, [service, firstAgent]);

  if (!service) return null;
  const isPost = service.method.toUpperCase() !== "GET";

  const buy = async () => {
    let parsed: unknown;
    if (isPost) {
      try {
        parsed = JSON.parse(body);
      } catch {
        return setError("The request body must be valid JSON.");
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: service.url, agentAddress: agent, method: service.method, ...(isPost ? { body: parsed } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onDone("Held for you to approve. See Counterparties.");
        return onClose();
      }
      if (!res.ok || !data.success) return setError(data.error ?? data.screening?.reasons?.[0] ?? "The purchase did not go through.");
      setResult(data);
      onDone(`Bought from ${service.provider}: ${data.fundingSource === "LIFELINE_FACILITY" ? "on your line" : "from the agent's balance"}.`);
    } catch (err: any) {
      setError(`Could not reach Lifeline: ${err?.message ?? "network error"}. Nothing was changed.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title={service.provider} kicker={`marketplace · ${price(service.priceUsd)}`}>
      <div className="space-y-4">
        <p className="text-[12.5px] ink-2 leading-snug">{service.description}</p>
        <div className="mono text-[11px] ink-3 break-all">{service.method} {service.url}</div>
        {service.needsSignIn && (
          <p className="text-[12.5px] ink-2 leading-snug">
            This seller also asks for a wallet sign-in. It may refuse the request even after payment is offered.
          </p>
        )}
        {result ? (
          <pre className="mono text-[11px] leading-relaxed overflow-auto max-h-64 p-3" style={{ background: "var(--ground-2)" }}>
            {JSON.stringify(result.data ?? result, null, 2)}
          </pre>
        ) : (
          <>
            <Field label="Agent">
              <select className="field" value={agent} onChange={(e) => setAgent(e.target.value)}>
                {arcAgents.length === 0 && <option value="">No Arc agents yet</option>}
                {arcAgents.map((a) => (
                  <option key={a.address} value={a.address}>{a.name}</option>
                ))}
              </select>
            </Field>
            {isPost && (
              <Field label="Request body (JSON)">
                <textarea className="field mono" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex justify-end">
              <button className="btn btn-solid" disabled={busy || !agent} onClick={buy}>
                {busy ? "Paying…" : `Buy for ${price(service.priceUsd)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
};
