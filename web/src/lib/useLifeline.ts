"use client";

import { useCallback, useRef, useEffect, useMemo, useState } from "react";
import type { Rail, Agent, ActivityItem } from "@/types";
import type { LeadData } from "@/components/Monitor";
import { CREDIT_TIERS } from "./reputationEngine";

/**
 * Everything the dashboard knows and can do, for either front end.
 *
 * The browser dashboard and the World App mini app are two layouts over the
 * same state: the signed-in human, their agents, payments and parked
 * repayments, which rail they are looking at, and the actions
 * that move money. Keeping it here means a fix to how Lifeline behaves is a
 * fix on the phone and on the desktop at once.
 */

export type Payment = {
  paymentId: string;
  agentAddress: string;
  resourceUrl: string;
  requestedAmount: string;
  shortfall: string;
  fundingSource: string;
  status: string;
  timestamp: number;
  transactionId?: string;
  rail?: Rail;
  network?: string;
  sellerAddress?: string;
  screening?: { decision: string; reasons: string[]; capUsd: number; holdId?: string };
};

type Obligation = { obligationId: string; agentAddress: string; status: string; dueMs: number | null };

const ARC_TX = (hash?: string) => (hash && /^0x[0-9a-f]{64}$/i.test(hash) ? `https://testnet.arcscan.app/tx/${hash}` : null);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function useLifeline(
  opts: {
    haptic?: (kind: "success" | "error") => void;
    /** The rail this page is for (/arc, /sui). Unset, the rail is chosen in-page and remembered. */
    rail?: Rail;
  } = {}
) {
  const [isWorldVerified, setIsWorldVerified] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [nullifierHash, setNullifierHash] = useState("");

  const [chosenRail, setRail] = useState<Rail>("arc");
  const rail = opts.rail ?? chosenRail;
  // `checked` once the status has come back, so a page can tell "not yet" from "no".
  const [sui, setSui] = useState<{ ready: boolean; network: string | null; checked?: boolean }>({ ready: false, network: null });

  // Arc and Sui are separate lines, each with its own limit.
  const [limits, setLimits] = useState<Record<Rail, number>>({ arc: CREDIT_TIERS[0].creditLimit, sui: CREDIT_TIERS[0].creditLimit });
  const [allAgents, setAgents] = useState<Agent[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [purchaseFor, setPurchaseFor] = useState<string | null | undefined>(undefined);
  const [isRepayOpen, setIsRepayOpen] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    // A new toast gets its full time; the last one's timer must not cut it short.
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  };

  /** Back to the gate: the cookie expired, was voided, or never existed. */
  const endSession = useCallback(() => {
    setIsWorldVerified(false);
    setNullifierHash("");
    setAgents([]);
    setPayments([]);
    setObligations([]);
  }, []);

  const load = useCallback(async () => {
    try {
      const [a, p, o, ra, rs] = await Promise.all([
        fetch("/api/agents"),
        fetch("/api/payments"),
        fetch("/api/sui/obligations").catch(() => null),
        fetch("/api/reputation?rail=arc").catch(() => null),
        fetch("/api/reputation?rail=sui").catch(() => null),
      ]);
      if (a.status === 401) return endSession();
      const agentData = await a.json();
      const paymentData = await p.json().catch(() => ({}));
      const obligationData = o ? await o.json().catch(() => ({})) : {};
      if (Array.isArray(agentData.agents)) setAgents(agentData.agents);
      if (Array.isArray(paymentData.payments)) setPayments(paymentData.payments);
      if (Array.isArray(obligationData.obligations)) setObligations(obligationData.obligations);
      const [arcRecord, suiRecord] = await Promise.all([ra?.json().catch(() => null), rs?.json().catch(() => null)]);
      setLimits((cur) => ({
        arc: arcRecord?.summary?.currentTier?.creditLimit ?? cur.arc,
        sui: suiRecord?.summary?.currentTier?.creditLimit ?? cur.sui,
      }));
      setNow(Date.now());
    } catch (err) {
      console.error("[Lifeline] Could not load:", err);
    }
  }, [endSession]);

  const refresh = () => {
    setRefreshTrigger((t) => t + 1);
    void load();
  };

  // The session cookie is httpOnly, so who we are is a question for the server.
  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.authenticated && data?.nullifierHash) {
          setNullifierHash(data.nullifierHash);
          setIsWorldVerified(true);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingSession(false));
  }, []);

  useEffect(() => {
    if (!isWorldVerified) return;
    void load();

    // Offer Sui only when it is deployed and configured here.
    fetch("/api/sui/status")
      .then((r) => r.json())
      .then((d) => {
        const ready = !!d.configured;
        // "Could not tell" is not "not deployed": only a real answer counts as checked.
        setSui({ ready, network: d.network ?? null, checked: !d.unreachable });
        if (opts.rail) return;
        if (!ready) setRail("arc");
        else {
          try {
            if (localStorage.getItem("lifeline_rail") === "sui") setRail("sui");
          } catch {
            /* a display preference */
          }
        }
      })
      .catch(() => setSui({ ready: false, network: null }));

    // The trace moves: re-read every half minute so the strip keeps feeding.
    const tick = setInterval(() => void load(), 30_000);
    return () => clearInterval(tick);
  }, [isWorldVerified, load, opts.rail]);

  const chooseRail = (next: Rail) => {
    setRail(next);
    try {
      localStorage.setItem("lifeline_rail", next);
    } catch {
      /* a display preference, not worth failing over */
    }
  };

  // Each agent belongs to one rail; the screen shows the selected rail's.
  const arcAgents = useMemo(() => allAgents.filter((a) => a.rail !== "sui"), [allAgents]);
  const suiAgents = useMemo(() => allAgents.filter((a) => a.rail === "sui"), [allAgents]);
  const agents = rail === "arc" ? arcAgents : suiAgents;
  const arcDebt = arcAgents.reduce((n, a) => n + (a.outstandingDebt || 0), 0);
  const suiDebt = suiAgents.reduce((n, a) => n + (a.suiDebt || 0), 0);
  // The selected rail's line only: nothing owed on the other rail touches it.
  const creditLimit = limits[rail];
  const headroom = Math.max(0, creditLimit - (rail === "arc" ? arcDebt : suiDebt));
  const setCreditLimit = useCallback((limit: number) => setLimits((cur) => ({ ...cur, [rail]: limit })), [rail]);

  const nameOf = (address: string) => agents.find((a) => same(a.address, address))?.name ?? `${address.slice(0, 8)}…`;

  const railPayments = useMemo(
    () =>
      payments.filter(
        (p) =>
          p.status === "SUCCESS" &&
          (p.rail ?? "arc") === rail &&
          // Sui payments from another network (a wiped localnet, a reset
          // devnet) are not this deployment's history.
          (rail === "arc" || !sui.network || p.network === sui.network)
      ),
    [payments, rail, sui.network]
  );

  const leads: LeadData[] = useMemo(
    () =>
      agents.map((agent) => ({
        agent,
        beats: railPayments
          .filter((p) => same(p.agentAddress, agent.address))
          .map((p) => ({ t: p.timestamp, amountUsd: Number(p.requestedAmount) || 0, borrowed: (Number(p.shortfall) || 0) > 0 })),
        defaults:
          rail === "sui"
            ? obligations.filter((o) => same(o.agentAddress, agent.address) && o.status === "defaulted" && o.dueMs).map((o) => o.dueMs!)
            : [],
      })),
    [agents, railPayments, obligations, rail]
  );

  const dayAgo = now - 86_400_000;
  const beats24h = railPayments.filter((p) => p.timestamp >= dayAgo);

  const activities: ActivityItem[] = railPayments.map((p) => ({
    id: p.paymentId,
    type: p.fundingSource === "LIFELINE_FACILITY" ? "x402_overdraft" : "x402_normal",
    agentName: nameOf(p.agentAddress),
    agentAddress: p.agentAddress,
    amount: Number(p.requestedAmount),
    borrowed: Number(p.shortfall) || 0,
    rail: p.rail ?? "arc",
    timestamp: p.timestamp,
    txHash: p.transactionId ?? "",
    txLink:
      (p.rail ?? "arc") === "sui"
        ? p.network && p.network !== "localnet" && p.transactionId
          ? `https://suiscan.xyz/${p.network}/tx/${p.transactionId}`
          : null
        : ARC_TX(p.transactionId),
    endpoint: (() => {
      try {
        const u = new URL(p.resourceUrl);
        return u.pathname + u.search;
      } catch {
        return p.resourceUrl;
      }
    })(),
  }));

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      endSession();
      throw new Error("Your World session expired. Verify again.");
    }
    if (!res.ok || data.success === false || data.error) throw new Error(data.error || "That did not go through.");
    return data;
  };

  const handleAddAgent = async (input: { name: string; address: string; capUsd: number }) => {
    if (input.address) {
      await post("/api/agents", { action: "add", name: input.name, walletAddress: input.address, capUsd: input.capUsd });
    } else {
      const data = await post("/api/agent/provision", { label: input.name, capUsd: input.capUsd, rail });
      if (data.authorizedOnChain === false) showToast(`Agent created, but Arc authorization failed: ${data.authorizationError}`);
    }
    showToast(`${input.name} is on the line`);
    refresh();
  };

  const handleRemoveAgent = async (address: string) => {
    const res = await fetch(`/api/agents?address=${encodeURIComponent(address)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return endSession();
    if (!res.ok || !data.success) throw new Error(data.error || "Could not revoke the agent");
    showToast(`${nameOf(address)} revoked`);
    refresh();
  };

  const handlePayAgent = async (address: string) => {
    await post("/api/sui/earn", { agentAddress: address, amount: 0.1 });
    showToast(`${nameOf(address)} was paid $0.10 for its work`);
    refresh();
  };

  const handleSignOut = () => {
    fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    endSession();
  };

  // Settled money is felt, on a phone: the mini app passes a haptic.
  const done = (message: string) => {
    showToast(message);
    opts.haptic?.("success");
    refresh();
  };

  return {
    // who
    isLoadingSession,
    isWorldVerified,
    nullifierHash,
    signedIn: (hash: string) => {
      setNullifierHash(hash);
      setIsWorldVerified(true);
    },
    endSession,
    handleSignOut,
    // what is on screen
    rail,
    chooseRail,
    sui,
    // the line
    creditLimit,
    setCreditLimit,
    arcDebt,
    suiDebt,
    headroom,
    agents,
    leads,
    activities,
    beats24h,
    obligations,
    payments,
    nameOf,
    refreshTrigger,
    refresh,
    // feedback
    toast,
    showToast,
    done,
    // actions
    handleAddAgent,
    handleRemoveAgent,
    handlePayAgent,
    purchaseFor,
    setPurchaseFor,
    isRepayOpen,
    setIsRepayOpen,
  };
}
