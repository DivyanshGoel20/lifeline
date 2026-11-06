"use client";

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MiniKit } from "@worldcoin/minikit-js";
import { proofOfHuman } from "@worldcoin/idkit";
import type { IDKitResult, IDKitErrorCodes, RpContext } from "@worldcoin/idkit";
import { LifelineMark } from "../Pulse";
import { WorldSessionProof } from "../WorldSessionProof";

const IDKitRequestWidget = dynamic(() => import("@worldcoin/idkit").then((m) => m.IDKitRequestWidget), { ssr: false });

/**
 * Signing in from World App.
 *
 * The wallet is the login: MiniKit's Sign-In with Ethereum, one tap, every
 * visit - World's own guidance is not to use World ID as a login. World ID
 * does the one thing only it can: the first time a wallet is seen, it proves
 * which unique human is holding it, and the wallet is linked to them for good.
 * That is the same human, with the same lines, whether they signed up here or
 * in a browser. Inside World App the proof is native; there is no QR code.
 *
 * World ID proves uniqueness once per person, ever. So a person who joined in
 * a browser cannot prove it again here; they open Lifeline in World App from
 * the dashboard's link, which names their account, and prove the World ID
 * session saved to it instead.
 *
 *   returning wallet:           wallet -> in
 *   new person:                 wallet -> World ID -> linked -> session saved -> in
 *   joined in a browser:        dashboard link -> wallet -> World ID session -> linked -> in
 */
