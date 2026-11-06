import { createWalletClient, formatUnits, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnetChain, getArcTransport, getPublicClient } from "./facilityContract";
import { ARC_USDC_ADDRESS } from "./arc";

/**
 * Lenders' money behind the credit.
 *
 * Lifeline's operator pays for what agents borrow. When the pool has room, a new
 * loan's principal is drawn from the pool to the operator; when the loan is repaid,
 * the principal and what the borrower paid on top go back, and lenders earn that.
 *
 * Neither step can stop a loan or a repayment: the borrower's position is already
 * right on the facility, and with no pool (or no room in it) the operator simply
 * funds the loan itself, as it always did.
 */
const POOL_ABI = parseAbi([
  "function drawable() view returns (uint256)",
  "function outstanding() view returns (uint256)",
  "function draw(address to, uint256 assets)",
  "function repay(uint256 principal, uint256 interest)",
]);
const APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const poolAddress = () => (process.env.LIFELINE_LENDING_POOL_ADDRESS || null) as `0x${string}` | null;
const micros = (usd: number) => parseUnits(Math.max(0, usd).toFixed(6), 6);
const toUsd = (n: bigint) => Number(formatUnits(n, 6));

/** The chain's side, swappable so tests run without one. */
export type PoolChain = {
  drawableUsd(): Promise<number>;
  outstandingUsd(): Promise<number>;
  draw(usd: number): Promise<string>;
  repay(principalUsd: number, interestUsd: number): Promise<string>;
};

function operatorWallet() {
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}` | undefined;
  if (!pk) throw new Error("No operator key to write to the pool.");
  return createWalletClient({ account: privateKeyToAccount(pk), chain: arcTestnetChain, transport: getArcTransport() });
}

async function confirmed(hash: `0x${string}`, what: string) {
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted (${hash})`);
  return hash;
}

const onChain: PoolChain = {
  drawableUsd: async () =>
    toUsd((await getPublicClient().readContract({ address: poolAddress()!, abi: POOL_ABI, functionName: "drawable" })) as bigint),
  outstandingUsd: async () =>
    toUsd((await getPublicClient().readContract({ address: poolAddress()!, abi: POOL_ABI, functionName: "outstanding" })) as bigint),
  async draw(usd) {
    const wallet = operatorWallet();
    return confirmed(
      await wallet.writeContract({ address: poolAddress()!, abi: POOL_ABI, functionName: "draw", args: [wallet.account.address, micros(usd)] }),
      "pool draw"
    );
  },
  async repay(principalUsd, interestUsd) {
    const wallet = operatorWallet();
    const principal = micros(principalUsd);
    const interest = micros(interestUsd);
    await confirmed(
      await wallet.writeContract({ address: ARC_USDC_ADDRESS as `0x${string}`, abi: APPROVE, functionName: "approve", args: [poolAddress()!, principal + interest] }),
      "pool approve"
    );
    return confirmed(await wallet.writeContract({ address: poolAddress()!, abi: POOL_ABI, functionName: "repay", args: [principal, interest] }), "pool repay");
  },
};

let chain: PoolChain = onChain;
export const usePoolChain = (c: PoolChain | null) => {
  chain = c ?? onChain;
};

/** Draw a new loan's principal from the pool, if it has room. Returns the transaction, or null. */
export async function fundLoanFromPool(principalUsd: number): Promise<string | null> {
  if (!poolAddress() || !(principalUsd > 0)) return null;
  try {
    if ((await chain.drawableUsd()) < principalUsd) return null;
    return await chain.draw(principalUsd);
  } catch (err: any) {
    console.warn("[pool] could not draw:", err?.shortMessage ?? err?.message ?? err);
    return null;
  }
}

/**
 * Return a repayment to the pool. Only what the pool actually lent goes back: a loan
 * the operator funded itself owes the pool nothing, and earns lenders nothing. Interest
 * is shared in the same proportion.
 */
export async function returnRepaymentToPool(principalUsd: number, interestUsd: number): Promise<string | null> {
  if (!poolAddress() || !(principalUsd > 0)) return null;
  try {
    const principal = Math.min(principalUsd, await chain.outstandingUsd());
    if (!(principal > 0)) return null;
    return await chain.repay(principal, interestUsd * (principal / principalUsd));
  } catch (err: any) {
    console.warn("[pool] could not return a repayment:", err?.shortMessage ?? err?.message ?? err);
    return null;
  }
}
