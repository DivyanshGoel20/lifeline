import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  encodePacked,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LIFELINE_CREDIT_FACILITY_ADDRESS, ARC_CHAIN_ID, ARC_RPC_URL, arcAddressUrl, ARC_NAME } from "./arc";
import { getAgentPrivateKey, authorizeAgentSpend } from "./agentKeys";
import { depositToAgentGateway } from "./disburse";
import { refHash } from "./paymentRef";
import { ARC_TREASURY } from "./browserChain";
import { collateralCreditUsd } from "./collateralStore";
import { CREDIT_TIERS } from "./reputationEngine";

export const arcTestnetChain = defineChain({
  id: ARC_CHAIN_ID,
  name: ARC_NAME,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [ARC_RPC_URL],
    },
  },
  contracts: {
    lifelineCreditFacility: {
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
    },
  },
});

export const LIFELINE_CREDIT_FACILITY_ABI = [
  {
    type: "function",
    name: "createCreditProfile",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "humanOwner", type: "address" },
      { name: "humanRoot", type: "bytes32" },
      { name: "initialCreditLimit", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setCreditLimit",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "newLimit", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "authorizeAgent",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "agentAddress", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordDrawdown",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "agentAddress", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "paymentCount", type: "uint32" },
      { name: "referenceHash", type: "bytes32" },
    ],
    outputs: [{ name: "loanId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordRepayment",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "beneficiaryAgent", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "actualRepaid", type: "uint256" },
      { name: "remainingDebt", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "repayWithToken",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "beneficiaryAgent", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "actualRepaid", type: "uint256" },
      { name: "remainingDebt", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setProfileStatus",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "status", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "markDefault",
    inputs: [{ name: "profileId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getProfile",
    inputs: [{ name: "profileId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "profileId", type: "bytes32" },
          { name: "humanOwner", type: "address" },
          { name: "humanRoot", type: "bytes32" },
          { name: "creditLimit", type: "uint256" },
          { name: "outstandingDebt", type: "uint256" },
          { name: "totalBorrowed", type: "uint256" },
          { name: "totalRepaid", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "createdAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRemainingCredit",
    inputs: [{ name: "profileId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getOutstandingDebt",
    inputs: [{ name: "profileId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAgentAuthorized",
    inputs: [
      { name: "profileId", type: "bytes32" },
      { name: "agentAddress", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProfileCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextLoanId",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextRepaymentId",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "agentAuthorizations",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [
      { name: "profileId", type: "bytes32" },
      { name: "isActive", type: "bool" },
      { name: "authorizedAt", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "drawdowns",
    inputs: [{ name: "loanId", type: "uint256" }],
    // Declaration order, which is also storage-slot order: the struct is packed.
    outputs: [
      { name: "profileId", type: "bytes32" },
      { name: "agentAddress", type: "address" },
      { name: "timestamp", type: "uint64" },
      { name: "status", type: "uint8" },
      { name: "amount", type: "uint128" },
      { name: "loanId", type: "uint64" },
      { name: "paymentCount", type: "uint32" },
      { name: "referenceHash", type: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "repayments",
    inputs: [{ name: "repaymentId", type: "uint256" }],
    outputs: [
      { name: "repaymentId", type: "uint256" },
      { name: "profileId", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "beneficiaryAgent", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export function getArcTransport() {
  const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let attempts = 0;
    const maxAttempts = 6;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await fetch(input, init);
        if (response.status === 429 || response.status === 503) {
          const delay = attempts * 1200 + Math.floor(Math.random() * 500);
          console.warn(`[ArcTransport] RPC status ${response.status}. Backing off ${delay}ms (attempt ${attempts}/${maxAttempts})...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const clone = response.clone();
        const text = await clone.text().catch(() => "");
        if (
          text.includes("Request exceeds defined limit") ||
          text.includes("rate limit") ||
          text.includes("limit exceeded") ||
          text.includes("Too Many Requests")
        ) {
          const delay = attempts * 1500 + Math.floor(Math.random() * 500);
          console.warn(`[ArcTransport] RPC throttled: "${text.substring(0, 80)}". Backing off ${delay}ms (attempt ${attempts}/${maxAttempts})...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (err: any) {
        if (attempts >= maxAttempts) throw err;
        const delay = attempts * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return fetch(input, init);
  };

  return http(ARC_RPC_URL, {
    fetchFn: customFetch,
    retryCount: 5,
    retryDelay: 1500,
  });
}

/**
 * Confirms a repayment the browser says it made.
 *
 * The client used to hand up a transaction hash and the server recorded it,
 * skipping its own settlement entirely - so the debt cleared on the strength of
 * a string. A wallet left on another chain produced a perfectly real hash for a
 * transfer Lifeline never received, and any caller could have posted arbitrary hex
 * to the same effect.
 *
 * Verified against Arc's own RPC, so a hash from another chain is simply not
 * found. Amount and recipient are checked too: a confirmed transaction is not
 * evidence of the right transaction.
 */
const RECEIPT_MAX_AGE_SECONDS = 2 * 60 * 60;

export async function verifyArcRepayment(params: {
  txHash: `0x${string}`;
  expectedTo: `0x${string}`;
  minAmountUsdc: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = getPublicClient();

  let tx;
  try {
    tx = await client.getTransaction({ hash: params.txHash });
  } catch {
    return {
      ok: false,
      reason:
        "That transaction is not on Arc. A wallet on another network produces a " +
        "real hash for a transfer Lifeline never receives.",
    };
  }
  if (!tx) return { ok: false, reason: "No such transaction on Arc." };

  try {
    const receipt = await client.waitForTransactionReceipt({ hash: params.txHash, timeout: 30_000 });
    if (receipt.status !== "success") return { ok: false, reason: "That transaction reverted." };
    // A repayment is a transfer made to repay, now. An old transfer into the
    // treasury - anyone's, for anything - is not one, however it is claimed.
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (Date.now() / 1000 - Number(block.timestamp) > RECEIPT_MAX_AGE_SECONDS) {
      return { ok: false, reason: "That transfer is too old to count as a repayment. Send a new one." };
    }
  } catch {
    return { ok: false, reason: "That transaction has not confirmed on Arc yet." };
  }

  if ((tx.to || "").toLowerCase() !== params.expectedTo.toLowerCase()) {
    return { ok: false, reason: `That transaction paid ${tx.to}, not Lifeline's treasury.` };
  }

  // Native USDC on Arc is 18-decimal, which is what the wallet sent.
  const paid = Number(tx.value) / 1e18;
  if (paid + 1e-9 < params.minAmountUsdc) {
    return {
      ok: false,
      reason: `That transaction moved ${paid.toFixed(6)} USDC, less than the ${params.minAmountUsdc.toFixed(6)} claimed.`,
    };
  }

  return { ok: true };
}

export function getPublicClient() {
  return createPublicClient({
    chain: arcTestnetChain,
    transport: getArcTransport(),
  });
}

export function computeProfileId(humanOwnerOrRoot: string): `0x${string}` {
  if (humanOwnerOrRoot.startsWith("0x") && humanOwnerOrRoot.length === 66) {
    return humanOwnerOrRoot as `0x${string}`;
  }
  if (humanOwnerOrRoot.startsWith("0x") && humanOwnerOrRoot.length === 42) {
    return keccak256(encodePacked(["address"], [humanOwnerOrRoot as `0x${string}`]));
  }
  return keccak256(encodePacked(["string"], [humanOwnerOrRoot]));
}

/**
 * Reads credit profile directly from LifelineCreditFacility contract on Arc.
 */
export async function getOnChainProfile(profileIdOrHuman: string) {
  const client = getPublicClient();
  const profileId = computeProfileId(profileIdOrHuman);

  try {
    const profile = await client.readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "getProfile",
      args: [profileId],
    });

    return {
      profileId: profile.profileId,
      humanOwner: profile.humanOwner,
      creditLimit: formatUnits(profile.creditLimit, 6),
      outstandingDebt: formatUnits(profile.outstandingDebt, 6),
      totalBorrowed: formatUnits(profile.totalBorrowed, 6),
      totalRepaid: formatUnits(profile.totalRepaid, 6),
      status: profile.status,
      createdAt: Number(profile.createdAt),
    };
  } catch (err: any) {
    return null;
  }
}

/**
 * Returns remaining credit headroom from Arc Testnet contract.
 */
export async function getOnChainRemainingCredit(profileIdOrHuman: string): Promise<string> {
  const client = getPublicClient();
  const profileId = computeProfileId(profileIdOrHuman);

  try {
    const remaining = await client.readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "getRemainingCredit",
      args: [profileId],
    });
    return formatUnits(remaining, 6);
  } catch {
    return "10.00";
  }
}

/**
 * Submits a real on-chain recordDrawdown transaction on Arc to LifelineCreditFacility.
 */
export async function executeOnChainDrawdown(params: {
  agentAddress: string;
  humanOwner: string;
  amountUsdc: number;
  paymentReference: string;
  /**
   * How many nanopayments this row settles. One for a draw a human asked for;
   * N when the pending ledger flushes N accumulated x402 payments at once.
   */
  paymentCount?: number;
  /**
   * Whether to hand the agent the money as well as book the debt.
   *
   * True for a draw the human asked for. False on the x402 path, where Lifeline
   * has already paid the seller directly and the drawdown is only the ledger
   * entry for that payment - disbursing there would pay twice.
   */
  disburse?: boolean;
}): Promise<{ txHash: `0x${string}`; blockNumber: number; depositTxHash?: string }> {
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}`;
  if (!pk) throw new Error("Missing PRIVATE_KEY for on-chain Arc Testnet transaction");

  const account = privateKeyToAccount(pk);
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: arcTestnetChain,
    transport: getArcTransport(),
  });

  const profileId = computeProfileId(params.humanOwner);
  const amountUnits = parseUnits(params.amountUsdc.toFixed(6), 6);

  // 1. The profile must already exist. Spending credit is not the moment to
  //    decide someone deserves credit: this used to open a funded profile for
  //    whatever humanOwner the caller named, which meant the borrow path could
  //    underwrite its own borrower.
  const profile = (await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "getProfile",
      args: [profileId],
    })
    .catch(() => null)) as any;

  if (!profile || Number(profile.createdAt) === 0) {
    throw new Error(
      "No on-chain credit profile for this human. Verify with World ID before drawing on the facility."
    );
  }

  // 2. Ensure Agent is authorized for this profile on Arc
  const isAuth = await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "isAgentAuthorized",
      args: [profileId, params.agentAddress as `0x${string}`],
    })
    .catch(() => false);

  // Authorisation is the human's decision, made once at agent registration.
  // Granting it here on demand made the check ceremonial - any agent could draw
  // on any profile simply by trying to.
  if (!isAuth) {
    throw new Error(
      `Agent ${params.agentAddress} is not authorized to draw on this credit profile.`
    );
  }

  // 3. Record Drawdown on Arc
  const txHash = await walletClient.writeContract({
    address: LIFELINE_CREDIT_FACILITY_ADDRESS,
    abi: LIFELINE_CREDIT_FACILITY_ABI,
    functionName: "recordDrawdown",
    args: [
      profileId,
      params.agentAddress as `0x${string}`,
      amountUnits,
      params.paymentCount ?? 1,
      // Only the hash goes on chain; the readable reference stays on the loan.
      refHash(params.paymentReference),
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  // 4. Hand over the money.
  //
  // Deliberately after recordDrawdown: the contract is what enforces the credit
  // limit, so it has to agree the draw is allowed before any funds move. If the
  // disbursement then fails, the debt is unwound rather than left standing
  // against a borrower who received nothing.
  let depositTxHash: string | undefined;
  if (params.disburse) {
    try {
      ({ depositTxHash } = await depositToAgentGateway(params.agentAddress, params.amountUsdc));
    } catch (err: any) {
      const reason = err?.shortMessage || err?.message || String(err);
      console.error("[FacilityContract] Disbursement failed, unwinding drawdown:", reason);

      let reversed = false;
      try {
        const unwind = await walletClient.writeContract({
          address: LIFELINE_CREDIT_FACILITY_ADDRESS,
          abi: LIFELINE_CREDIT_FACILITY_ABI,
          functionName: "recordRepayment",
          args: [
            profileId,
            params.agentAddress as `0x${string}`,
            params.agentAddress as `0x${string}`,
            amountUnits,
          ],
        });
        await publicClient.waitForTransactionReceipt({ hash: unwind });
        reversed = true;
      } catch (unwindErr: any) {
        // Both legs failed: say so loudly, with the tx to reconcile against.
        throw new Error(
          `Could not fund the agent AND could not reverse the drawdown ${txHash}. ` +
            `The profile owes ${params.amountUsdc} USDC it never received. ${reason}`
        );
      }
      if (reversed) throw new Error(`Could not fund the agent, so the draw was reversed. ${reason}`);
    }
  }

  return {
    txHash,
    blockNumber: Number(receipt.blockNumber),
    depositTxHash,
  };
}

/**
 * Submits a real on-chain repayment on Arc.
 * If the paying agent is an autonomous agent with a private key, this function
 * executes an actual on-chain native USDC transfer from the agent wallet to the Lifeline facility,
 * and then records the repayment on the LifelineCreditFacility contract.
 */
export async function executeOnChainRepayment(params: {
  humanOwner: string;
  payerAddress: string;
  agentAddress: string;
  amountUsdc: number;
  /**
   * The funds already moved - a browser wallet paid the treasury and the route
   * verified the receipt. Only the ledger entry is left to write. Skipping the
   * whole call in that case, as the route used to, cleared the debt off-chain
   * while the facility went on reporting it.
   */
  alreadyTransferred?: `0x${string}`;
  /**
   * Paid outside the chain - a card payment through Stripe, whose id this is.
   * Nothing moves from the agent; only the booking is written.
   */
  fundedOffChain?: string;
}): Promise<{ txHash: `0x${string}`; transferTxHash?: string; blockNumber: number }> {
  // 1. If payer is an autonomous agent with a stored private key, transfer real USDC on Arc
  let transferTxHash: string | undefined = params.alreadyTransferred;
  const agentKey =
    params.alreadyTransferred || params.fundedOffChain ? null : getAgentPrivateKey(params.payerAddress);

  // Money has to move before the debt does. Without a verified transfer, a
  // card payment, or a key Lifeline holds to make the transfer, there is
  // nothing to book - this used to record the repayment anyway, clearing
  // debt for free for any agent registered by address alone.
  if (!params.alreadyTransferred && !params.fundedOffChain && !agentKey) {
    throw new Error(
      "Lifeline does not hold this agent's key, so it cannot pay from the agent's wallet. Repay from a wallet you connect, or by card."
    );
  }

  if (agentKey) {
    const allowed = authorizeAgentSpend(params.payerAddress, params.amountUsdc);
    if (!allowed.ok) {
      throw new Error(`Lifeline will not move funds from this agent: ${allowed.reason}`);
    }

    try {
      const agentAccount = privateKeyToAccount(agentKey);
      const publicClient = getPublicClient();
      const agentWalletClient = createWalletClient({
        account: agentAccount,
        chain: arcTestnetChain,
        transport: getArcTransport(),
      });

      // The same treasury a browser repayment is checked against, so both
      // ways of repaying land in one place.
      const facilityRecipient = ARC_TREASURY;

      console.log(`[Repayment] Executing real on-chain transfer of ${params.amountUsdc} USDC from agent ${agentAccount.address} to facility ${facilityRecipient} on Arc...`);

      // On Arc Testnet (5042002), native currency is USDC (18 decimals)
      const transferHash = await agentWalletClient.sendTransaction({
        to: facilityRecipient,
        value: parseUnits(params.amountUsdc.toFixed(6), 18),
      });

      console.log(`[Repayment] Token transfer submitted on Arc: ${transferHash}`);
      await publicClient.waitForTransactionReceipt({ hash: transferHash });
      console.log(`[Repayment] Token transfer confirmed on Arc: ${transferHash}`);
      transferTxHash = transferHash;
    } catch (transferErr: any) {
      console.warn(`[Repayment] Autonomous wallet transfer notice:`, transferErr.message || transferErr);
      throw new Error(`Failed to transfer USDC from agent wallet on Arc: ${transferErr.shortMessage || transferErr.message}`);
    }
  }

  // 2. Submit contract recordRepayment on Arc
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}`;
  if (!pk) throw new Error("Missing PRIVATE_KEY for on-chain Arc Testnet transaction");

  const account = privateKeyToAccount(pk);
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: arcTestnetChain,
    transport: getArcTransport(),
  });

  const profileId = computeProfileId(params.humanOwner);
  const amountUnits = parseUnits(params.amountUsdc.toFixed(6), 6);

  const profile = (await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "getProfile",
      args: [profileId],
    })
    .catch(() => null)) as any;

  if (profile && Number(profile.outstandingDebt) === 0) {
    console.log(`[FacilityContract] On-chain profile ${profileId} has already settled all debt to 0.`);
    return {
      txHash: (transferTxHash as `0x${string}`) || "0x0000000000000000000000000000000000000000000000000000000000000000",
      transferTxHash,
      blockNumber: 0,
    };
  }

  const txHash = await walletClient.writeContract({
    address: LIFELINE_CREDIT_FACILITY_ADDRESS,
    abi: LIFELINE_CREDIT_FACILITY_ABI,
    functionName: "recordRepayment",
    args: [
      profileId,
      params.payerAddress as `0x${string}`,
      params.agentAddress as `0x${string}`,
      amountUnits,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash: (transferTxHash as `0x${string}`) || txHash,
    transferTxHash,
    blockNumber: Number(receipt.blockNumber),
  };
}

/**
 * Updates a credit profile limit on-chain on Arc upon tier graduation.
 */
export async function updateOnChainCreditLimit(
  humanOwner: string,
  newLimitUsdc: number
): Promise<string | null> {
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}`;
  if (!pk) return null;

  try {
    const account = privateKeyToAccount(pk);
    const publicClient = getPublicClient();
    const walletClient = createWalletClient({
      account,
      chain: arcTestnetChain,
      transport: getArcTransport(),
    });

    const profileId = computeProfileId(humanOwner);
    // Callers pass the earned tier; a deposit backs credit on top of it, so a
    // tier change must not write the deposit's credit away.
    const limitUnits = parseUnits((newLimitUsdc + collateralCreditUsd(humanOwner)).toFixed(6), 6);

    const hash = await walletClient.writeContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "setCreditLimit",
      args: [profileId, limitUnits],
    });

    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[TierUpgrade] On-chain credit limit upgraded to $${newLimitUsdc} in tx ${hash}`);
    return hash;
  } catch (err: any) {
    console.warn("[TierUpgrade] On-chain notice:", err.message || err);
    return null;
  }
}

/**
 * Ensures an agent is authorized on the LifelineCreditFacility contract on Arc.
 */
export async function syncAgentToContractOnChain(
  agentAddress: string,
  humanOwner: string
): Promise<{ txHash: string; blockNumber: number } | null> {
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}`;
  if (!pk) return null;

  try {
    const account = privateKeyToAccount(pk);
    const publicClient = getPublicClient();
    const walletClient = createWalletClient({
      account,
      chain: arcTestnetChain,
      transport: getArcTransport(),
    });

    const profileId = computeProfileId(humanOwner);

    const existing = await publicClient
      .readContract({
        address: LIFELINE_CREDIT_FACILITY_ADDRESS,
        abi: LIFELINE_CREDIT_FACILITY_ABI,
        functionName: "getProfile",
        args: [profileId],
      })
      .catch(() => null);

    // Deliberately does not create the profile. Underwriting happens in exactly
    // one place - the World-verified path in ensureHumanProfileOnChain - because
    // this function is reachable from agent registration, and minting credit
    // there let anyone open a funded profile against a humanRoot of their own
    // choosing, with no proof of personhood anywhere in the path.
    if (!existing || Number(existing.createdAt) === 0) {
      throw new Error(
        "No credit profile for this human. Verify with World ID before registering an agent."
      );
    }

    const authTx = await walletClient.writeContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "authorizeAgent",
      args: [profileId, agentAddress as `0x${string}`],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: authTx });
    return { txHash: authTx, blockNumber: Number(receipt.blockNumber) };
  } catch (err: any) {
    console.warn("[OnChainSync] Notice:", err.message);
    return null;
  }
}

/**
 * Ensures an on-chain credit profile exists for a World ID human operator on Arc.
 * If the profile does not exist yet, initializes it with the first tier's USDC credit limit.
 */
export async function ensureHumanProfileOnChain(
  humanOwner: string
): Promise<{ txHash?: string; profileId: `0x${string}` }> {
  const profileId = computeProfileId(humanOwner);
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}`;
  if (!pk) return { profileId };

  try {
    const account = privateKeyToAccount(pk);
    const publicClient = getPublicClient();
    const walletClient = createWalletClient({
      account,
      chain: arcTestnetChain,
      transport: getArcTransport(),
    });

    const existing = (await publicClient
      .readContract({
        address: LIFELINE_CREDIT_FACILITY_ADDRESS,
        abi: LIFELINE_CREDIT_FACILITY_ABI,
        functionName: "getProfile",
        args: [profileId],
      })
      .catch(() => null)) as any;

    if (!existing || Number(existing.createdAt) === 0) {
      console.log(`[OnChainProfile] Provisioning starter on-chain profile on Arc for World ID operator ${humanOwner}...`);
      const humanRoot = computeProfileId(humanOwner);
      const createTx = await walletClient.writeContract({
        address: LIFELINE_CREDIT_FACILITY_ADDRESS,
        abi: LIFELINE_CREDIT_FACILITY_ABI,
        functionName: "createCreditProfile",
        args: [profileId, account.address, humanRoot, parseUnits(String(CREDIT_TIERS[0].creditLimit), 6)],
      });
      await publicClient.waitForTransactionReceipt({ hash: createTx });
      console.log(`[OnChainProfile] Provisioned profile ${profileId} on Arc in tx ${createTx}`);
      return { txHash: createTx, profileId };
    }

    return { profileId };
  } catch (err: any) {
    // Rethrown, not swallowed: the verify route reports profileProvisioned to
    // the dashboard, and a failure logged here and returned as success made
    // that flag true no matter what the chain said.
    console.warn("[OnChainProfile] Provisioning failed:", err.message);
    throw err;
  }
}

/**
 * Fetches complete real-time telemetry directly from the LifelineCreditFacility contract on Arc.
 */
/**
 * Ledger rows, read once.
 *
 * drawdowns[id] and repayments[id] are assigned exactly once in the contract
 * and never mutated, so a row that has been read can be kept indefinitely.
 * Without this, every telemetry poll replayed the whole history one sequential
 * RPC call per record - which is what was rate-limiting the public Arc node.
 * Steady state is now one call for the head id plus one per genuinely new row.
 */
// On globalThis so every route shares one cache (Next bundles routes apart).
const recordCache: Record<"drawdowns" | "repayments", Map<string, any>> = ((
  globalThis as any
).__lifelineRecordCache ??= { drawdowns: new Map(), repayments: new Map() });

// Arc's public RPC answers 429 to bursts. Rows are fetched a few at a time.
const RPC_BATCH = 6;

/**
 * Rows are immutable per contract, not per id. Keying on the id alone meant a
 * redeploy served the previous facility's ledger indefinitely - the new
 * contract's row 1 was never fetched because row 1 was already cached.
 */
const cacheKeyFor = (id: bigint) => `${LIFELINE_CREDIT_FACILITY_ADDRESS.toLowerCase()}:${id}`;

async function warmRecordCache(
  publicClient: ReturnType<typeof getPublicClient>,
  fn: "drawdowns" | "repayments",
  nextId: bigint
) {
  const key = cacheKeyFor;
  const cache = recordCache[fn];
  const missing: bigint[] = [];
  for (let id = BigInt(1); id < nextId; id++) {
    if (!cache.has(key(id))) missing.push(id);
  }
  if (missing.length === 0) return cache;

  const rows: ({ id: bigint; row: any } | null)[] = [];
  for (let i = 0; i < missing.length; i += RPC_BATCH) {
    rows.push(
      ...(await Promise.all(
        missing.slice(i, i + RPC_BATCH).map((id) =>
          publicClient
            .readContract({
              address: LIFELINE_CREDIT_FACILITY_ADDRESS,
              abi: LIFELINE_CREDIT_FACILITY_ABI,
              functionName: fn,
              args: [id],
            })
            .then((row: any) => ({ id, row }))
            .catch(() => null)
        )
      ))
    );
  }

  for (const entry of rows) {
    if (entry) cache.set(key(entry.id), entry.row);
  }
  return cache;
}

export async function fetchCompleteContractTelemetry(
  customHumanOwner?: string,
  knownAgents: string[] = []
) {
  const publicClient = getPublicClient();
  const latestBlock = await publicClient.getBlockNumber();

  const owner = await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "owner",
    })
    .catch(() => "0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3" as `0x${string}`);

  const humanOwner = customHumanOwner || "0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3";
  const profileId = computeProfileId(humanOwner);

  const profileData = (await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "getProfile",
      args: [profileId],
    })
    .catch(() => null)) as any;

  const remainingUnits = await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "getRemainingCredit",
      args: [profileId],
    })
    .catch(() => BigInt(0));

  const statusLabels = ["Inactive", "Active", "Suspended", "Defaulted"];
  const loanStatusLabels = ["Active", "Settled", "Defaulted"];

  // Query authorizations for known agents
  const defaultAgentsToCheck = Array.from(
    new Set(
      knownAgents.map((a) => a.toLowerCase())
    )
  );

  // Two reads per agent, in parallel. Authorisation is revocable so it cannot be
  // cached like the ledger rows, but there is no reason to await each agent in
  // turn: sequentially this was 2N round trips for data with no interdependency.
  const authorizedAgents = (
    await Promise.all(
      defaultAgentsToCheck.map(async (agentAddr) => {
        try {
          const [isAuth, authRecord] = await Promise.all([
            publicClient.readContract({
              address: LIFELINE_CREDIT_FACILITY_ADDRESS,
              abi: LIFELINE_CREDIT_FACILITY_ABI,
              functionName: "isAgentAuthorized",
              args: [profileId, agentAddr as `0x${string}`],
            }),
            publicClient
              .readContract({
                address: LIFELINE_CREDIT_FACILITY_ADDRESS,
                abi: LIFELINE_CREDIT_FACILITY_ABI,
                functionName: "agentAuthorizations",
                args: [agentAddr as `0x${string}`],
              })
              .catch(() => null) as Promise<any>,
          ]);

          const authTime = authRecord ? Number(authRecord[2] || 0) : 0;

          return {
            agentAddress: agentAddr,
            isAuthorized: Boolean(isAuth),
            profileId: authRecord ? authRecord[0] : profileId,
            authorizedAtTimestamp: authTime,
            authorizedAtIso:
              authTime > 0 ? new Date(authTime * 1000).toISOString() : "Active on Arc",
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean) as any[];

  // Query nextLoanId and all drawdowns
  const nextLoanId = (await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "nextLoanId",
    })
    .catch(() => BigInt(1))) as bigint;

  const drawdownRows = await warmRecordCache(publicClient, "drawdowns", nextLoanId);

  const drawdowns = [];
  for (let id = BigInt(1); id < nextLoanId; id++) {
    try {
      const d = drawdownRows.get(cacheKeyFor(id)) as any;
      if (!d) continue;

      // Filter drawdowns for this specific human profile if querying by owner.
      // profileId is d[0] in the packed struct; d[1] is the agent, and comparing
      // that to a profile id silently matched nothing.
      if (customHumanOwner && d[0]?.toLowerCase() !== profileId.toLowerCase()) {
        continue;
      }

      // Packed struct order: profileId, agentAddress, timestamp, status,
      // amount, loanId, paymentCount, referenceHash.
      const timeNum = Number(d[2] || 0);
      const amountUnits = Number(d[4] || 0);
      const statusCode = Number(d[3] || 0);

      drawdowns.push({
        loanId: Number(d[5] || id),
        profileId: d[0],
        agentAddress: d[1],
        amountRaw: d[4].toString(),
        amountUsdc: amountUnits / 1e6,
        timestamp: timeNum,
        timestampIso: timeNum > 0 ? new Date(timeNum * 1000).toISOString() : "Unknown",
        statusCode,
        status: loanStatusLabels[statusCode] || "Active",
        paymentCount: Number(d[6] || 1),
        referenceHash: d[7] || "",
        // Readable reference lives on the loan record, matched by the UI.
        paymentReference: "",
        arcscanUrl: arcAddressUrl(d[2]),
      });
    } catch {
      // ignore
    }
  }

  // Query nextRepaymentId and all repayments
  const nextRepaymentId = (await publicClient
    .readContract({
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      abi: LIFELINE_CREDIT_FACILITY_ABI,
      functionName: "nextRepaymentId",
    })
    .catch(() => BigInt(1))) as bigint;

  const repaymentRows = await warmRecordCache(publicClient, "repayments", nextRepaymentId);

  const repayments = [];
  for (let id = BigInt(1); id < nextRepaymentId; id++) {
    try {
      const r = repaymentRows.get(cacheKeyFor(id)) as any;
      if (!r) continue;

      // Filter repayments for this specific human profile if querying by owner
      if (customHumanOwner && r[1]?.toLowerCase() !== profileId.toLowerCase()) {
        continue;
      }

      const timeNum = Number(r[5] || 0);
      const amountUnits = Number(r[4] || 0);

      repayments.push({
        repaymentId: Number(r[0] || id),
        profileId: r[1],
        payer: r[2],
        beneficiaryAgent: r[3],
        amountRaw: r[4].toString(),
        amountUsdc: amountUnits / 1e6,
        timestamp: timeNum,
        timestampIso: timeNum > 0 ? new Date(timeNum * 1000).toISOString() : "Unknown",
      });
    } catch {
      // ignore
    }
  }

  return {
    network: {
      name: "Arc Testnet",
      chainId: ARC_CHAIN_ID,
      rpcUrl: ARC_RPC_URL,
      latestBlock: Number(latestBlock),
    },
    contract: {
      address: LIFELINE_CREDIT_FACILITY_ADDRESS,
      owner,
      explorerUrl: arcAddressUrl(LIFELINE_CREDIT_FACILITY_ADDRESS),
    },
    profile: profileData && Number(profileData.createdAt) > 0
      ? {
          profileId,
          humanOwner: profileData.humanOwner,
          humanRoot: profileData.humanRoot,
          creditLimit: Number(profileData.creditLimit) / 1e6,
          creditLimitRaw: profileData.creditLimit.toString(),
          outstandingDebt: Number(profileData.outstandingDebt) / 1e6,
          outstandingDebtRaw: profileData.outstandingDebt.toString(),
          remainingCredit: Number(remainingUnits) / 1e6,
          remainingCreditRaw: remainingUnits.toString(),
          totalBorrowed: Number(profileData.totalBorrowed) / 1e6,
          totalBorrowedRaw: profileData.totalBorrowed.toString(),
          totalRepaid: Number(profileData.totalRepaid) / 1e6,
          totalRepaidRaw: profileData.totalRepaid.toString(),
          statusCode: Number(profileData.status),
          status: statusLabels[Number(profileData.status)] || "Active",
          createdAtTimestamp: Number(profileData.createdAt),
          createdAtIso: new Date(Number(profileData.createdAt) * 1000).toISOString(),
        }
      : {
          profileId,
          humanOwner: humanOwner,
          humanRoot: computeProfileId(humanOwner),
          creditLimit: CREDIT_TIERS[0].creditLimit,
          creditLimitRaw: String(parseUnits(String(CREDIT_TIERS[0].creditLimit), 6)),
          outstandingDebt: 0,
          outstandingDebtRaw: "0",
          remainingCredit: CREDIT_TIERS[0].creditLimit,
          remainingCreditRaw: String(parseUnits(String(CREDIT_TIERS[0].creditLimit), 6)),
          totalBorrowed: 0,
          totalBorrowedRaw: "0",
          totalRepaid: 0,
          totalRepaidRaw: "0",
          statusCode: 1,
          status: "Active",
          createdAtTimestamp: Math.floor(Date.now() / 1000),
          createdAtIso: new Date().toISOString(),
        },
    authorizedAgents,
    drawdowns,
    repayments,
    totalDrawdownsCount: drawdowns.length,
    totalRepaymentsCount: repayments.length,
  };
}

/** The Arc contract's profile statuses, in its enum order. */
export const ARC_PROFILE_STATUS = { inactive: 0, active: 1, suspended: 2, defaulted: 3 } as const;
export type ArcProfileStatus = keyof typeof ARC_PROFILE_STATUS;

async function underwriterWrite(functionName: "setProfileStatus" | "markDefault", args: readonly unknown[]): Promise<string> {
  const pk = (process.env.PRIVATE_KEY || process.env.LIFELINE_FUNDING_PRIVATE_KEY) as `0x${string}`;
  if (!pk) throw new Error("No underwriter key (PRIVATE_KEY) to change a profile's status");
  const walletClient = createWalletClient({ account: privateKeyToAccount(pk), chain: arcTestnetChain, transport: getArcTransport() });
  const hash = await walletClient.writeContract({
    address: LIFELINE_CREDIT_FACILITY_ADDRESS,
    abi: LIFELINE_CREDIT_FACILITY_ABI,
    functionName,
    args: args as any,
  });
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

/** The human's Arc profile status, as the contract has it. */
export async function readArcProfileStatus(humanOwner: string): Promise<ArcProfileStatus | null> {
  const profile = (await getPublicClient().readContract({
    address: LIFELINE_CREDIT_FACILITY_ADDRESS,
    abi: LIFELINE_CREDIT_FACILITY_ABI,
    functionName: "getProfile",
    args: [computeProfileId(humanOwner)],
  })) as any;
  if (!profile || !Number(profile.createdAt)) return null;
  return (Object.keys(ARC_PROFILE_STATUS) as ArcProfileStatus[])[Number(profile.status)] ?? null;
}

/** Suspend or re-activate a profile (the contract refuses drawdowns unless active). */
export const setArcProfileStatus = (humanOwner: string, status: "active" | "suspended") =>
  underwriterWrite("setProfileStatus", [computeProfileId(humanOwner), ARC_PROFILE_STATUS[status]]);

/** Record a default on chain, publicly. The debt stays; repaying it cures the profile. */
export const markArcDefault = (humanOwner: string) => underwriterWrite("markDefault", [computeProfileId(humanOwner)]);
