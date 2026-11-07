import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, createWalletClient } from "viem";
import { ARC_GATEWAY_CHAIN } from "./arc";
import { getArcTransport } from "./arcRpc";

/**
 * Circle's Gateway client, using Lifeline's Arc connection.
 *
 * Left alone, the SDK makes its own calls to one public endpoint, with no retries and a
 * 4 second wait between checks. A rate limit while it waited for a receipt was reported as
 * "Deposit transaction failed", even when the deposit had gone through. The SDK has no
 * setting for this, so its clients are replaced. Everything else about it is unchanged.
 */
export function arcGatewayClient(privateKey: `0x${string}`): GatewayClient {
  const client = new GatewayClient({ chain: ARC_GATEWAY_CHAIN, privateKey });
  const sdk = client as any;
  const chain = sdk.publicClient.chain;
  sdk.publicClient = createPublicClient({ chain, transport: getArcTransport(), pollingInterval: 500 });
  sdk.walletClient = createWalletClient({ account: sdk.account, chain, transport: getArcTransport() });
  return client;
}

/**
 * The SDK reports any failed wait as "Deposit transaction failed: 0x…". The transaction
 * itself decides: was it mined, and did it succeed? Null means this was some other error.
 */
export async function depositReallyFailed(err: unknown): Promise<{ hash: `0x${string}`; succeeded: boolean } | null> {
  const hash = String((err as any)?.message ?? "").match(/Deposit transaction failed: (0x[0-9a-fA-F]{64})/)?.[1] as `0x${string}` | undefined;
  if (!hash) return null;
  const client = createPublicClient({ transport: getArcTransport(), pollingInterval: 500 });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000 });
  return { hash, succeeded: receipt.status === "success" };
}
