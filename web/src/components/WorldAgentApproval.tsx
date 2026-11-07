"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ErrorNote } from "./Sheet";

type View = {
  status: "pending" | "approved" | "denied" | "expired" | "mismatch" | "failed";
  reason?: string;
  userCode?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  interval?: number;
  payment?: any;
  linked?: boolean;
};

/**
 * A fresh World ID approval, with World ID for Agents.
 *
 * Asks Lifeline to start the request, shows the human the code and the link
 * (a QR code on a computer, a button on a phone), and polls until World ID
 * answers. If the account has not linked World ID for Agents yet, linking
 * comes first - once. Nothing here approves anything: the server validates
 * World ID's answer and runs the action itself.
 */
export const WorldAgentApproval: React.FC<{
  /** The held payment to release; without one, this only links World ID for Agents. */
  holdId?: string;
  onDone: (outcome: { approved: boolean; message: string; payment?: any }) => void;
  onCancel: () => void;
}> = ({ holdId, onDone, onCancel }) => {
  const [step, setStep] = useState<"starting" | "link" | "approve">("starting");
  const [view, setView] = useState<View | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const done = useRef(false);
  // The parent's onDone changes on every render; hold the latest one here so
  // the request below is made once, not again on each re-render.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const started = useRef(false);

  const approvalUrl = `/api/pay/holds/${holdId}/approval`;

  const show = useCallback(async (v: View) => {
    setView(v);
    if (v.verificationUriComplete) setQr(await QRCode.toDataURL(v.verificationUriComplete, { margin: 1, width: 320 }));
  }, []);

  const startLink = useCallback(async () => {
    const l = await fetch("/api/auth/world-agents/link", { method: "POST" }).then((r) => r.json());
    if (!l.success && !l.linked) throw new Error(l.error || "Could not start linking.");
    return l;
  }, []);

  const requestApproval = useCallback(async (): Promise<void> => {
    setError(null);
    if (!holdId) {
      const l = await startLink();
      if (l.linked) {
        done.current = true;
        return onDoneRef.current({ approved: true, message: "World ID for Agents is linked" });
      }
      setStep("link");
      return show(l);
    }
    const res = await fetch(approvalUrl, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    if (d.code === "world_id_not_linked") {
      // Link first: the approval must come from this account's own World ID.
      const l = await startLink();
      if (l.linked) return requestApproval();
      setStep("link");
      return show(l);
    }
    if (!d.success) throw new Error(d.error || "Could not ask World ID.");
    setStep("approve");
    return show(d);
  }, [approvalUrl, holdId, show, startLink]);

  useEffect(() => {
    // Once per mount (StrictMode runs effects twice in development).
    if (started.current) return;
    started.current = true;
    requestApproval().catch((e) => setError(e.message));
  }, [requestApproval]);

  // Poll at World's pace.
  useEffect(() => {
    if (!view || view.status !== "pending" || done.current) return;
    const t = setTimeout(async () => {
      try {
        if (step === "link") {
          const l = await fetch("/api/auth/world-agents/link", { cache: "no-store" }).then((r) => r.json());
          if (l.linked) {
            setQr(null);
            setView(null);
            if (!holdId) {
              done.current = true;
              return onDoneRef.current({ approved: true, message: "World ID for Agents is linked" });
            }
            return requestApproval();
          }
          return show({ ...l, status: l.status ?? "pending" });
        }
        const d = await fetch(approvalUrl, { cache: "no-store" }).then((r) => r.json());
        if (d.status === "approved" && d.payment) {
          done.current = true;
          const paid = d.payment.success;
          return onDoneRef.current({
            approved: true,
            payment: d.payment,
            message: paid
              ? `Approved with World ID - payment released`
              : `Approved with World ID, but the payment did not go through: ${d.payment.error ?? d.payment.screening?.reasons?.[0] ?? "refused"}`,
          });
        }
        show({ ...d, status: d.status ?? "pending" });
      } catch {
        /* keep polling */
      }
    }, Math.max(2, view.interval ?? 5) * 1000);
    return () => clearTimeout(t);
  }, [view, step, approvalUrl, holdId, requestApproval, show]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const final = view && view.status !== "pending";
  const left = view?.expiresAt ? Math.max(0, Math.round((view.expiresAt - now) / 1000)) : null;

  return (
    <div className="space-y-4">
      <div className="lab">{step === "link" ? "World ID for Agents · link, once" : "World ID for Agents · fresh approval"}</div>
      <p className="text-[13px] ink-2 leading-relaxed">
        {step === "link"
          ? "You are signed in. This is a separate, one-time step, so that only your World ID can approve what your agents do."
          : "An agent's payment is waiting on you. Approve it in the World ID app - a fresh proof that it is you, right now. Until then nothing is paid."}
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}
      {!view && !error && <p className="mono text-[11px] ink-3">Asking World ID…</p>}

      {view?.status === "pending" && (
        <div className="flex flex-col sm:flex-row gap-4 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr && <img src={qr} alt="Scan to approve with World ID" className="w-[150px] h-[150px] bg-white p-1 shrink-0" />}
          <div className="space-y-2.5 w-full">
            <div>
              <div className="lab mb-1">code</div>
              <div className="readout text-[24px] tracking-[0.12em]">{view.userCode}</div>
            </div>
            <a href={view.verificationUriComplete} target="_blank" rel="noreferrer" className="btn btn-solid w-full justify-center h-11">
              Open World ID
            </a>
            <div className="mono text-[10.5px] ink-3">
              waiting for your approval{left !== null ? ` · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : ""}
            </div>
          </div>
        </div>
      )}

      {final && view?.status !== "approved" && (
        <ErrorNote>
          {view?.reason ?? view?.status}
          {view?.status === "denied" ? " The payment was declined and nothing was paid." : " Nothing was paid."}
        </ErrorNote>
      )}
      {view?.status === "approved" && !done.current && <p className="mono text-[11px] ink-3">Approved. Releasing the payment…</p>}

      <div className="flex justify-end gap-2">
        {final && view?.status !== "denied" && view?.status !== "approved" && (
          <button
            className="btn btn-quiet"
            onClick={() => {
              setView(null);
              setQr(null);
              requestApproval().catch((e) => setError(e.message));
            }}
          >
            Try again
          </button>
        )}
        <button className="btn btn-quiet" onClick={onCancel}>
          {final ? "Close" : "Not now"}
        </button>
      </div>
    </div>
  );
};
