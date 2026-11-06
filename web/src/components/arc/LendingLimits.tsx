"use client";

import React from "react";
import { usd } from "./api";
import { Bar, ErrorNote, Loading, Note, Section, useLoad } from "./ui";

type Controls = {
  limits: {
    poolCapUsd: number;
    dailyNewCreditUsd: number;
    sellerDailyUsd: number;
    breakerDefaultRate: number;
    breakerMinLoans: number;
  };
  outstandingUsd: number;
  lentTodayUsd: number;
  loansDue: number;
  loansUnpaid: number;
  defaultRate: number;
  breakerTripped: boolean;
};

const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const ratio = (used: number, limit: number) => (limit > 0 ? used / limit : 0);

const Row: React.FC<{ label: string; used: string; limit: string; fraction: number; alarm?: boolean }> = ({
  label,
  used,
  limit,
  fraction,
  alarm,
}) => (
  <div className="py-3 hair-b space-y-2">
    <div className="flex items-baseline justify-between gap-4">
      <span className="lab">{label}</span>
      <span className="mono text-[11px]">
        {used} <span className="ink-3">of {limit}</span>
      </span>
    </div>
    <Bar fraction={fraction} alarm={alarm} label={label} />
  </div>
);

export const LendingLimits: React.FC<{ refreshTrigger?: number }> = ({ refreshTrigger }) => {
  const { data, error, loading } = useLoad<Controls>("/api/risk/controls", refreshTrigger);

  return (
    <Section title="Lending limits" label="what Lifeline will lend">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loading && !data ? <Loading what="limits" /> : null}

      {data?.breakerTripped ? (
        <p className="mono text-[11.5px]" style={{ color: "var(--alarm)" }}>
          New credit is paused: too many loans that fell due are unpaid.
        </p>
      ) : null}

      {data ? (
        <div>
          <Row
            label="Pool exposure"
            used={usd(data.outstandingUsd)}
            limit={usd(data.limits.poolCapUsd)}
            fraction={ratio(data.outstandingUsd, data.limits.poolCapUsd)}
            alarm={data.limits.poolCapUsd > 0 && data.outstandingUsd >= data.limits.poolCapUsd}
          />
          <Row
            label="New credit today"
            used={usd(data.lentTodayUsd)}
            limit={usd(data.limits.dailyNewCreditUsd)}
            fraction={ratio(data.lentTodayUsd, data.limits.dailyNewCreditUsd)}
            alarm={data.limits.dailyNewCreditUsd > 0 && data.lentTodayUsd >= data.limits.dailyNewCreditUsd}
          />
          <Row
            label="Unpaid loans"
            used={`${data.loansUnpaid} of ${data.loansDue} due`}
            limit={`${pct(data.limits.breakerDefaultRate)} unpaid`}
            fraction={ratio(data.defaultRate, data.limits.breakerDefaultRate)}
            alarm={data.breakerTripped}
          />
          <div className="py-3 flex items-baseline justify-between gap-4">
            <span className="lab">Per seller, per day</span>
            <span className="mono text-[11px]">{usd(data.limits.sellerDailyUsd)}</span>
          </div>
          <Note>
            Current unpaid rate is {pct(data.defaultRate)}. Credit pauses at {pct(data.limits.breakerDefaultRate)} once at
            least {data.limits.breakerMinLoans} loans have fallen due.
          </Note>
        </div>
      ) : null}
    </Section>
  );
};