export const MiniGate: React.FC<{ onSignedIn: (human: string) => void; haptic: (k: "success" | "error") => void }> = ({
  onSignedIn,
  haptic,
}) => {
  const [inWorldApp, setInWorldApp] = useState<boolean | null>(null);
  const [step, setStep] = useState<"start" | "signing" | "prove" | "proving" | "session">("start");
  // Opened from the dashboard's "Open in World App": which account, and its session.
  const [link, setLink] = useState<string | null>(null);
  const [linkSession, setLinkSession] = useState<string | null>(null);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const human = useRef("");
  const serverFailure = useRef<{ code?: string; message: string } | null>(null);

  const appId = (process.env.NEXT_PUBLIC_WORLD_APP_ID || "app_6ad9b6ef952f1c2a9a70a58e05aa9878") as `app_${string}`;
  const action = process.env.NEXT_PUBLIC_WORLD_ACTION || "lifeline-mumbai";

  useEffect(() => {
    setInWorldApp(MiniKit.isInWorldApp());
    setLink(new URLSearchParams(window.location.search).get("link"));
  }, []);

  // World App has no console, so the reason is sent to the server as well as shown.
  const report = (where: string, code: string | undefined, detail: string) => {
    fetch("/api/auth/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: `mini:${where}`, code, detail }),
    }).catch(() => {});
  };

  const fail = (message: string) => {
    report(step, undefined, message);
    setError(message);
    setStep("start");
    haptic("error");
  };

  const signIn = async () => {
    setError(null);
    setStep("signing");
    try {
      const { nonce } = await (await fetch("/api/auth/wallet/nonce", { cache: "no-store" })).json();
      const result = await MiniKit.walletAuth({
        nonce,
        statement: "Sign in to Lifeline",
        expirationTime: new Date(Date.now() + 10 * 60 * 1000),
      });
      if (result.executedWith === "fallback") return fail("Open Lifeline inside World App to sign in with your wallet.");

      const res = await fetch("/api/auth/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: result.data }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.verified) return fail(data.error || "Wallet sign-in failed.");

      if (data.linked) {
        haptic("success");
        return onSignedIn(data.nullifierHash);
      }

      if (link) {
        // Joined elsewhere: prove the session saved to that account.
        const saved = await (await fetch(`/api/auth/world-session?link=${encodeURIComponent(link)}`, { cache: "no-store" })).json();
        if (!saved.sessionId) return fail(saved.error || "That account has no World ID sign-in yet. Finish setting it up on the dashboard.");
        setLinkSession(saved.sessionId);
        setStep("session");
        return;
      }

      // First time with this wallet: World ID says which human it belongs to -
      // the same human if they already signed up in a browser.
      const ctx = await (await fetch("/api/auth/world-rp-context", { cache: "no-store" })).json();
      setRpContext({
        rp_id: ctx.rp_id,
        nonce: ctx.nonce,
        created_at: Number(ctx.created_at),
        expires_at: Number(ctx.expires_at),
        signature: ctx.signature,
      });
      setStep("prove");
    } catch (err: any) {
      fail(err?.message || "Sign-in was cancelled.");
    }
  };

  const verifyProof = async (result: IDKitResult) => {
    const res = await fetch("/api/auth/world-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idkitResponse: result, result }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.verified) {
      // IDKit reports any failure here only as failed_by_host_app, so keep the real reason.
      serverFailure.current = { code: data.code, message: data.error || "World ID verification failed." };
      throw new Error(serverFailure.current.message);
    }

    await linkWallet();
    human.current = String(data.nullifierHash);
  };

  const linkWallet = async () => {
    const res = await fetch("/api/auth/wallet/link", { method: "POST" });
    const linked = await res.json().catch(() => ({}));
    if (!res.ok || !linked.success) {
      serverFailure.current = { code: "wallet_link_failed", message: linked.error || "Could not link your wallet." };
      throw new Error(serverFailure.current.message);
    }
  };

  const proofError = (idkitCode: IDKitErrorCodes) => {
    const server = serverFailure.current;
    serverFailure.current = null;
    const code = server?.code || String(idkitCode);
    report("proof", code, server?.message ?? `IDKit: ${String(idkitCode)}`);
    setStep("start");
    haptic("error");
    if (server && code !== "nullifier_replayed" && code !== "max_verifications_reached") {
      return setError(`${server.message} (${code})`);
    }
    setError(
      code === "nullifier_replayed" || code === "max_verifications_reached"
        ? "You have already joined Lifeline, in a browser - World ID proves that only once. On the dashboard there, choose \"Open in World App\" and this wallet is added to your account."
        : `World ID did not complete (${code}).`
    );
  };

  const busy = step === "signing" || step === "proving" || step === "session";

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="px-6 pt-6 flex items-center gap-2.5">
        <LifelineMark size={18} />
        <span className="serif text-[24px] leading-none tracking-tight">Lifeline</span>
      </div>

      <div className="flex-1 flex flex-col justify-center">
        <svg viewBox="0 0 400 90" preserveAspectRatio="none" className="w-full h-[84px]" aria-hidden>
          <path
            className="trace draw"
            style={{ ["--len" as any]: 1400, strokeWidth: 1.6 }}
            vectorEffect="non-scaling-stroke"
            d="M0,60 L150,60 Q154,55 158,60 L165,60 L168,64 L172,14 L176,74 L179,60 L188,60 Q195,50 202,60 L236,60 Q240,56 244,60 L251,60 L254,63 L258,34 L262,70 L265,60 L274,60 Q281,52 288,60 L400,60"
          />
          <path
            className="trace trace-alarm draw"
            style={{ ["--len" as any]: 200, strokeWidth: 1.8, animationDelay: "1.2s", animationDuration: "0.5s", strokeDashoffset: 200 }}
            vectorEffect="non-scaling-stroke"
            d="M236,60 Q240,56 244,60 L251,60 L254,63 L258,34 L262,70 L265,60 L274,60 Q281,52 288,60"
          />
        </svg>

        <div className="px-6 pt-8 rise">
          <div className="lab mb-4">Credit for autonomous agents</div>
          <h1 className="serif text-[40px] leading-[0.95] tracking-tight">
            An agent can hold money.
            <br />
            <em className="ink-3">Only a human can hold debt.</em>
          </h1>
          <p className="text-[14px] ink-2 leading-relaxed mt-5">
            One human, a credit line on Arc and another on Sui, spent by your agents. Every payment is a beat on their line.
          </p>
        </div>
      </div>

      <div className="px-6 pt-6" style={{ paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}>
        {error && (
          <div className="mono text-[11px] leading-relaxed px-3 py-2.5 mb-4" style={{ color: "var(--alarm)", background: "var(--alarm-soft)" }}>
            {error}
          </div>
        )}

        {step === "prove" ? (
          <>
            <p className="text-[13px] ink-2 leading-relaxed mb-4">
              First time in World App. World ID confirms you are you - one human, one account - and this wallet is linked to it.
            </p>
            <button onClick={() => setStep("proving")} className="btn btn-solid w-full justify-center h-12">
              Verify with World ID
            </button>
          </>
        ) : inWorldApp === false ? (
          <>
            <p className="text-[13px] ink-2 leading-relaxed mb-4">
              This is Lifeline&apos;s World App version. Open it in World App, or use the full dashboard here.
            </p>
            <a href="/" className="btn btn-solid w-full justify-center h-12">
              Open the dashboard
            </a>
          </>
        ) : (
          <button onClick={signIn} disabled={busy || inWorldApp === null} className="btn btn-solid w-full justify-center h-12">
            {step === "signing" ? "Waiting for World App…" : step === "proving" || step === "session" ? "Verifying…" : "Sign in with World App"}
          </button>
        )}
      </div>

      {rpContext && step === "proving" && (
        <IDKitRequestWidget
          open
          onOpenChange={(o) => !o && setStep((s) => (s === "proving" ? "prove" : s))}
          app_id={appId}
          action={action}
          rp_context={rpContext}
          allow_legacy_proofs={true}
          environment={(process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT as "production" | "staging") || "production"}
          preset={proofOfHuman()}
          handleVerify={verifyProof}
          onSuccess={() => {
            // Joined. Save a World ID session too, so a browser - or this app
            // after a new wallet - can sign in again without it.
            setLinkSession(null);
            setStep("session");
          }}
          onError={proofError}
        />
      )}

      {step === "session" && (
        <WorldSessionProof
          sessionId={linkSession}
          onDone={async (h) => {
            try {
              if (linkSession) await linkWallet();
              haptic("success");
              onSignedIn(h || human.current);
            } catch (err: any) {
              fail(err?.message || "Could not link your wallet.");
            }
          }}
          onError={(msg) => {
            // A new member is in regardless; the session can be set up later.
            if (!linkSession && human.current) return onSignedIn(human.current);
            fail(msg);
          }}
          onCancel={() => {
            if (!linkSession && human.current) return onSignedIn(human.current);
            setStep("start");
          }}
        />
      )}
    </div>
  );
};
