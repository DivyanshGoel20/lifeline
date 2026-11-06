"use client";

import React, { useEffect, useState } from "react";
import { usd } from "./api";
import { ErrorNote, Field, Loading, Note, Section, useLoad } from "./ui";

export type MarketService = {
  url: string;
  method: string;
  description: string;
  provider: string;
  category: string;
  priceUsd: number;
  payTo: string;
  needsSignIn: boolean;
  quality: { score: number; samples: number; poor: boolean };
};

type Discover = { network: string; total: number; services: MarketService[] };

/** Delivery score may arrive as 0..1 or 0..100. */
const deliveredPercent = (score: number) => Math.round(score <= 1 ? score * 100 : score);

export const Marketplace: React.FC<{
  onBuy: (service: MarketService) => void;
  refreshTrigger?: number;
}> = ({ onBuy, refreshTrigger }) => {
  const [query, setQuery] = useState("");
  const [maxUsd, setMaxUsd] = useState("");
  const [term, setTerm] = useState({ query: "", maxUsd: "" });
  const max = term.maxUsd !== "" && Number(term.maxUsd) >= 0 ? term.maxUsd : "";
  const { data, error, loading } = useLoad<Discover>(
    `/api/x402/discover?limit=20&query=${encodeURIComponent(term.query)}&maxUsd=${encodeURIComponent(max)}`,
    refreshTrigger,
  );

  // Wait for a pause in typing before asking.
  useEffect(() => {
    const t = setTimeout(() => setTerm({ query: query.trim(), maxUsd: maxUsd.trim() }), 350);
    return () => clearTimeout(t);
  }, [query, maxUsd]);

  const services = data?.services ?? [];

  return (
    <Section title="Marketplace" label={data ? `${data.total} services · ${data.network}` : "x402 services"}>
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <Field label="Search">
          <input
            className="field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do you need?"
          />
        </Field>
        <Field label="Max price (USD)">
          <input
            className="field"
            inputMode="decimal"
            value={maxUsd}
            onChange={(e) => setMaxUsd(e.target.value)}
            placeholder="any"
          />
        </Field>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loading && !data ? <Loading what="services" /> : null}
      {!loading && !error && services.length === 0 ? (
        <Note>{term.query || term.maxUsd ? "No service matches that search." : "No services are listed right now."}</Note>
      ) : null}

      {services.map((s) => (
        <div key={`${s.method}:${s.url}`} className="py-3 hair-b space-y-2">
          <div className="flex justify-between gap-4 mono text-[11px]">
            <span className="truncate">{s.provider}</span>
            <span className="shrink-0">
              {usd(s.priceUsd)} · {s.method}
            </span>
          </div>
          <p className="text-[12.5px] ink-2 leading-snug">{s.description || "No description."}</p>
          <div className="flex items-center justify-between gap-3">
            <div className="mono text-[10.5px] flex flex-wrap gap-x-4 gap-y-1">
              {s.quality.poor ? (
                <span style={{ color: "var(--alarm)" }}>
                  {s.quality.samples < 5 ? "no record yet" : `delivered ${deliveredPercent(s.quality.score)}%`} · not
                  lent against
                </span>
              ) : (
                <span className="ink-3">
                  {s.quality.samples < 5 ? "no record yet" : `delivered ${deliveredPercent(s.quality.score)}%`}
                </span>
              )}
              {s.needsSignIn ? <span className="ink-3">needs sign-in</span> : null}
              {s.category ? <span className="ink-3">{s.category}</span> : null}
            </div>
            <button className="btn btn-solid" onClick={() => onBuy(s)}>
              Buy
            </button>
          </div>
        </div>
      ))}
    </Section>
  );
};
