"use client";

import React, { useCallback, useEffect, useState } from "react";
import { describeError, getJson } from "./api";

/** Titled section, as in HeldPayments: serif heading, a label on the right, a rule under both. */
export const Section: React.FC<{ title: string; label?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  label,
  children,
}) => (
  <section className="pb-10">
    <div className="flex items-baseline justify-between pb-3 rule-b">
      <h3 className="serif text-[22px] leading-none">{title}</h3>
      {label ? <span className="lab">{label}</span> : null}
    </div>
    <div className="pt-4 space-y-4">{children}</div>
  </section>
);

export const Readout: React.FC<{ label: string; value: React.ReactNode; tone?: "alarm" | "steady" }> = ({
  label,
  value,
  tone,
}) => (
  <div>
    <div className="lab mb-1.5">{label}</div>
    <div
      className="readout text-[20px]"
      style={tone ? { color: tone === "alarm" ? "var(--alarm)" : "var(--steady)" } : undefined}
    >
      {value}
    </div>
  </div>
);

export const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[12.5px] ink-2 leading-snug">{children}</p>
);

export const ErrorNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="mono text-[11px] leading-relaxed px-3 py-2.5"
    style={{ color: "var(--alarm)", background: "var(--alarm-soft)" }}
    role="alert"
  >
    {children}
  </div>
);

export const Field: React.FC<{ label: string; hint?: React.ReactNode; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <label className="block">
    <div className="flex items-baseline justify-between mb-1.5">
      <span className="lab">{label}</span>
      {hint ? <span className="mono text-[10px] ink-3">{hint}</span> : null}
    </div>
    {children}
  </label>
);

export const Loading: React.FC<{ what: string }> = ({ what }) => (
  <p className="mono text-[11px] ink-3" aria-live="polite">
    Loading {what}…
  </p>
);

/** Square utilisation bar: ink on the rule colour, with an optional tick for a limit. */
export const Bar: React.FC<{ fraction: number; limit?: number; alarm?: boolean; label: string }> = ({
  fraction,
  limit,
  alarm,
  label,
}) => {
  const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp(fraction) * 100)}
      className="relative h-[6px] w-full"
      style={{ background: "var(--rule)" }}
    >
      <div
        className="absolute left-0 top-0 h-full"
        style={{ width: `${clamp(fraction) * 100}%`, background: alarm ? "var(--alarm)" : "var(--ink)" }}
      />
      {limit !== undefined ? (
        <div
          className="absolute top-[-3px] h-[12px] w-px"
          style={{ left: `${clamp(limit) * 100}%`, background: "var(--ink-3)" }}
        />
      ) : null}
    </div>
  );
};

type Load<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** GET a JSON path whenever `path` or `refreshTrigger` changes. Pass null to skip. */
export function useLoad<T>(path: string | null, refreshTrigger?: number): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${path}|${refreshTrigger ?? 0}|${tick}`;

  useEffect(() => {
    if (path === null) return;
    let live = true;
    getJson<T>(path)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(describeError(e));
      })
      .finally(() => {
        if (live) setDoneKey(key);
      });
    return () => {
      live = false;
    };
  }, [path, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading: path !== null && doneKey !== key, reload };
}
