"use client";

import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { WorldAgentApproval } from "./WorldAgentApproval";

/**
 * Two small links above the vitals.
 *
 * "Open in World App": a link, as a QR code, that opens Lifeline in World App
 * as this account, where the phone proves the account's World ID session and
 * its wallet is added. Offered only when the account has a session to prove.
 *
 * "Agent approvals": whether World ID for Agents is linked, and linking it -
 * once - so the account's own World ID can approve what its agents are held
 * on. Offered only where World ID for Agents is set up.
 */
export const AccountLinks: React.FC<{ onToast: (m: string) => void }> = ({ onToast }) => {
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<{ configured: boolean; linked: boolean } | null>(null);
  const [linking, setLinking] = useState(false);
  const [qr, setQr] = useState<{ url: string; img: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setHasSession(!!d.hasWorldSession))
      .catch(() => {});
    fetch("/api/auth/world-agents/link", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setAgents({ configured: !!d.configured, linked: !!d.linked }))
      .catch(() => {});
  }, []);

  const [making, setMaking] = useState(false);
  const [showLookups, setShowLookups] = useState(false);
  const [registry, setRegistry] = useState<{ listed: boolean; lookups: { partner: string; answered: string; at: string }[] } | null>(null);
  useEffect(() => {
    if (!agents?.linked) return;
    fetch("/api/registry/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setRegistry(d))
      .catch(() => {});
  }, [agents?.linked, showLookups]);
  const openInWorldApp = async () => {
    if (qr) return setQr(null);
    if (making) return;
    setMaking(true);
    try {
      const res = await fetch("/api/auth/link-token", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return onToast(d.error || "Could not make a link.");
      setQr({ url: d.url, img: await QRCode.toDataURL(d.url, { margin: 1, width: 360 }) });
    } catch {
      onToast("Could not reach Lifeline to make a link.");
    } finally {
      setMaking(false);
    }
  };

  const showAgents = agents?.configured;
  if (!hasSession && !showAgents) return null;

  return (
    <div className="pt-6 space-y-3">
      <div className="flex flex-wrap justify-end gap-x-5 gap-y-1">
        {showAgents && agents!.linked && (
          <button onClick={() => setShowLookups((v) => !v)} className="mono text-[10.5px] ink-3 underline underline-offset-2">
            in the registry · <span style={{ color: "var(--steady)" }}>World ID linked</span>
            {registry ? ` · ${registry.lookups.length} lookup${registry.lookups.length === 1 ? "" : "s"}` : ""}
          </button>
        )}
        {/* Not sign-in: you are signed in already. This is optional, and a held payment asks for it when it is needed. */}
        {showAgents && !agents!.linked && !linking && (
          <button
            onClick={() => setLinking(true)}
            title="Optional. Lets you approve held payments with a fresh World ID check, and shows partner apps whether you repay: good, late or in default, never amounts."
            className="mono text-[10.5px] ink-3 underline underline-offset-2"
          >
            Turn on payment approvals
          </button>
        )}
        {hasSession && (
          <button onClick={openInWorldApp} disabled={making} className="mono text-[10.5px] ink-3 underline underline-offset-2">
            {qr ? "hide" : "Open in World App"}
          </button>
        )}
      </div>
      {showLookups && registry && (
        <div className="sheet p-4 max-w-[520px] ml-auto space-y-2">
          <div className="lab">Who has looked you up</div>
          {registry.lookups.length === 0 ? (
            <p className="text-[12.5px] ink-3">No partner app has asked about you yet.</p>
          ) : (
            <ul className="space-y-1">
              {registry.lookups.map((l, i) => (
                <li key={i} className="mono text-[10.5px] flex justify-between gap-3">
                  <span>{l.partner}</span>
                  <span className="ink-3">
                    told {l.answered} · {new Date(l.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {linking && (
        <div className="sheet p-4 sm:p-5 max-w-[520px] ml-auto">
          <WorldAgentApproval
            onDone={({ message }) => {
              setLinking(false);
              setAgents((a) => (a ? { ...a, linked: true } : a));
              onToast(message);
            }}
            onCancel={() => setLinking(false)}
          />
        </div>
      )}
      {qr && (
        <div className="flex gap-4 items-center justify-end">
          <p className="text-[12.5px] ink-2 max-w-[40ch] text-right">
            Scan with your phone. Lifeline opens in World App as you; World ID confirms it and your wallet is added. The
            link lasts ten minutes.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.img} alt="Open in World App" className="w-[120px] h-[120px] bg-white p-1" />
        </div>
      )}
    </div>
  );
};
