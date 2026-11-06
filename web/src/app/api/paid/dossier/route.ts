import { NextRequest, NextResponse } from "next/server";
import { dossierSvg } from "@/lib/artifacts";
import { requirePayment } from "@/lib/x402Gateway";

const PRICE_USD = 0.45;
const TITLE = "Underwriting dossier";

export async function GET(req: NextRequest) {
  const gate = await requirePayment(req, PRICE_USD, TITLE);
  if ("response" in gate) return gate.response;
  const { settled } = gate;

  return NextResponse.json(
    {
      success: true,
      artifact: "svg",
      title: TITLE,
      svg: dossierSvg(settled.payer),
      payment: {
        payer: settled.payer,
        amount: `${PRICE_USD.toFixed(2)} USDC`,
        network: settled.network,
        transaction: settled.transaction,
      },
    },
    { headers: { "PAYMENT-RESPONSE": settled.header } }
  );
}
