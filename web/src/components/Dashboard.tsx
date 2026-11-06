"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WorldAuthGate } from "@/components/WorldAuthGate";
import { Header } from "@/components/Header";
import { Vitals } from "@/components/Vitals";
import { Monitor } from "@/components/Monitor";
import { EventTape } from "@/components/EventTape";
import { Underwriting } from "@/components/Underwriting";
import { AccountLinks } from "@/components/AccountLinks";
import { Counterparties } from "@/components/Counterparties";
import { FacilityRecord } from "@/components/FacilityRecord";
import { ParkedRepayments } from "@/components/ParkedRepayments";
import { HeldPayments } from "@/components/HeldPayments";
import { StandingBanner } from "@/components/StandingBanner";
import { PurchaseModal } from "@/components/PurchaseModal";
import { RepayModal } from "@/components/RepayModal";
import { LifelineMark } from "@/components/Pulse";
import { Marketplace, type MarketService } from "@/components/arc/Marketplace";
import { BuySheet } from "@/components/arc/BuySheet";
import { SecuredCredit } from "@/components/arc/SecuredCredit";
import { LendingPool } from "@/components/arc/LendingPool";
import { LendingLimits } from "@/components/arc/LendingLimits";
import { CrossChainRepay } from "@/components/arc/CrossChainRepay";
import { RepayAnyToken } from "@/components/arc/RepayAnyToken";
import { useLifeline } from "@/lib/useLifeline";
import { useWallet } from "@/lib/useWallet";
import type { Rail } from "@/types";

/**
 * The dashboard for one rail, at its own URL: /arc or /sui. The two are
 * separate lines with separate agents, so each gets its own page.
 */
export function Dashboard({ rail }: { rail: Rail }) {
  const L = useLifeline({ rail });
  const router = useRouter();
  const wallet = useWallet();
  const [buying, setBuying] = useState<MarketService | null>(null);

  // Remember the rail, so / opens where you left off.
  useEffect(() => {
    try {
      localStorage.setItem("lifeline_rail", rail);
    } catch {
      /* a display preference */
    }
  }, [rail]);

  // /sui where Lifeline is not deployed on Sui: nothing to show, go to Arc.
  useEffect(() => {
    if (rail === "sui" && L.sui.checked && !L.sui.ready) router.replace("/arc");
  }, [rail, L.sui.checked, L.sui.ready, router]);

  if (L.isLoadingSession) {
    return (
      <div className="min-h-screen grid place-items-center">
        <LifelineMark size={22} className="pulse-dot" />
      </div>
    );
  }

  if (!L.isWorldVerified) return <WorldAuthGate onVerified={L.signedIn} />;

  return (
    <div className="min-h-screen">
      <Header onSignOut={L.handleSignOut} />

      {L.toast && (
        <div className="fixed bottom-6 right-4 left-4 sm:left-auto sm:right-6 z-50 sheet rise px-4 py-3 sm:max-w-sm flex items-center gap-3">
          <span style={{ width: 6, height: 6, background: "var(--alarm)", display: "inline-block", flexShrink: 0 }} />
          <span className="text-[13px]">{L.toast}</span>
        </div>
      )}

      <main className="max-w-[1180px] mx-auto px-6 sm:px-10">
        <AccountLinks onToast={L.showToast} />
        <StandingBanner rail={L.rail} refreshTrigger={L.refreshTrigger} onRepay={() => L.setIsRepayOpen(true)} />
        <Vitals
          creditLimit={L.creditLimit}
          arcDebt={L.arcDebt}
          suiDebt={L.suiDebt}
          rail={L.rail}
          beats24h={L.beats24h.length}
          borrowedBeats24h={L.beats24h.filter((p) => (Number(p.shortfall) || 0) > 0).length}
          onPurchase={() => L.setPurchaseFor(null)}
          onRepay={() => L.setIsRepayOpen(true)}
        />

        <Monitor
          leads={L.leads}
          rail={L.rail}
          suiNetwork={L.sui.network}
          onAddAgent={L.handleAddAgent}
          onRemoveAgent={L.handleRemoveAgent}
          onPayAgent={L.handlePayAgent}
          onBuy={(a) => L.setPurchaseFor(a.address)}
        />

        {L.rail === "sui" && (
          <HeldPayments rail="sui" titled refreshTrigger={L.refreshTrigger} agentName={L.nameOf} onChanged={L.done} />
        )}
        {L.rail === "sui" && <ParkedRepayments refreshTrigger={L.refreshTrigger} agentName={L.nameOf} onChanged={L.done} />}

        <div className="grid gap-12 lg:grid-cols-[1.5fr_1fr] pb-20">
          <EventTape activities={L.activities} rail={L.rail} />
          <div className="space-y-12">
            <Underwriting humanOwner={L.nullifierHash} rail={L.rail} refreshTrigger={L.refreshTrigger} onTier={L.setCreditLimit} />
            {L.rail === "arc" && <FacilityRecord humanOwner={L.nullifierHash} refreshTrigger={L.refreshTrigger} />}
            {L.rail === "arc" && (
              <Counterparties payments={L.payments} refreshTrigger={L.refreshTrigger} agentName={L.nameOf} onChanged={L.done} />
            )}
          </div>
        </div>

        {L.rail === "arc" && (
          <div className="pb-10">
            <Marketplace onBuy={setBuying} refreshTrigger={L.refreshTrigger} />
            <div className="grid gap-x-12 lg:grid-cols-2">
              <SecuredCredit wallet={wallet} refreshTrigger={L.refreshTrigger} onChanged={L.done} />
              <div>
                <LendingLimits refreshTrigger={L.refreshTrigger} />
                <CrossChainRepay
                  agents={L.agents.filter((a) => (a.rail ?? "arc") === "arc").map((a) => ({ address: a.address, name: a.name }))}
                  onChanged={L.done}
                />
              </div>
            </div>
            <LendingPool wallet={wallet} refreshTrigger={L.refreshTrigger} onChanged={L.done} />
            <RepayAnyToken
              agents={L.agents.filter((a) => (a.rail ?? "arc") === "arc").map((a) => ({ address: a.address, name: a.name }))}
              refreshTrigger={L.refreshTrigger}
              onChanged={L.done}
            />
          </div>
        )}
      </main>

      <footer className="rule-t">
        <div className="max-w-[1180px] mx-auto px-6 sm:px-10 py-5 flex flex-wrap justify-between gap-2 lab">
          <span>Lifeline · credit for machines that spend · <a href="/whitechain" className="underline">USDT on Whitechain</a></span>
          <span>{L.rail === "arc" ? "Arc testnet · 5042002" : `Sui ${L.sui.network ?? ""}`}</span>
        </div>
      </footer>

      <BuySheet service={buying} agents={L.agents} onClose={() => setBuying(null)} onDone={L.done} />

      <PurchaseModal
        isOpen={L.purchaseFor !== undefined}
        initialAgent={L.purchaseFor ?? null}
        onClose={() => L.setPurchaseFor(undefined)}
        agents={L.agents}
        rail={L.rail}
        headroom={L.headroom}
        onDone={L.done}
        onSessionExpired={L.endSession}
      />

      <RepayModal
        isOpen={L.isRepayOpen}
        onClose={() => L.setIsRepayOpen(false)}
        rail={L.rail}
        agents={L.agents}
        onDone={L.done}
        onSessionExpired={L.endSession}
      />
    </div>
  );
}
