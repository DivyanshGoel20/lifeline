import { getAgentPrivateKey, authorizeAgentSpend } from "./agentKeys";
import { ARC_BRIDGE_CHAIN, ARC_IS_MAINNET } from "./arc";
import { getAgentWalletUsdc } from "./walletBalance";
import { commitArcRepayment, prepareArcRepayment } from "./repayCore";
import { acquireLedgerLock } from "./ledgerLock";
import type { Agent } from "@/types";

/**
 * Repay Arc debt with USDC the agent holds on another chain.
 *
 * Agents earn wherever their customers are, and the debt lives on Arc. Circle's
 * Bridge Kit moves the money to the agent's wallet on Arc, then it repays as any
 * other wallet repayment would. The bridge can take minutes, so the ledger stays
 * unlocked until the money has arrived.
 */
const TESTNET_CHAINS = ["Ethereum_Sepolia", "Base_Sepolia", "Arbitrum_Sepolia", "Optimism_Sepolia", "Polygon_Amoy_Testnet", "Avalanche_Fuji", "Unichain_Sepolia"] as const;
const MAINNET_CHAINS = ["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Unichain"] as const;
export type BridgeChain = (typeof TESTNET_CHAINS)[number] | (typeof MAINNET_CHAINS)[number];
/** Money cannot cross between testnets and mainnets, so each deployment offers its own. */
export const BRIDGE_CHAINS: readonly BridgeChain[] = ARC_IS_MAINNET ? MAINNET_CHAINS : TESTNET_CHAINS;
export const isBridgeChain = (c: unknown): c is BridgeChain => BRIDGE_CHAINS.includes(c as BridgeChain);

export type Bridger = (p: { privateKey: `0x${string}`; from: BridgeChain; amountUsd: number }) => Promise<{ state: string; steps: { name?: string; state?: string; txHash?: string; errorMessage?: string }[] }>;
export type Booker = (p: { human: string; agent: Agent; amountUsd: number }) => Promise<{ repaidUsd: number; txHash: string }>;

const bridgeWithKit: Bridger = async ({ privateKey, from, amountUsd }) => {
  const [{ BridgeKit }, { createViemAdapterFromPrivateKey }] = await Promise.all([
    import("@circle-fin/bridge-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const adapter = createViemAdapterFromPrivateKey({ privateKey });
  const result = await new BridgeKit().bridge({
    from: { adapter, chain: from },
    to: { adapter, chain: ARC_BRIDGE_CHAIN },
    amount: amountUsd.toFixed(6),
  } as any);
  return { state: result.state, steps: result.steps as any };
};

const bookRepayment: Booker = async ({ human, agent, amountUsd }) => {
  const release = await acquireLedgerLock(human);
  try {
    const prepared = await prepareArcRepayment(human, amountUsd);
    if (!prepared.ok) throw new Error(prepared.error);
    const done = await commitArcRepayment({
      humanOwner: human,
      payingAgent: agent,
      beneficiaryAddress: agent.address,
      amount: prepared.amount,
      funding: { kind: "agent" },
    });
    return { repaidUsd: done.result.amountRepaid, txHash: done.txHash };
  } finally {
    release();
  }
};

const ARRIVAL_CHECKS = 15;
const ARRIVAL_WAIT_MS = 2000;

const readWallet = async (address: string) => Number(await getAgentWalletUsdc(address));

export async function repayFromOtherChain(
  p: { human: string; agent: Agent; from: BridgeChain; amountUsd: number },
  deps: { pause?: (ms: number) => Promise<void>; bridge?: Bridger; book?: Booker; wallet?: (a: string) => Promise<number>; key?: (a: string) => `0x${string}` | null | undefined; allow?: (a: string, usd: number) => { ok: boolean; reason?: string } } = {}
) {
  const { pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), bridge = bridgeWithKit, book = bookRepayment, wallet = readWallet, key = getAgentPrivateKey as any, allow = authorizeAgentSpend as any } = deps;

  const privateKey = key(p.agent.address);
  if (!privateKey) throw new Error("Lifeline does not hold this agent's key, so it cannot move its money.");
  // Same ceiling as any other use of the key.
  const allowed = allow(p.agent.address, p.amountUsd);
  if (!allowed.ok) throw new Error(`Lifeline will not sign for this agent: ${allowed.reason}`);

  const before = await wallet(p.agent.address);
  const bridged = await bridge({ privateKey, from: p.from, amountUsd: p.amountUsd });
  const steps = (bridged.steps ?? []).map((s) => ({ name: s.name, state: s.state, txHash: s.txHash }));
  if (bridged.state !== "success") {
    const failed = bridged.steps?.find((s) => s.state === "error");
    throw Object.assign(new Error(`The bridge did not finish: ${failed?.errorMessage ?? bridged.state}`), { steps });
  }

  // Repay what actually arrived: the bridge takes its fee from the amount sent.
  // The balance can lag the mint for a few seconds, depending on which RPC node answers.
  let arrived = 0;
  for (let i = 0; i < ARRIVAL_CHECKS; i++) {
    arrived = Math.round(((await wallet(p.agent.address)) - before) * 1e6) / 1e6;
    if (arrived > 0) break;
    if (i < ARRIVAL_CHECKS - 1) await pause(ARRIVAL_WAIT_MS);
  }
  if (!(arrived > 0)) throw Object.assign(new Error("The bridge reported success, but nothing has reached the agent's wallet on Arc yet. Repay once it arrives."), { steps });

  const repaid = await book({ human: p.human, agent: p.agent, amountUsd: arrived });
  return { bridgedUsd: arrived, repaidUsd: repaid.repaidUsd, txHash: repaid.txHash, steps };
}
