import { NextRequest, NextResponse } from "next/server";
import { isWcItem, WC_ITEMS } from "@/lib/whitechain/catalogue";
import { requireUsdtPayment } from "@/lib/whitechain/seller";
import { wcTx } from "@/lib/whitechain/config";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** A merchant's pay-per-request API: 402 until USDT settles on Whitechain. */
export async function GET(req: NextRequest, { params }: { params: { item: string } }) {
  if (!isWcItem(params.item)) return NextResponse.json({ error: "Nothing here." }, { status: 404 });
  const item = WC_ITEMS[params.item];
  const gate = await requireUsdtPayment(req.headers.get("x-payment"), item.priceUsd, `/api/whitechain/paid/${params.item}`, item.title);
  if (!gate.paid) return NextResponse.json(gate.body, { status: gate.status });

  return NextResponse.json(
    {
      title: item.title,
      data:
        params.item === "signal"
          ? { signal: "USDT-DEMAND-UP", confidence: 0.81, at: Date.now() }
          : { merchantsChecked: 42, refundRate: 0.013, chargebackRisk: "low", at: Date.now() },
      payment: { amount: `${item.priceUsd} USDT`, payer: gate.receipt.payer, transaction: gate.receipt.txHash, explorer: wcTx(gate.receipt.txHash) },
    },
    { headers: { "X-PAYMENT-RESPONSE": gate.responseHeader } }
  );
}
