import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Chain } from "viem";
import { base, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_IS_MAINNET } from "./arc";

/**
 * The Uniswap API, for turning whatever someone holds into USDC.
 *
 * Quotes and swaps happen on one chain, and the USDC then bridges to Arc. The key stays on
 * the server. Mainnet swaps on Base; testnet on Sepolia, where the API has working routes
 * into the USDC that Circle's bridge accepts. (It does not route on Base Sepolia.)
 */
const API = "https://trade-api.gateway.uniswap.org/v1";
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

type SwapChain = {
  chain: Chain;
  rpc: string;
  /** Bridge Kit's name for it. */
  bridgeChain: "Base" | "Ethereum_Sepolia";
  usdc: `0x${string}`;
  tokens: Record<string, { address: `0x${string}`; decimals: number }>;
};

export const swapChain = (): SwapChain =>
  ARC_IS_MAINNET
    ? {
        chain: base,
        rpc: process.env.UNISWAP_RPC_URL || "https://mainnet.base.org",
        bridgeChain: "Base",
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokens: {
          ETH: { address: NATIVE_TOKEN, decimals: 18 },
          WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
          UNI: { address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83", decimals: 18 },
        },
      }
    : {
        chain: sepolia,
        rpc: process.env.UNISWAP_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
        bridgeChain: "Ethereum_Sepolia",
        usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        tokens: {
          ETH: { address: NATIVE_TOKEN, decimals: 18 },
          WETH: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18 },
          UNI: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
        },
      };

export const uniswapConfigured = () => Boolean(process.env.UNISWAP_API_KEY);
const swapClient = () => createPublicClient({ chain: swapChain().chain, transport: http(swapChain().rpc) });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function call(path: string, body: unknown, timeoutMs = 8_000): Promise<any> {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) throw new Error("The Uniswap API is not set up (UNISWAP_API_KEY).");
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json", "x-universal-router-version": "2.0" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.errorCode || `Uniswap answered ${res.status}`);
  return data;
}

export type SwapQuote = {
  token: string;
  amountIn: bigint;
  maxAmountIn: bigint;
  decimals: number;
  impactPct: number;
  /** Uniswap's estimate of the swap's gas, in dollars. */
  gasUsd: number;
  /** What the pools charge, as a fraction of the amount. */
  poolFee: number;
  /** Gas price, to estimate the bridge's transactions on the same chain. */
  maxFeePerGas: bigint;
  raw: any;
};

/** What the pools on a route charge. Pool fees are in hundredths of a basis point. */
export function routeFee(route: any): number {
  const hops = Array.isArray(route?.[0]) ? route[0] : [];
  return hops.reduce((n: number, pool: any) => n + (Number(pool?.fee) || 0) / 1_000_000, 0);
}

let ethPrice: { at: number; usd: number } | null = null;
/** The price of ETH, for turning testnet gas into dollars, where Uniswap leaves that out. */
async function ethUsd(swapper: string): Promise<number> {
  if (ethPrice && Date.now() - ethPrice.at < 60_000) return ethPrice.usd;
  const d = await call("quote", {
    type: "EXACT_INPUT",
    amount: "100000000000000000",
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
    tokenIn: "0x4200000000000000000000000000000000000006",
    tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    swapper,
  });
  const usd = (Number(d.quote?.output?.amount ?? 0) / 1e6) * 10;
  if (usd > 0) ethPrice = { at: Date.now(), usd };
  return usd;
}

export const weiToUsd = async (wei: bigint, swapper: string) => (Number(wei) / 1e18) * (await ethUsd(swapper));

