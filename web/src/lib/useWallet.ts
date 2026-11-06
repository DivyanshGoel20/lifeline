"use client";

import { useCallback, useEffect, useState } from "react";
import { ARC_CHAIN_ID_HEX, ARC_TREASURY, ensureArcNetwork } from "./browserChain";

/**
 * The browser wallet, connected only when someone asks for it.
 *
 * There was no connect step. The repay sheet checked whether a wallet
 * extension existed and, if one did, quietly decided to spend from it - so the
 * first a person heard about their own money being involved was the signing
 * prompt. Presence of an extension is not consent.
 *
 * The distinction that makes this work is `eth_accounts` versus
 * `eth_requestAccounts`: the first reports an existing connection silently and
 * the second asks. Only the button calls the second.
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

const provider = (): Eip1193 | null =>
  typeof window !== "undefined" ? ((window as any).ethereum ?? null) : null;

/** Fired on connect so other mounted copies of this hook resync at once. */
const SYNC_EVENT = "lifeline:wallet-sync";

export type Wallet = {
  /** True when an extension exists at all. Never means connected. */
  available: boolean;
  address: string | null;
  chainId: string | null;
  onArc: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchToArc: () => Promise<void>;
  /**
   * Send `amountUsd` of Arc's native USDC to Lifeline's treasury and return
   * the transaction hash - the receipt the repay route checks on chain.
   */
  payTreasury: (amountUsd: number) => Promise<`0x${string}`>;
  /** Send transactions in order on Arc, waiting for each to confirm. Returns their hashes. */
  sendCalls: (calls: { to: string; data: string }[]) => Promise<`0x${string}`[]>;
  /** Sign a plain text message with the connected wallet. */
  signMessage: (message: string) => Promise<`0x${string}`>;
};

export function useWallet(): Wallet {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    const eth = provider();
    if (!eth) return;
    try {
      // eth_accounts, not eth_requestAccounts: this reports a connection that
      // already exists and never raises a prompt, so mounting the page cannot
      // nag someone who has not asked for anything.
      const accounts: string[] = await eth.request({ method: "eth_accounts" });
      setAddress(accounts?.[0] ?? null);
      setChainId(await eth.request({ method: "eth_chainId" }));
    } catch {
      // A wallet that will not answer is treated as not connected.
      setAddress(null);
    }
  }, []);

  useEffect(() => {
    void read();

    const eth = provider();
    if (!eth?.on) return;

    const onAccounts = (accounts: string[]) => setAddress(accounts?.[0] ?? null);
    const onChain = (id: string) => setChainId(id);
    const onSync = () => void read();

    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    window.addEventListener(SYNC_EVENT, onSync);

    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
      window.removeEventListener(SYNC_EVENT, onSync);
    };
  }, [read]);

  const connect = useCallback(async () => {
    const eth = provider();
    if (!eth) {
      setError("No wallet extension found in this browser.");
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
      setAddress(accounts?.[0] ?? null);
      // Onto Arc as part of connecting, so the network is settled before any
      // amount is on screen rather than in the middle of a payment.
      await ensureArcNetwork(eth);
      setChainId(await eth.request({ method: "eth_chainId" }));
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch (err: any) {
      // 4001 is the user declining, which is an answer rather than a fault.
      setError(err?.code === 4001 ? null : err?.message ?? "Could not connect the wallet.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchToArc = useCallback(async () => {
    const eth = provider();
    if (!eth) return;
    setError(null);
    try {
      await ensureArcNetwork(eth);
      setChainId(await eth.request({ method: "eth_chainId" }));
    } catch (err: any) {
      setError(err?.code === 4001 ? null : err?.message ?? "Could not switch network.");
    }
  }, []);

  const payTreasury = useCallback(
    async (amountUsd: number) => {
      const eth = provider();
      if (!eth || !address) throw new Error("Connect a wallet first.");
      // Never send on the wrong chain: the transfer would be real, and invisible to Lifeline.
      await ensureArcNetwork(eth);
      // Native USDC on Arc has 18 decimals; rounded up to the micro-dollar.
      const micros = BigInt(Math.ceil(amountUsd * 1e6 - 1e-9));
      const value = `0x${(micros * 10n ** 12n).toString(16)}`;
      return (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: ARC_TREASURY, value }],
      })) as `0x${string}`;
    },
    [address]
  );

  const sendCalls = useCallback(
    async (calls: { to: string; data: string }[]) => {
      const eth = provider();
      if (!eth || !address) throw new Error("Connect a wallet first.");
      await ensureArcNetwork(eth);
      const hashes: `0x${string}`[] = [];
      for (const call of calls) {
        const hash = (await eth.request({
          method: "eth_sendTransaction",
          params: [{ from: address, to: call.to, data: call.data }],
        })) as `0x${string}`;
        hashes.push(hash);
        // The next call may depend on this one (an approve, then a deposit).
        for (let i = 0; ; i++) {
          const receipt = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
          if (receipt) {
            if (receipt.status !== "0x1") throw new Error(`Transaction ${hash} reverted.`);
            break;
          }
          if (i >= 60) throw new Error(`Transaction ${hash} has not confirmed yet.`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      return hashes;
    },
    [address]
  );

  const signMessage = useCallback(
    async (message: string) => {
      const eth = provider();
      if (!eth || !address) throw new Error("Connect a wallet first.");
      const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      return (await eth.request({ method: "personal_sign", params: [hex, address] })) as `0x${string}`;
    },
    [address]
  );

  return {
    available: Boolean(provider()),
    address,
    chainId,
    onArc: (chainId ?? "").toLowerCase() === ARC_CHAIN_ID_HEX,
    connecting,
    error,
    connect,
    switchToArc,
    payTreasury,
    sendCalls,
    signMessage,
  };
}
