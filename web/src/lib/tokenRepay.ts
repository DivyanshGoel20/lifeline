"use client";

import { ensureArcNetwork } from "./browserChain";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<any> };
type Post = (url: string, body: unknown) => Promise<any>;

const pad = (address: string) => address.toLowerCase().replace("0x", "").padStart(64, "0");

async function waitFor(eth: Eip1193, hash: string) {
  for (let i = 0; i < 180; i++) {
    const receipt = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`Transaction ${hash} reverted.`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Transaction ${hash} has not confirmed yet.`);
}

const usdcHeld = async (eth: Eip1193, usdc: string, wallet: string) =>
  BigInt(await eth.request({ method: "eth_call", params: [{ to: usdc, data: `0x70a08231${pad(wallet)}` }, "latest"] }));

/**
 * Repay from a wallet holding anything: swap to USDC with the Uniswap API, bridge the USDC
 * to Arc, then send it to the treasury. The caller books it with that last transaction,
 * through the same check as any wallet repayment. If a later step fails, what was already
 * done stays in the person's own wallet, as USDC.
 */
export async function swapAndBridge(p: {
  eth: Eip1193;
  wallet: string;
  token: string;
  amountUsd: number;
  post: Post;
  onStep: (step: string) => void;
}): Promise<{ arrivedUsd: number }> {
  const { eth, wallet, token, amountUsd, post, onStep } = p;
  const info = await (await fetch("/api/uniswap/repay", { cache: "no-store" })).json();
  if (!info.configured) throw new Error("Repaying in other tokens is not set up.");

  onStep("Getting a price from Uniswap…");
  const q = await post("/api/uniswap/repay", { action: "quote", token, amountUsd, wallet });

  onStep("Switch network in your wallet…");
  await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${Number(info.chainId).toString(16)}` }] });

  if (q.approval) {
    onStep("Approve the token in your wallet…");
    await waitFor(eth, await eth.request({ method: "eth_sendTransaction", params: [{ from: wallet, to: q.approval.to, data: q.approval.data }] }));
  }

  let signature: string | undefined;
  if (q.permitData) {
    onStep("Sign the swap in your wallet…");
    const { domain, types, values } = q.permitData;
    const typed = {
      domain,
      message: values,
      primaryType: "PermitSingle",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...types,
      },
    };
    signature = await eth.request({ method: "eth_signTypedData_v4", params: [wallet, JSON.stringify(typed)] });
  }

  const before = await usdcHeld(eth, info.usdc, wallet);
  const { tx } = await post("/api/uniswap/repay", { action: "swap", quote: q.quote, permitData: q.permitData, signature });
  onStep(`Swap ${q.amountIn} ${token} in your wallet…`);
  await waitFor(
    eth,
    await eth.request({ method: "eth_sendTransaction", params: [{ from: wallet, to: tx.to, data: tx.data, ...(tx.value && BigInt(tx.value) > 0n ? { value: tx.value } : {}) }] })
  );
  const bought = (await usdcHeld(eth, info.usdc, wallet)) - before;
  if (bought <= 0n) throw new Error("The swap delivered no USDC.");

  onStep("Bridging to Arc: confirm in your wallet…");
  const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([import("@circle-fin/bridge-kit"), import("@circle-fin/adapter-viem-v2")]);
  const adapter = await createViemAdapterFromProvider({ provider: eth as any });
  const usd = Number(bought) / 1e6;
  const bridged: any = await new BridgeKit().bridge({
    from: { adapter, chain: info.bridgeFrom },
    to: { adapter, chain: info.bridgeTo },
    amount: usd.toFixed(6),
  } as any);
  if (bridged.state !== "success") {
    const failed = bridged.steps?.find((s: any) => s.state === "error");
    throw new Error(`The bridge did not finish: ${failed?.errorMessage ?? bridged.state}. Your USDC is safe in your wallet.`);
  }

  onStep("Switch to Arc in your wallet…");
  await ensureArcNetwork(eth as any);
  return { arrivedUsd: usd };
}