/** How much of a token buys exactly this much USDC, and what that costs. */
export async function quoteForUsdc(tokenSymbol: string, usdcUnits: bigint, swapper: string): Promise<SwapQuote> {
  const c = swapChain();
  const token = c.tokens[tokenSymbol];
  if (!token) throw new Error(`${tokenSymbol} is not a token Lifeline can swap.`);
  const d = await call("quote", {
    type: "EXACT_OUTPUT",
    amount: usdcUnits.toString(),
    tokenInChainId: c.chain.id,
    tokenOutChainId: c.chain.id,
    tokenIn: token.address,
    tokenOut: c.usdc,
    swapper,
    protocols: ["V3", "V4"],
  });
  const q = d.quote;
  const gasUsd = q.gasFeeUSD ? Number(q.gasFeeUSD) : await weiToUsd(BigInt(q.gasFee ?? 0), swapper);
  return {
    token: tokenSymbol,
    amountIn: BigInt(q.input.amount),
    maxAmountIn: BigInt(q.input.maximumAmount ?? q.input.amount),
    decimals: token.decimals,
    impactPct: Number(q.priceImpact ?? 0),
    gasUsd,
    poolFee: routeFee(q.route),
    maxFeePerGas: BigInt(q.maxFeePerGas ?? 0),
    raw: d,
  };
}

/** What a wallet holds of each swappable token. A read that fails counts as nothing held. */
export async function holdingsOf(address: string): Promise<Record<string, bigint>> {
  const c = swapChain();
  const client = swapClient();
  const out: Record<string, bigint> = {};
  await Promise.all(
    Object.entries(c.tokens).map(async ([symbol, t]) => {
      try {
        out[symbol] =
          t.address === NATIVE_TOKEN
            ? await client.getBalance({ address: address as `0x${string}` })
            : ((await client.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [address as `0x${string}`] })) as bigint);
      } catch {
        out[symbol] = 0n;
      }
    })
  );
  return out;
}

export const usdcOn = async (address: string): Promise<bigint> =>
  (await swapClient().readContract({ address: swapChain().usdc, abi: ERC20, functionName: "balanceOf", args: [address as `0x${string}`] })) as bigint;

export const formatToken = (amount: bigint, decimals: number) => {
  const n = Number(formatUnits(amount, decimals));
  return n >= 1 ? n.toFixed(3) : n.toPrecision(2);
};

/** The approval a wallet must send first, if any. Native ETH needs none. */
export async function approvalNeeded(tokenSymbol: string, amount: bigint, wallet: string): Promise<{ to: string; data: string; value: string } | null> {
  const c = swapChain();
  const token = c.tokens[tokenSymbol];
  if (!token || token.address === NATIVE_TOKEN) return null;
  const d = await call("check_approval", { walletAddress: wallet, token: token.address, amount: amount.toString(), chainId: c.chain.id });
  return d.approval ?? null;
}

/** The swap transaction, for a quote and (for tokens) a signed Permit2 message. */
export async function buildSwap(raw: { quote: any; permitData?: any }, signature?: string) {
  const d = await call("swap", {
    quote: raw.quote,
    ...(signature && raw.permitData ? { signature, permitData: raw.permitData } : {}),
  });
  if (!d.swap?.to || !d.swap?.data) throw new Error("Uniswap returned no transaction.");
  return d.swap as { to: string; data: string; value?: string; gasLimit?: string; chainId?: number | string };
}

/** Run a swap from a key Lifeline holds: approval, Permit2 signature, then the swap. */
export async function executeSwap(privateKey: `0x${string}`, quote: SwapQuote): Promise<{ txHash: string }> {
  const c = swapChain();
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: c.chain, transport: http(c.rpc) });
  const client = swapClient();
  const confirm = async (hash: `0x${string}`, what: string) => {
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${what} reverted (${hash}).`);
    return hash;
  };

  const approval = await approvalNeeded(quote.token, quote.maxAmountIn, account.address);
  if (approval) await confirm(await wallet.sendTransaction({ to: approval.to as `0x${string}`, data: approval.data as `0x${string}` }), "The approval");

  const permit = quote.raw.permitData;
  const signature = permit
    ? await account.signTypedData({
        domain: permit.domain,
        types: permit.types,
        primaryType: "PermitSingle",
        message: permit.values,
      })
    : undefined;

  const tx = await buildSwap(quote.raw, signature);
  const hash = await wallet.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.value ? BigInt(tx.value) : 0n,
    ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
  });
  return { txHash: await confirm(hash, "The swap") };
}
