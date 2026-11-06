"use client";

import React, { useEffect, useState } from "react";

type Tier = { tierNumber: number; name: string; creditLimit: number; requiredInterestPaid: number; requiredActiveDurationDays: number; requiredRepaymentsCount: number };
type Summary = {
  currentTier: Tier;
  nextTier: Tier | null;
  reputationScore: number;
  totalInterestPaid: number;
  totalActiveDurationDays: number;
  repaymentsCount: number;
  oldestActiveLoan: { totalDue: number; hoursRemaining: number; isOverdue: boolean; isDueSoon: boolean } | null;
};

const left = (hours: number) => {
  if (hours <= 0) return "overdue";
  const d = Math.floor(hours / 24);
  return d > 0 ? `${d}d ${hours % 24}h` : `${hours}h`;
};

/**
 * The human's record on one rail. The line grows by repaying on time, never by
 * asking, so this is what a larger limit is waiting on. Arc and Sui are
 * separate lines with separate records.
 */
export const Underwriting: React.FC<{
  humanOwner: string;
  rail?: "arc" | "sui";
  refreshTrigger?: number;
  onTier?: (limit: number) => void;
}> = ({ humanOwner, rail = "arc", refreshTrigger, onTier }) => {
  const [data, setData] = useState<Summary | null>(null);

  // A different rail is a different record: never show the last one's meanwhile.
  useEffect(() => setData(null), [rail]);

  useEffect(() => {
    if (!humanOwner) return;
    let cancelled = false;
    fetch(`/api/reputation?rail=${rail}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success || !json.summary) return;
        setData(json.summary);
        onTier?.(json.summary.currentTier.creditLimit);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [humanOwner, rail, refreshTrigger, onTier]);

  const tier = data?.currentTier;
  const next = data?.nextTier;
  const loan = data?.oldestActiveLoan;

  const steps = next
    ? [
        { lab: "repayments", have: data!.repaymentsCount, need: next.requiredRepaymentsCount, fmt: (n: number) => String(n) },
        { lab: "days active", have: data!.totalActiveDurationDays, need: next.requiredActiveDurationDays, fmt: (n: number) => String(n) },
        { lab: "interest paid", have: data!.totalInterestPaid, need: next.requiredInterestPaid, fmt: (n: number) => `$${n.toFixed(2)}` },
      ].filter((s) => s.need > 0 || s.lab !== "interest paid") // Sui charges no fee
    : [];

  return (
    <section>
      <div className="flex items-baseline justify-between pb-3 rule-b">
        <h3 className="serif text-[22px] leading-none">Record <span className="ink-3">· {rail === "arc" ? "Arc" : "Sui"}</span></h3>
        <span className="lab">score {data?.reputationScore ?? "-"} / 100</span>
      </div>

      <div className="py-4 hair-b flex items-baseline justify-between gap-4">
        <div>
          <div className="lab mb-1.5">tier {tier?.tierNumber ?? 1}</div>
          <div className="serif text-[20px] leading-tight">{tier?.name.replace(/^Tier \d+:\s*/, "") ?? "Starter Line"}</div>
        </div>
        <div className="readout text-[24px]">${(tier?.creditLimit ?? 0.5).toFixed(2)}</div>
      </div>

      {loan && (
        <div className="py-3 hair-b flex justify-between mono text-[11px]">
          <span className="ink-3">oldest tranche</span>
          <span style={{ color: loan.isOverdue || loan.isDueSoon ? "var(--alarm)" : "var(--ink)" }}>
            ${loan.totalDue.toFixed(2)} · {left(loan.hoursRemaining)}
          </span>
        </div>
      )}

      {next && (
        <div className="pt-4">
          <div className="lab mb-3">
            to {next.name.replace(/^Tier \d+:\s*/, "")} · ${next.creditLimit.toFixed(2)} line
          </div>
          <div className="space-y-3">
            {steps.map((s) => {
              const pct = s.need > 0 ? Math.min(100, (s.have / s.need) * 100) : 100;
              return (
                <div key={s.lab}>
                  <div className="flex justify-between mono text-[10.5px] mb-1.5">
                    <span className="ink-3">{s.lab}</span>
                    <span>
                      {s.fmt(s.have)} <span className="ink-3">/ {s.fmt(s.need)}</span>
                    </span>
                  </div>
                  <div className="h-[3px]" style={{ background: "var(--hair)" }}>
                    <div className="h-full" style={{ width: `${pct}%`, background: pct >= 100 ? "var(--steady)" : "var(--ink)" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
