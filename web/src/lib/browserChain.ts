/**
 * Getting the browser wallet onto Arc before it is asked to spend.
 *
 * A wallet sends on whatever chain it happens to be showing. The repay flow
 * asked for accounts and then sent, with nothing in between, so a wallet parked
 * on the wrong chain signed an unsupported transaction to Lifeline's treasury address - an address
 * that exists on every EVM chain, so there is no bounce and no error. Real
 * funds left, on a chain nothing in Lifeline is watching, and the repayment was
 * recorded anyway because the send had returned a hash.
 *
 * Switching first turns a silent wrong-chain payment into a prompt the person
 * can read. On Arc, USDC is the native currency at 18 decimals rather than an
 * ERC-20, which is why a repayment here is a plain value transfer.
 */
import { ARC_CHAIN_ID, ARC_EXPLORER, ARC_NAME, ARC_PUBLIC_RPC } from "./arc";

/** Arc, as EIP-3085 wants it. */
export const ARC_CHAIN_PARAMS = {
  chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
  chainName: ARC_NAME,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  // The public endpoint, not ARC_RPC_URL: this is handed to someone else's
  // wallet, and a private or local override would leave it unable to sync.
  rpcUrls: [ARC_PUBLIC_RPC],
  blockExplorerUrls: [ARC_EXPLORER],
} as const;

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<any> };

export const ARC_CHAIN_ID_HEX = ARC_CHAIN_PARAMS.chainId;

/**
 * Moves the wallet to Arc, adding the network if it has never seen it.
 *
 * Resolves only when the wallet is actually on Arc - the chain is read back
 * after the switch rather than assumed, because a user can dismiss the prompt
 * and some wallets resolve the request regardless. Anything else throws, so a
 * caller cannot accidentally continue on the wrong chain.
 */
export async function ensureArcNetwork(ethereum: Eip1193): Promise<void> {
  const current = await ethereum.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === ARC_CHAIN_ID_HEX) return;

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_CHAIN_ID_HEX }],
    });
  } catch (err: any) {
    // 4902: the wallet does not know this chain yet. Adding it also switches.
    // Some wallets report the same condition as -32603 with a nested 4902.
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902 && code !== -32603) throw err;

    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [ARC_CHAIN_PARAMS],
    });
  }

  const after = await ethereum.request({ method: "eth_chainId" });
  if (typeof after !== "string" || after.toLowerCase() !== ARC_CHAIN_ID_HEX) {
    throw new Error(
      `Your wallet is still on chain ${after}. Switch it to ${ARC_NAME} to settle — ` +
        `sending on another chain would move real funds Lifeline cannot see.`
    );
  }
}

/** Where a browser repayment is sent. Lifeline's operator wallet on Arc. */
export const ARC_TREASURY =
  (process.env.NEXT_PUBLIC_LIFELINE_TREASURY_ADDRESS ||
    "0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3") as `0x${string}`;
