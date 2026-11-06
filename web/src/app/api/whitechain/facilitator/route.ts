import { NextRequest, NextResponse } from "next/server";
import { WC_NETWORK, WC_USDT } from "@/lib/whitechain/config";
import { settlePayment, verifyPayment, type PaymentPayload, type PaymentRequirements } from "@/lib/whitechain/facilitator";
import { allow, clientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** What this facilitator settles: x402's /supported. */
export async function GET() {
  return NextResponse.json({ kinds: [{ x402Version: 1, scheme: "exact", network: WC_NETWORK, asset: WC_USDT }] });
}

/**
 * x402's /verify and /settle, for any registered merchant. Open to the internet, so it
 * limits callers, and the relayer's own rules decide whether a payment earns any gas.
 */
export async function POST(req: NextRequest) {
  if (!allow(`wc-facilitator:${clientIp(req)}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const { action, paymentPayload, paymentRequirements } = (await req.json().catch(() => ({}))) as {
    action?: string;
    paymentPayload?: PaymentPayload;
    paymentRequirements?: PaymentRequirements;
  };
  if (!paymentPayload || !paymentRequirements) {
    return NextResponse.json({ error: "paymentPayload and paymentRequirements are required." }, { status: 400 });
  }
  if (action === "verify") return NextResponse.json(await verifyPayment(paymentPayload, paymentRequirements));
  if (action === "settle") return NextResponse.json(await settlePayment(paymentPayload, paymentRequirements));
  return NextResponse.json({ error: "action must be verify or settle." }, { status: 400 });
}
