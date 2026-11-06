import path from "path";
import { parseUnits } from "viem";
import fs from "../storeFs";
import { writeJsonAtomic } from "../atomicWrite";
import { WC_NETWORK, WC_USDT, WC_USDT_DECIMALS, WC_USDT_DOMAIN } from "./config";
import { settlePayment, type PaymentPayload, type PaymentRequirements } from "./facilitator";

/**
 * A merchant's side of x402 on Whitechain. A merchant quotes a price in USDT; the
 * payer retries with a signed authorisation in X-PAYMENT, which is settled through
 * Lifeline's facilitator before anything is delivered.
 */
export const merchantWallet = () => {
  const m = process.env.WHITECHAIN_MERCHANT_ADDRESS || process.env.SELLER_WALLET_ADDRESS;
  if (!m) throw new Error("No merchant wallet (WHITECHAIN_MERCHANT_ADDRESS).");
  return m;
};

export function requirementsFor(priceUsd: number, resource: string, description: string) {
  const requirements: PaymentRequirements & Record<string, unknown> = {
    scheme: "exact",
    network: WC_NETWORK,
    maxAmountRequired: parseUnits(priceUsd.toFixed(WC_USDT_DECIMALS), WC_USDT_DECIMALS).toString(),
    asset: WC_USDT,
    payTo: merchantWallet(),
    maxTimeoutSeconds: 300,
    resource,
    description,
    mimeType: "application/json",
    extra: { ...WC_USDT_DOMAIN },
  };
  return requirements;
}

export const quoteBody = (requirements: PaymentRequirements, error = "X-PAYMENT header is required") => ({
  x402Version: 1,
  error,
  accepts: [requirements],
});

export function encodePayment(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}
function decodePayment(header: string): PaymentPayload | null {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- receipts */

export type Receipt = { at: number; resource: string; description: string; amountUsd: number; payer: string; merchant: string; txHash: string };

function receiptFile(): string {
  const c = [path.resolve(process.cwd(), "web", "data", "whitechain-receipts.json"), path.resolve(process.cwd(), "data", "whitechain-receipts.json")];
  for (const f of c) if (fs.existsSync(f)) return f;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? c[0] : c[1];
}
export function merchantReceipts(): Receipt[] {
  try {
    return fs.existsSync(receiptFile()) ? JSON.parse(fs.readFileSync(receiptFile(), "utf8")) : [];
  } catch {
    return [];
  }
}

/**
 * The gate in front of something for sale. No payment answers 402 with the quote; a
 * payment that does not settle answers 402 with the reason. Goods only follow settlement.
 */
export async function requireUsdtPayment(
  paymentHeader: string | null,
  priceUsd: number,
  resource: string,
  description: string
): Promise<{ paid: false; status: 402; body: unknown } | { paid: true; receipt: Receipt; responseHeader: string }> {
  const requirements = requirementsFor(priceUsd, resource, description);
  if (!paymentHeader) return { paid: false, status: 402, body: quoteBody(requirements) };

  const payment = decodePayment(paymentHeader);
  if (!payment) return { paid: false, status: 402, body: quoteBody(requirements, "X-PAYMENT could not be read") };

  const settled = await settlePayment(payment, requirements);
  if (!settled.success || !settled.transaction) {
    return { paid: false, status: 402, body: quoteBody(requirements, settled.errorReason ?? "Settlement failed") };
  }

  const receipt: Receipt = {
    at: Date.now(),
    resource,
    description,
    amountUsd: priceUsd,
    payer: settled.payer ?? "",
    merchant: requirements.payTo,
    txHash: settled.transaction,
  };
  writeJsonAtomic(receiptFile(), [receipt, ...merchantReceipts()].slice(0, 500));
  const responseHeader = Buffer.from(JSON.stringify({ success: true, transaction: settled.transaction, network: WC_NETWORK, payer: settled.payer }), "utf8").toString("base64");
  return { paid: true, receipt, responseHeader };
}
