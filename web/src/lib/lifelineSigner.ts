import { healthyArcEndpoint } from "./arcRpc";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ORIGINATION_FEE_RATE } from "./reputationEngine";
import { approvalCovers, capHoldVerdict } from "./spendingCap";
import { borrowingBlocked } from "./standing";
import { formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import crypto from "crypto";
import {
  getAgentByAddress,
  getHumanFacilityStats,
  updateAgentInStore,
} from "./agentStore";
import { createLoan } from "./loanStore";
import { recordPayment, PaymentRecord } from "./paymentStore";
import { LIFELINE_CREDIT_FACILITY_ADDRESS, arcTxUrl, ARC_GATEWAY_CHAIN, ARC_LABEL, ARC_X402_NETWORK } from "./arc";
import { addPending } from "./pendingLedger";
import { flushAgent } from "./ledgerFlush";
import { getAgentPrivateKey, authorizeAgentSpend } from "./agentKeys";
import { screenOutgoing, verdictLine, Verdict } from "./intercepta";
import { createHold } from "./holdStore";
import type { X402Trace } from "@lifeline/sui";
import { acquireLedgerLock, syncAgentDebts } from "./ledgerLock";
import { creditRefusal } from "./riskControls";
import { listingFor } from "./discovery";
import { matchesSchema, recordSellerOutcome } from "./sellerQuality";

// What Circle's BatchEvmScheme signs, reproduced so the authorisation
// Intercepta screens is byte for byte the one that gets signed.
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
// Gateway wants an authorisation good for a week, plus slack.
const GATEWAY_AUTH_VALIDITY_SECONDS = 7 * 24 * 60 * 60 + 100;

export interface AgentPaymentContext {
  agentAddress: string;
  agentPrivateKey?: `0x${string}`;
  humanProfileId?: string;
  /**
   * Ceiling set by an agent's mandate, when the caller holds one rather than a
   * browser session. Folded into the headroom below, so the tightest of the
   * three - agent limit, facility headroom, mandate cap - is what binds.
   */
  maxCreditUsd?: number;
  /**
   * The human has looked at a held payment and said yes. Turns a hold into a
   * payment; a refusal stays a refusal.
   */
  humanApproved?: boolean;
  /** What the human approved: the payment must still be to this payee, for no more. */
  approvedFor?: { payTo: string; amountUsd: number };
}

export interface LifelinePayResult {
  success: boolean;
  /** How the x402 payment happened, step by step. */
  x402?: X402Trace;
  /** Intercepta's verdict, taken before anything was signed. */
  screening?: Verdict & { approvedByHuman?: boolean };
  /** Set when the verdict sent the payment to the human. */
  hold?: { holdId: string; expiresAt: number };
  fundingSource: "AGENT_GATEWAY" | "LIFELINE_FACILITY";
  amount: string;
  borrowed: string;
  drawdownId: string | null;
  agentGatewayBalance: string;
  shortfall: string;
  data: any;
  status: number;
  transactionId?: string;
  arcTxHash?: string;
  arcTxLink?: string;
  circleSettlementId?: string;
  payer: string;
  creditFacilityAddress?: string;
  agentDebt?: number;
  facilityDebt?: number;
}

export class LifelineSigner {
  private fundingClient: GatewayClient;
  private fundingPrivateKey: `0x${string}`;
  public creditFacilityAddress: string;

  constructor(options?: {
    fundingPrivateKey?: `0x${string}`;
    chain?: "arcTestnet";
    creditFacilityAddress?: string;
  }) {
    this.creditFacilityAddress =
      options?.creditFacilityAddress ||
      process.env.LIFELINE_CREDIT_FACILITY_ADDRESS ||
      LIFELINE_CREDIT_FACILITY_ADDRESS;

    // Default to the Circle Gateway-funded account on Arc
    this.fundingPrivateKey =
      options?.fundingPrivateKey ||
      (process.env.LIFELINE_FUNDING_PRIVATE_KEY as `0x${string}`) ||
      (process.env.PRIVATE_KEY as `0x${string}`);

    if (!this.fundingPrivateKey) {
      throw new Error("Missing LIFELINE_FUNDING_PRIVATE_KEY or PRIVATE_KEY in environment");
    }

    this.fundingClient = new GatewayClient({
      chain: options?.chain || ARC_GATEWAY_CHAIN,
      privateKey: this.fundingPrivateKey,
      rpcUrl: healthyArcEndpoint(),
    });
  }

  /**
   * Returns Lifeline's funding address used to provide overdraft purchasing capacity.
   */
  get fundingAddress(): string {
    return this.fundingClient.address;
  }

  /**
   * Queries the real Circle Gateway available balance for any agent address.
   */
  async getAgentGatewayBalance(
    agentAddress: string
  ): Promise<{ available: bigint; formattedAvailable: string }> {
    const balances = await (this.fundingClient as any).getGatewayBalance(
      agentAddress
    );
    return {
      available: balances.available,
      formattedAvailable: balances.formattedAvailable,
    };
  }

  /**
   * Wraps the x402 payment flow with Lifeline's autonomous overdraft decision engine.
   */
  async pay(
    rawUrl: string,
    agentContext: AgentPaymentContext,
    options?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: any;
    }
  ): Promise<LifelinePayResult> {
    const method = options?.method ?? "GET";
    const headers = {
      "Content-Type": "application/json",
      ...options?.headers,
    };
    const serializedBody =
      options?.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : undefined;

    const url = rawUrl.startsWith("/")
      ? `${process.env.NEXT_PUBLIC_APP_URL || process.env.LIFELINE_APP_URL || "http://localhost:3000"}${rawUrl}`
      : rawUrl;

    // Step 1: Initial request to resource. Redirects are never followed: a
    // public URL could bounce the request into a private network.
    const initialResponse = await fetch(url, {
      redirect: "manual",
      method,
      headers,
      body: serializedBody,
    });

    if (initialResponse.status !== 402) {
      if (initialResponse.ok) {
        const data = await readBody(initialResponse);
        return {
          success: true,
          fundingSource: "AGENT_GATEWAY",
          amount: "0",
          borrowed: "0",
          drawdownId: null,
          agentGatewayBalance: "0",
          shortfall: "0",
          data,
          status: initialResponse.status,
          payer: agentContext.agentAddress,
        };
      }
      throw new Error(`Request failed with status ${initialResponse.status}`);
    }

    // Step 2: Parse 402 Payment Required requirements
    const paymentRequiredHeader = initialResponse.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      throw new Error("Missing PAYMENT-REQUIRED header in HTTP 402 response");
    }

    const paymentRequired = JSON.parse(
      Buffer.from(paymentRequiredHeader, "base64").toString("utf-8")
    );
    const accepts = paymentRequired.accepts;
    if (!accepts || accepts.length === 0) {
      throw new Error("No payment options specified in 402 response");
    }

    // Select Arc Testnet batching option (Chain ID 5042002)
    const batchingOption = accepts.find(
      (opt: any) =>
        opt.network === ARC_X402_NETWORK &&
        opt.extra?.name === "GatewayWalletBatched"
    );

    if (!batchingOption) {
      throw new Error(
        "No supported Circle Gateway batching option found for " + ARC_LABEL
      );
    }

    const x402Version = paymentRequired.x402Version ?? 2;
    const requestedAmount = BigInt(batchingOption.amount);
    const requestedAmountFormatted = formatUnits(requestedAmount, 6);
    const sellerAddress = batchingOption.payTo;

    // Step 3: Query Agent's REAL Circle Gateway available balance
    const { available: agentGatewayAvailable, formattedAvailable } =
      await this.getAgentGatewayBalance(agentContext.agentAddress);

    // Resolve Human Credit Profile
    const agent = getAgentByAddress(agentContext.agentAddress);
    // Supplied by the caller only after a World session has been verified and
    // the agent confirmed to belong to that human. The old fallback chain ended
    // in a hardcoded address, so a missing identity quietly became somebody
    // else's credit line rather than an error.
    const humanOwner = agentContext.humanProfileId;
    if (!humanOwner) {
      throw new Error("No verified human is associated with this payment.");
    }

    const paymentId = `pay_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 7)}`;

    // Decision Logic: Can agent pay normally?
    if (agentGatewayAvailable >= requestedAmount) {
      // ----------------------------------------------------
      // PATH A: NORMAL AGENT PAYMENT (No Overdraft)
      // ----------------------------------------------------
      const resolvedAgentKey =
        agentContext.agentPrivateKey ||
        getAgentPrivateKey(agentContext.agentAddress);

      if (!resolvedAgentKey) {
        throw new Error(
          `Agent ${agentContext.agentAddress} has sufficient Gateway balance ($${formattedAvailable} >= $${requestedAmountFormatted}), but no private key was found to sign the payment.`
        );
      }

      // The key is held on the agent's behalf under a ceiling and an expiry;
      // both are checked before it is used, not only when it was registered.
      const allowed = authorizeAgentSpend(
        agentContext.agentAddress,
        parseFloat(requestedAmountFormatted)
      );
      if (!allowed.ok) {
        throw new Error(`Lifeline will not sign for this agent: ${allowed.reason}`);
      }

      const screened = await this.screenAndSign(resolvedAgentKey, x402Version, batchingOption, url, agentContext);
      if ("blocked" in screened) {
        return this.blocked(screened.blocked, {
          paymentId, agentContext, humanOwner, url, method, body: options?.body, sellerAddress,
          requestedAmountFormatted, formattedAvailable, fundingSource: "AGENT_GATEWAY",
        });
      }
      const { payload: paymentPayload, verdict } = screened;

      const paymentHeader = Buffer.from(
        JSON.stringify({
          ...paymentPayload,
          resource: paymentRequired.resource,
          accepted: batchingOption,
        })
      ).toString("base64");

      const paidResponse = await fetch(url, {
      redirect: "manual",
        method,
        headers: {
          ...headers,
          "Payment-Signature": paymentHeader,
        },
        body: serializedBody,
      });

      if (!paidResponse.ok) {
        noteSellerFailure(sellerAddress, paidResponse.status);
        const errJson = await paidResponse.json().catch(() => ({}));
        throw new Error(
          `Payment failed: ${(errJson.error || paidResponse.statusText) + (errJson.reason ? ` - ${errJson.reason}` : "")}`
        );
      }

      const settleHeader = paidResponse.headers.get("PAYMENT-RESPONSE");
      let settleResponse: any;
      if (settleHeader) {
        settleResponse = JSON.parse(
          Buffer.from(settleHeader, "base64").toString("utf-8")
        );
      }

      const data = await readBody(paidResponse);
      noteSellerDelivery(sellerAddress, url, data);
      const x402 = this.trace({
        method, url, paymentRequired, requirements: batchingOption, payload: paymentPayload,
        signerRole: "agent", borrowedUsd: 0, status: paidResponse.status, settleResponse,
        contentType: paidResponse.headers.get("content-type"),
      });

      // Record normal payment record in Lifeline audit ledger
      recordPayment({
        paymentId,
        agentAddress: agentContext.agentAddress,
        humanProfileId: humanOwner,
        sellerAddress,
        resourceUrl: url,
        requestedAmount: requestedAmountFormatted,
        agentGatewayBalance: formattedAvailable,
        shortfall: "0.00",
        fundingSource: "AGENT_GATEWAY",
        drawdownId: null,
        status: "SUCCESS",
        timestamp: Date.now(),
        transactionId: settleResponse?.transaction,
        memo: "Normal x402 payment using agent Gateway balance",
        screening: { decision: verdict.decision, reasons: verdict.reasons, capUsd: verdict.capUsd },
      });

      return {
        success: true,
        screening: verdict,
        x402,
        fundingSource: "AGENT_GATEWAY",
        amount: requestedAmountFormatted,
        borrowed: "0.00",
        drawdownId: null,
        agentGatewayBalance: formattedAvailable,
        shortfall: "0.00",
        data,
        status: paidResponse.status,
        transactionId: settleResponse?.transaction,
        payer: agentContext.agentAddress,
        creditFacilityAddress: this.creditFacilityAddress,
      };
    } else {
      // ----------------------------------------------------
      // PATH B: OVERDRAFT DRAWDOWN (Lifeline Credit Facility)
      // ----------------------------------------------------
      // An x402 payment has one payer. When the agent cannot cover all of it,
      // Lifeline's Gateway pays the seller the whole price - so the whole
      // price is what is lent. Booking only the shortfall left Lifeline out
      // of pocket by whatever the agent happened to hold.
      // One ledger change at a time for this human: the limit check and the
      // booking below must see, and leave, a ledger nobody else is changing.
      const releaseLedger = await acquireLedgerLock(humanOwner);
      try {
        const shortfallAmount = parseFloat(requestedAmountFormatted);

        // 1. Check Lifeline Credit Facility Limits
        const facility = getHumanFacilityStats(humanOwner);
        // Read again inside the lock: the copy from before the balance check
        // and screening can be seconds old.
        const current = getAgentByAddress(agentContext.agentAddress);
        const agentAvailableLimit = current
          ? Math.max(0, current.creditLimit - current.outstandingDebt)
          : facility.totalAvailableCredit;
        // A line with debt past due borrows nothing until it is paid.
        const lineBlocked = borrowingBlocked(humanOwner, "arc");
        if (lineBlocked) {
          recordPayment({
            paymentId,
            agentAddress: agentContext.agentAddress,
            humanProfileId: humanOwner,
            sellerAddress,
            resourceUrl: url,
            requestedAmount: requestedAmountFormatted,
            agentGatewayBalance: formattedAvailable,
            shortfall: shortfallAmount.toFixed(2),
            fundingSource: "LIFELINE_FACILITY",
            drawdownId: null,
            status: "REJECTED_CREDIT",
            timestamp: Date.now(),
            memo: lineBlocked,
          });
          throw new Error(`Lifeline: ${lineBlocked}`);
        }
        // Whatever this human's own line allows, Lifeline's limits come first.
        const refused = creditRefusal({ human: humanOwner, amountUsd: shortfallAmount, seller: sellerAddress });
        if (refused) {
          recordPayment({
            paymentId,
            agentAddress: agentContext.agentAddress,
            humanProfileId: humanOwner,
            sellerAddress,
            resourceUrl: url,
            requestedAmount: requestedAmountFormatted,
            agentGatewayBalance: formattedAvailable,
            shortfall: shortfallAmount.toFixed(2),
            fundingSource: "LIFELINE_FACILITY",
            drawdownId: null,
            status: "REJECTED_CREDIT",
            timestamp: Date.now(),
            memo: refused,
          });
          throw new Error(`Lifeline: ${refused}`);
        }
        // A suspended or delinquent agent borrows nothing, here as on /api/borrow.
        const standing = current?.status === "Suspended" || current?.status === "Delinquent" ? 0 : Number.POSITIVE_INFINITY;
        // What nobody can approve past: the human's line, a mandate's cap, the agent's standing.
        const hardAvailable = Math.min(
          facility.totalAvailableCredit,
          agentContext.maxCreditUsd ?? Number.POSITIVE_INFINITY,
          standing
        );
        const needed = shortfallAmount * (1 + ORIGINATION_FEE_RATE);

        // Past the agent's own spending cap, but within the line: the human's
        // call. Held for a World ID approval - unless this is that approval,
        // for this payee and no more than this price.
        if (
          needed <= hardAvailable + 1e-9 &&
          needed > agentAvailableLimit + 1e-9 &&
          !approvalCovers(agentContext.approvedFor, sellerAddress, shortfallAmount)
        ) {
          return this.blocked(capHoldVerdict(needed, agentAvailableLimit, shortfallAmount), {
            paymentId, agentContext, humanOwner, url, method, body: options?.body, sellerAddress,
            requestedAmountFormatted, formattedAvailable, fundingSource: "LIFELINE_FACILITY",
          });
        }
        const effectiveAvailable = approvalCovers(agentContext.approvedFor, sellerAddress, shortfallAmount)
          ? hardAvailable
          : Math.min(agentAvailableLimit, hardAvailable);

        // The loan is booked with its origination fee, so that is what must fit.
        if (needed > effectiveAvailable + 1e-9) {
          recordPayment({
            paymentId,
            agentAddress: agentContext.agentAddress,
            humanProfileId: humanOwner,
            sellerAddress,
            resourceUrl: url,
            requestedAmount: requestedAmountFormatted,
            agentGatewayBalance: formattedAvailable,
            shortfall: shortfallAmount.toFixed(2),
            fundingSource: "LIFELINE_FACILITY",
            drawdownId: null,
            status: "REJECTED_CREDIT",
            timestamp: Date.now(),
            memo: `Credit rejected: Shortfall of $${shortfallAmount.toFixed(
              2
            )} exceeds headroom $${effectiveAvailable.toFixed(2)}`,
          });

          throw new Error(
            `Lifeline: shortfall of $${shortfallAmount.toFixed(
              2
            )} USDC exceeds remaining credit limit ($${effectiveAvailable.toFixed(
              2
            )} USDC available).`
          );
        }

        // 3. Sign x402 Payment Authorization using Lifeline's Gateway-Funded Facility
        // Screened before Lifeline's own wallet signs anything for the agent.
        const screened = await this.screenAndSign(this.fundingPrivateKey, x402Version, batchingOption, url, agentContext);
        if ("blocked" in screened) {
          return this.blocked(screened.blocked, {
            paymentId, agentContext, humanOwner, url, method, body: options?.body, sellerAddress,
            requestedAmountFormatted, formattedAvailable, fundingSource: "LIFELINE_FACILITY",
          });
        }
        const { payload: fundingPaymentPayload, verdict } = screened;

        const paymentHeader = Buffer.from(
          JSON.stringify({
            ...fundingPaymentPayload,
            resource: paymentRequired.resource,
            accepted: batchingOption,
          })
        ).toString("base64");

        // 4. Retry request with Lifeline's Payment-Signature
        const paidResponse = await fetch(url, {
      redirect: "manual",
          method,
          headers: {
            ...headers,
            "Payment-Signature": paymentHeader,
          },
          body: serializedBody,
        });

        if (!paidResponse.ok) {
          noteSellerFailure(sellerAddress, paidResponse.status);
          const errJson = await paidResponse.json().catch(() => ({}));
          recordPayment({
            paymentId,
            agentAddress: agentContext.agentAddress,
            humanProfileId: humanOwner,
            sellerAddress,
            resourceUrl: url,
            requestedAmount: requestedAmountFormatted,
            agentGatewayBalance: formattedAvailable,
            shortfall: shortfallAmount.toFixed(2),
            fundingSource: "LIFELINE_FACILITY",
            drawdownId: null,
            status: "FAILED",
            timestamp: Date.now(),
            memo: `Seller verification failed: ${(errJson.error || paidResponse.statusText) + (errJson.reason ? ` - ${errJson.reason}` : "")}`,
          });

          throw new Error(
            `Lifeline-funded payment failed: ${
              (errJson.error || paidResponse.statusText) + (errJson.reason ? ` - ${errJson.reason}` : "")
            }`
          );
        }

        // 2. Book the debt - only now the seller has taken the payment. Booked
        // before paying, a seller that refused left the human owing for
        // something they never received. It reaches the chain with the next
        // batch.
        //
        // Writing a drawdown per nanopayment cost more gas than the payment was
        // worth. The debt is recorded here first and settled on chain as one row
        // covering however many payments have accumulated.
        //
        // Admission control above reads the agent store, which is updated the
        // moment a payment is booked - so it already accounts for debt that has
        // not reached the chain yet. Adding the pending total on top would
        // double-count it, and the contract's own limit check cannot fail at
        // flush time for the same reason: chain debt plus the batch can never
        // exceed what the store already admitted.
        const loan = createLoan({
          agentAddress: agentContext.agentAddress,
          agentName: agent?.name || "Autonomous Agent",
          humanOwner,
          amount: shortfallAmount,
          txHash: "",
          memo: `Lifeline Overdraft x402 Drawdown for ${url}`,
        });

        addPending({
          humanOwner,
          agentAddress: agentContext.agentAddress,
          amountUsdc: shortfallAmount,
          reference: "x402",
          loanId: loan.loanId,
        });

        // Settles only once the position is worth the gas, or has waited long
        // enough. Most calls return here without touching the chain at all.
        const flush = await flushAgent(humanOwner, agentContext.agentAddress);
        const arcTxHash = flush.txHash ?? "";

        // The agent owes what the loan says: principal and its 1% fee, the same
        // as a direct draw. Adding the principal alone left the fee off the
        // debt the dashboard showed, and the first repayment quietly paid it.
        // Recomputed from the loans rather than added to a figure read earlier.
        syncAgentDebts(humanOwner);
        const booked = getAgentByAddress(agentContext.agentAddress);
        if (booked) {
          updateAgentInStore(booked.address, {
            totalBorrowed: Math.round((booked.totalBorrowed + shortfallAmount) * 10000) / 10000,
            status: "Active",
          });
        }

        const settleHeader = paidResponse.headers.get("PAYMENT-RESPONSE");
        let settleResponse: any;
        if (settleHeader) {
          settleResponse = JSON.parse(
            Buffer.from(settleHeader, "base64").toString("utf-8")
          );
        }

        const data = await readBody(paidResponse);
        noteSellerDelivery(sellerAddress, url, data);
        const x402 = this.trace({
          method, url, paymentRequired, requirements: batchingOption, payload: fundingPaymentPayload,
          signerRole: "lifeline", borrowedUsd: shortfallAmount, status: paidResponse.status, settleResponse,
          contentType: paidResponse.headers.get("content-type"),
        });

        // 5. Record successful payment in audit trail
        recordPayment({
          paymentId,
          agentAddress: agentContext.agentAddress,
          humanProfileId: humanOwner,
          sellerAddress,
          resourceUrl: url,
          requestedAmount: requestedAmountFormatted,
          agentGatewayBalance: formattedAvailable,
          shortfall: shortfallAmount.toFixed(2),
          fundingSource: "LIFELINE_FACILITY",
          drawdownId: loan.loanId,
          status: "SUCCESS",
          timestamp: Date.now(),
          transactionId: settleResponse?.transaction,
          memo: `Overdraft funded via the Lifeline facility ($${shortfallAmount.toFixed(
            2
          )} shortfall)`,
          screening: { decision: verdict.decision, reasons: verdict.reasons, capUsd: verdict.capUsd },
        });

        const updatedFacility = getHumanFacilityStats(humanOwner);
        const updatedAgent = getAgentByAddress(agentContext.agentAddress);

        return {
          success: true,
          screening: verdict,
          x402,
          fundingSource: "LIFELINE_FACILITY",
          amount: requestedAmountFormatted,
          borrowed: shortfallAmount.toFixed(2),
          drawdownId: loan.loanId,
          agentGatewayBalance: formattedAvailable,
          shortfall: shortfallAmount.toFixed(2),
          data,
          status: paidResponse.status,
          transactionId: arcTxHash || settleResponse?.transaction,
          arcTxHash: arcTxHash || undefined,
          arcTxLink: arcTxHash ? arcTxUrl(arcTxHash) : undefined,
          circleSettlementId: settleResponse?.transaction,
          payer: this.fundingClient.address,
          creditFacilityAddress: this.creditFacilityAddress,
          agentDebt: updatedAgent?.outstandingDebt || shortfallAmount,
          facilityDebt: updatedFacility.totalOutstandingDebt,
        };
      } finally {
        releaseLedger();
      }
    }
  }

  /** The step-by-step account of an Arc x402 purchase, for people to read. */
  private trace(p: {
    method: string;
    url: string;
    paymentRequired: any;
    requirements: any;
    payload: any;
    signerRole: "agent" | "lifeline";
    borrowedUsd: number;
    status: number;
    settleResponse: any;
    contentType: string | null;
  }): X402Trace {
    const auth = p.payload?.payload?.authorization ?? {};
    const usd = Number(formatUnits(BigInt(p.requirements.amount), 6));
    return {
      rail: "arc",
      request: { method: p.method, url: p.url },
      challenge: { status: 402, x402Version: p.paymentRequired.x402Version ?? 2, description: p.paymentRequired.resource?.description },
      quote: {
        scheme: p.requirements.scheme,
        network: p.requirements.network,
        mechanism: `${p.requirements.extra?.name ?? "exact"} (Circle Gateway)`,
        asset: p.requirements.asset,
        assetLabel: String(p.requirements.asset).toLowerCase() === "0x3600000000000000000000000000000000000000" ? "USDC (Arc native)" : "unrecognised token",
        amount: String(p.requirements.amount),
        amountUsd: usd,
        payTo: p.requirements.payTo,
        maxTimeoutSeconds: p.requirements.maxTimeoutSeconds,
      },
      payment: {
        signer: String(auth.from ?? ""),
        signerRole: p.signerRole,
        summary:
          p.signerRole === "agent"
            ? "The agent signed an EIP-3009 transfer authorisation from its own Circle Gateway balance to the seller. Nothing moves on chain yet: Gateway batches it."
            : `The agent was short, so Lifeline signed the authorisation from its own Gateway balance and lent the agent $${p.borrowedUsd.toFixed(2)}. Nothing moves on chain yet: Gateway batches it.`,
        authorization: {
          from: String(auth.from ?? ""),
          to: String(auth.to ?? ""),
          value: String(auth.value ?? ""),
          validBefore: auth.validBefore ? new Date(Number(auth.validBefore) * 1000).toISOString() : "",
          nonce: String(auth.nonce ?? ""),
        },
        borrowedUsd: p.borrowedUsd,
      },
      settlement: { status: p.status, receipt: p.settleResponse ?? null },
      response: { contentType: p.contentType },
    };
  }

  /**
   * Build the Gateway authorisation, have Intercepta read it along with the
   * payee and the asset, and sign it only if the verdict allows.
   */
  private async screenAndSign(
    privateKey: `0x${string}`,
    x402Version: number,
    requirements: any,
    url: string,
    ctx: AgentPaymentContext
  ): Promise<{ payload: any; verdict: Verdict & { approvedByHuman?: boolean } } | { blocked: Verdict }> {
    const account = privateKeyToAccount(privateKey);
    const verifyingContract = requirements.extra?.verifyingContract;
    if (!verifyingContract) throw new Error("Gateway quote is missing extra.verifyingContract");

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account.address,
      to: getAddress(requirements.payTo),
      value: String(requirements.amount),
      validAfter: String(now - 600),
      validBefore: String(now + Math.max(Number(requirements.maxTimeoutSeconds) || 0, GATEWAY_AUTH_VALIDITY_SECONDS)),
      nonce: `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`,
    };
    const domain = {
      name: requirements.extra?.name ?? "GatewayWalletBatched",
      version: requirements.extra?.version ?? "1",
      chainId: Number(String(requirements.network).split(":")[1]),
      verifyingContract: getAddress(verifyingContract),
    };

    const screened = await screenOutgoing({
      from: account.address,
      payTo: requirements.payTo,
      asset: requirements.asset,
      amountUsd: Number(formatUnits(BigInt(requirements.amount), 6)),
      typedData: {
        types: { EIP712Domain: EIP712_DOMAIN, ...AUTH_TYPES },
        domain,
        primaryType: "TransferWithAuthorization",
        message: authorization,
      },
      website: new URL(url).origin,
    });
    const verdict = screened;

    const quotedUsd = Number(formatUnits(BigInt(requirements.amount), 6));
    const matchesApproval =
      !ctx.approvedFor ||
      (ctx.approvedFor.payTo.toLowerCase() === String(requirements.payTo).toLowerCase() &&
        quotedUsd <= ctx.approvedFor.amountUsd + 1e-9);
    const approvedByHuman = verdict.decision === "hold" && ctx.humanApproved === true && matchesApproval;
    if (verdict.decision === "refuse" || (verdict.decision === "hold" && !approvedByHuman)) {
      return { blocked: verdict };
    }

    const signature = await account.signTypedData({
      domain,
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
      },
    });
    return {
      payload: { x402Version, payload: { authorization, signature } },
      verdict: approvedByHuman ? { ...verdict, approvedByHuman } : verdict,
    };
  }

  /** Nothing was signed. Say why, and if a human can decide, ask them. */
  private blocked(
    verdict: Verdict,
    p: {
      paymentId: string;
      agentContext: AgentPaymentContext;
      humanOwner: string;
      url: string;
      method: "GET" | "POST";
      body?: unknown;
      sellerAddress: string;
      requestedAmountFormatted: string;
      formattedAvailable: string;
      fundingSource: "AGENT_GATEWAY" | "LIFELINE_FACILITY";
    }
  ): LifelinePayResult {
    const hold =
      verdict.decision === "hold"
        ? createHold({
            human: p.humanOwner,
            agentAddress: p.agentContext.agentAddress,
            url: p.url,
            method: p.method,
            body: p.body,
            payTo: p.sellerAddress,
            amountUsd: verdict.amountUsd,
            verdict,
          })
        : null;

    recordPayment({
      paymentId: p.paymentId,
      agentAddress: p.agentContext.agentAddress,
      humanProfileId: p.humanOwner,
      sellerAddress: p.sellerAddress,
      resourceUrl: p.url,
      requestedAmount: p.requestedAmountFormatted,
      agentGatewayBalance: p.formattedAvailable,
      shortfall: "0.00",
      fundingSource: p.fundingSource,
      drawdownId: null,
      status: hold ? "HELD" : "REFUSED_RISK",
      timestamp: Date.now(),
      memo: verdictLine(verdict),
      screening: { decision: verdict.decision, reasons: verdict.reasons, capUsd: verdict.capUsd, holdId: hold?.holdId },
    });

    return {
      success: false,
      screening: verdict,
      hold: hold ? { holdId: hold.holdId, expiresAt: hold.expiresAt } : undefined,
      fundingSource: p.fundingSource,
      amount: p.requestedAmountFormatted,
      borrowed: "0.00",
      drawdownId: null,
      agentGatewayBalance: p.formattedAvailable,
      shortfall: "0.00",
      data: null,
      status: hold ? 202 : 403,
      payer: p.agentContext.agentAddress,
    };
  }
}

/**
 * A server error is the seller failing to deliver. A 4xx is not counted: it can
 * mean Lifeline's own request or signature was refused, which says nothing about
 * the seller. The record must never get in the way of the purchase.
 */
function noteSellerFailure(seller: string, status: number) {
  if (status < 500) return;
  try {
    recordSellerOutcome(seller, "failed");
  } catch {}
}

/** Delivered, and in the format the seller's marketplace listing promised? */
function noteSellerDelivery(seller: string, url: string, data: unknown) {
  try {
    recordSellerOutcome(seller, matchesSchema(listingFor(url)?.output, data) ? "delivered" : "malformed");
  } catch {}
}

/**
 * What a seller sent back, whatever it is. Paid for and booked by the time it
 * is read, so a body that is not JSON must not throw - the purchase happened.
 */
async function readBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return { contentType: res.headers.get("content-type") ?? "unknown", text: text.slice(0, 20_000) };
  }
}
