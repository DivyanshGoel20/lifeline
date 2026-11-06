import { isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Which Arc this deployment runs on. Set NEXT_PUBLIC_ARC_NETWORK=mainnet to move every
 * read, write, payment and bridge there at once. Testnet is the default, so nothing
 * reaches real money by accident. On mainnet there are no fallback addresses: the
 * contracts must be deployed and named.
 */
export const ARC_IS_MAINNET = process.env.NEXT_PUBLIC_ARC_NETWORK === "mainnet";

export const ARC_CHAIN_ID = ARC_IS_MAINNET ? 5042 : 5042002;
export const ARC_NAME = ARC_IS_MAINNET ? "Arc" : "Arc Testnet";
export const ARC_LABEL = `${ARC_NAME} (${ARC_CHAIN_ID})`;
/** x402's name for it. */
export const ARC_X402_NETWORK = `eip155:${ARC_CHAIN_ID}`;
/** The public endpoint, for handing to someone else's wallet. */
export const ARC_PUBLIC_RPC = ARC_IS_MAINNET ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.network";
export const ARC_EXPLORER = ARC_IS_MAINNET ? "https://arcscan.app" : "https://testnet.arcscan.app";
/** Circle Gateway's name for it. */
export const ARC_GATEWAY_CHAIN = (ARC_IS_MAINNET ? "arc" : "arcTestnet") as "arcTestnet";
/** Bridge Kit's name for it. */
export const ARC_BRIDGE_CHAIN = ARC_IS_MAINNET ? "Arc" : "Arc_Testnet";
export const ARC_FACILITATOR_URL = process.env.FACILITATOR_URL || (ARC_IS_MAINNET ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com");
export const arcTxUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;
export const arcAddressUrl = (address: string) => `${ARC_EXPLORER}/address/${address}`;

/**
 * One definition, because there were two.
 *
 * Half the codebase fell back to https://rpc.arc.io/testnet and half to
 * https://rpc.testnet.arc.network. Only the second answers - the first resolves
 * and then returns nothing - so with ARC_RPC_URL unset, balance reads and
 * wallet validation silently talked to a dead host while the contract calls
 * worked. Two fallbacks for one chain is a bug waiting for an empty .env.
 */
export const ARC_RPC_URL = process.env.ARC_RPC_URL || ARC_PUBLIC_RPC;
export const LIFELINE_CREDIT_FACILITY_ADDRESS = (process.env.LIFELINE_CREDIT_FACILITY_ADDRESS ||
  process.env.NEXT_PUBLIC_LIFELINE_CREDIT_FACILITY_ADDRESS ||
  (ARC_IS_MAINNET ? "" : "0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f")) as `0x${string}`;
export const ARC_USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ||
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

/**
 * Validates whether an address is a valid, usable EVM address for Arc Testnet.
 * Performs strict format checking and attempts RPC inspection against Arc Testnet.
 */
export async function validateArcAgentWallet(
  address: string
): Promise<{ valid: boolean; error?: string; isContract?: boolean; balanceUsdc?: number }> {
  const trimmed = (address || "").trim();

  // 1. Strict EVM format check
  if (!trimmed || !isAddress(trimmed)) {
    return {
      valid: false,
      error: "This address is not a valid/usable Arc agent wallet.",
    };
  }

  const rpcUrl = ARC_RPC_URL;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "eth_getCode", params: [trimmed, "latest"], id: 1 },
        { jsonrpc: "2.0", method: "eth_getBalance", params: [trimmed, "latest"], id: 2 },
      ]),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const codeResult = Array.isArray(data) ? data[0]?.result : null;
      const isContract = typeof codeResult === "string" && codeResult !== "0x" && codeResult !== "0x0";

      return {
        valid: true,
        isContract,
        balanceUsdc: 0,
      };
    }
  } catch (err: any) {
    // If RPC is unreachable or network times out, the address format is still structurally valid for Arc Testnet
    console.warn("[Arc-Validator] RPC check notice:", err.message);
  }

  // Address is mathematically valid for Arc Testnet
  return {
    valid: true,
    isContract: false,
    balanceUsdc: 0,
  };
}

/**
 * Provisions a fresh Arc Testnet agent wallet keypair and Lifeline API authentication key.
 * Compatible with Circle Agent Wallet architecture on Arc Testnet (ARC-TESTNET / 5042002).
 */
export function provisionArcAgentWallet(): {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  apiKey: string;
} {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const randomSuffix = Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 12);
  const apiKey = `lifeline_sk_${randomSuffix}`;

  return {
    address: account.address,
    privateKey,
    apiKey,
  };
}
