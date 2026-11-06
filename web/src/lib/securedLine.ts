import { createWalletClient, encodeFunctionData, formatUnits, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnetChain, computeProfileId, getArcTransport, getPublicClient, updateOnChainCreditLimit } from "./facilityContract";
import { ARC_USDC_ADDRESS } from "./arc";
import { collateralCreditUsd, saveCollateral } from "./collateralStore";
import { getAgentsByOwner } from "./agentStore";
import { getHumanCreditTier } from "./reputationStore";
import { bookArcRepayment } from "./repayCore";

/**
 * Deposit-backed credit, on top of LifelineCollateralVault.
 *
 * The vault holds the money and enforces the rules. This keeps Lifeline's books
 * in step with it: the credit a deposit backs, and the debt a seizure paid.
 */
export const VAULT_ABI = parseAbi([
  "function bindController(bytes32 profileId, address controller)",
  "function controllerOf(bytes32 profileId) view returns (address)",
  "function deposit(bytes32 profileId, uint256 assets) returns (uint256)",
  "function requestWithdrawal(bytes32 profileId, uint256 assets)",
  "function cancelWithdrawal(bytes32 profileId)",
  "function withdraw(bytes32 profileId, address to) returns (uint256)",
  "function seize(bytes32 profileId) returns (uint256)",
  "function latchDefault(bytes32 profileId)",
  "function defaultLatched(bytes32 profileId) view returns (bool)",
  "function assetsOf(bytes32 profileId) view returns (uint256)",
  "function creditableOf(bytes32 profileId) view returns (uint256)",
  "function ltvBps() view returns (uint256)",
  "function withdrawDelay() view returns (uint256)",
  "function withdrawalOf(bytes32 profileId) view returns (uint256 assets, uint256 readyAt)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const USDC_DECIMALS = 6;

export const vaultAddress = () => (process.env.LIFELINE_COLLATERAL_VAULT_ADDRESS || null) as `0x${string}` | null;

function requireVault(): `0x${string}` {
  const v = vaultAddress();
  if (!v) throw new Error("Deposit-backed credit is not set up: LIFELINE_COLLATERAL_VAULT_ADDRESS is empty.");
  return v;
}

/** The vault's side, swappable so tests run without a chain. */
export type VaultChain = {
  read(human: string): Promise<{ assetsUsd: number; creditUsd: number; controller: string; pendingWithdrawalUsd: number; readyAt: number }>;
  setLimit(human: string, usd: number): Promise<unknown>;
  bind(human: string, wallet: string): Promise<string>;
  /** Returns how much was taken. Zero means there was nothing to take. */
  seize(human: string): Promise<{ txHash: string; takenUsd: number }>;
};

const operatorKey = () => {
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}` | undefined;
  if (!pk) throw new Error("No operator key (PRIVATE_KEY) to write to the vault.");
  return pk;
};

const onChain: VaultChain = {
  async read(human) {
    const address = requireVault();
    const profileId = computeProfileId(human);
    const client = getPublicClient();
    const read = (functionName: any, args: any[] = [profileId]) =>
      client.readContract({ address, abi: VAULT_ABI, functionName, args } as any) as Promise<any>;
    const [assets, credit, controller, withdrawal] = await Promise.all([
      read("assetsOf"),
      read("creditableOf"),
      read("controllerOf"),
      read("withdrawalOf"),
    ]);
    return {
      assetsUsd: Number(formatUnits(assets, USDC_DECIMALS)),
      creditUsd: Number(formatUnits(credit, USDC_DECIMALS)),
      controller,
      pendingWithdrawalUsd: Number(formatUnits(withdrawal[0], USDC_DECIMALS)),
      readyAt: Number(withdrawal[1]),
    };
  },
  setLimit: (human, usd) => updateOnChainCreditLimit(human, usd),
  async bind(human, wallet) {
    const hash = await createWalletClient({
      account: privateKeyToAccount(operatorKey()),
      chain: arcTestnetChain,
      transport: getArcTransport(),
    }).writeContract({
      address: requireVault(),
      abi: VAULT_ABI,
      functionName: "bindController",
      args: [computeProfileId(human), wallet as `0x${string}`],
    });
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`bindController reverted (${hash})`);
    return hash;
  },
  async seize(human) {
    const address = requireVault();
    const profileId = computeProfileId(human);
    const client = getPublicClient();
    const before = (await client.readContract({ address, abi: VAULT_ABI, functionName: "assetsOf", args: [profileId] })) as bigint;
    if (before === 0n) return { txHash: "", takenUsd: 0 };
    const wallet = createWalletClient({
      account: privateKeyToAccount(operatorKey()),
      chain: arcTestnetChain,
      transport: getArcTransport(),
    });
    // The facility lets a profile's owner suspend it, which overwrites Defaulted.
    // The latch keeps the default on record in the vault, so that cannot block this.
    const latched = await client.readContract({ address, abi: VAULT_ABI, functionName: "defaultLatched", args: [profileId] });
    if (!latched) {
      const latch = await wallet.writeContract({ address, abi: VAULT_ABI, functionName: "latchDefault", args: [profileId] });
      await client.waitForTransactionReceipt({ hash: latch });
    }
    const hash = await wallet.writeContract({ address, abi: VAULT_ABI, functionName: "seize", args: [profileId] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`seize reverted (${hash})`);
    const after = (await client.readContract({ address, abi: VAULT_ABI, functionName: "assetsOf", args: [profileId] })) as bigint;
    return { txHash: hash, takenUsd: Number(formatUnits(before - after, USDC_DECIMALS)) };
  },
};

let chain: VaultChain = onChain;
export const useVaultChain = (c: VaultChain | null) => {
  chain = c ?? onChain;
};

/**
 * Read the deposit from the chain, and let the line reflect it, in both places a
 * limit lives. Called after a deposit or withdrawal request; safe to call often.
 */
export async function syncCollateral(human: string, now = Date.now()) {
  const before = collateralCreditUsd(human);
  const state = await chain.read(human);
  saveCollateral(human, { assetsUsd: state.assetsUsd, creditUsd: state.creditUsd, syncedAt: now });
  const limitChanged = state.creditUsd !== before;
  if (limitChanged) await chain.setLimit(human, getHumanCreditTier(human, "arc").creditLimit);
  return { ...state, limitChanged };
}

export async function bindDepositWallet(human: string, wallet: string): Promise<{ alreadyBound: boolean; txHash?: string }> {
  const { controller } = await chain.read(human);
  const zero = /^0x0+$/.test(controller);
  if (!zero) {
    if (controller.toLowerCase() === wallet.toLowerCase()) return { alreadyBound: true };
    throw new Error("A different wallet already controls this deposit.");
  }
  return { alreadyBound: false, txHash: await chain.bind(human, wallet) };
}

/**
 * Pay a defaulted human's debt from their deposit, and book it on Lifeline's
 * ledger. The vault checks the default itself, so this cannot take from anyone
 * the facility has not already marked.
 */
export async function seizeCollateral(human: string): Promise<{ takenUsd: number; txHash?: string }> {
  const { txHash, takenUsd } = await chain.seize(human);
  if (!(takenUsd > 0)) return { takenUsd: 0 };
  const agent = getAgentsByOwner(human).find((a) => (a.rail ?? "arc") === "arc");
  if (agent) await bookArcRepayment({ humanOwner: human, payingAgent: agent, beneficiaryAddress: agent.address, amount: takenUsd, txHash, agentPaid: false });
  await syncCollateral(human).catch((err) => console.warn("[secured] sync after seizure:", err?.message ?? err));
  return { takenUsd, txHash };
}

/** The transactions a wallet signs to fund a deposit, ready to send. */
export function depositCalls(human: string, amountUsd: number) {
  const vault = requireVault();
  const assets = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  return [
    { to: ARC_USDC_ADDRESS, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [vault, assets] }), description: "Let the vault take the deposit" },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [computeProfileId(human), assets] }), description: "Deposit" },
  ];
}

/** What a browser wallet signs to prove it belongs to the signed-in human. */
export const linkMessage = (nonce: string) => `Link this wallet to my Lifeline account.\nNonce: ${nonce}`;

/** The transaction to take back a request to withdraw. */
export function cancelWithdrawalCalls(human: string) {
  return [
    { to: requireVault(), data: encodeFunctionData({ abi: VAULT_ABI, functionName: "cancelWithdrawal", args: [computeProfileId(human)] }), description: "Cancel the withdrawal" },
  ];
}

/** The transactions to take a deposit out: ask, wait out the delay, then withdraw. */
export function withdrawalCalls(human: string, amountUsd: number, to: string) {
  const vault = requireVault();
  const profileId = computeProfileId(human);
  return [
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "requestWithdrawal", args: [profileId, parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS)] }), description: "Ask to withdraw" },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [profileId, to as `0x${string}`] }), description: "Withdraw, once the delay has passed" },
  ];
}
