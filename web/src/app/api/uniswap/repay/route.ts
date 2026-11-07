import { NextRequest, NextResponse } from "next/server";
import { formatUnits, isAddress } from "viem";
import { getHuman, unauthenticated } from "@/lib/session";
import { ARC_BRIDGE_CHAIN } from "@/lib/arc";
import { approvalNeeded, buildSwap, formatToken, quoteForUsdc, swapChain, uniswapConfigured } from "@/lib/uniswapApi";
import { swapCostOf, usdcToBuy } from "@/lib/swapOrBorrow";

export const dynamic = "force-dynamic";

/** What can be repaid with, and where. The wallet does the rest, so the key stays here. */
export async function GET(req: NextRequest) {
  if (!getHuman(req)) return unauthenticated();
  const c = swapChain();
  return NextResponse.json({
    configured: uniswapConfigured(),
    tokens: Object.keys(c.tokens),
    chainId: c.chain.id,
    chainName: c.chain.name,
    usdc: c.usdc,
    bridgeFrom: c.bridgeChain,
    bridgeTo: ARC_BRIDGE_CHAIN,
    rpc: c.rpc,
  });
}

/**
 * The Uniswap API's steps for a wallet in the browser. Nothing here moves money: it says
 * what to sign. Lifeline books the repayment only when USDC reaches its treasury on Arc.
 */
export async function POST(req: NextRequest) {
  if (!getHuman(req)) return unauthenticated();
  const body = await req.json().catch(() => ({} as any));
  try {
    if (body.action === "quote") {
      const amountUsd = Number(body.amountUsd);
      if (!(amountUsd > 0) || !isAddress(body.wallet ?? "") || typeof body.token !== "string") {
        return NextResponse.json({ success: false, error: "token, a positive amountUsd and a wallet are required." }, { status: 400 });
      }
      const quote = await quoteForUsdc(body.token, usdcToBuy(amountUsd), body.wallet);
      const cost = await swapCostOf(quote, amountUsd, body.wallet);
      return NextResponse.json({
        success: true,
        token: body.token,
        amountIn: formatToken(quote.amountIn, quote.decimals),
        buysUsd: Number(formatUnits(usdcToBuy(amountUsd), 6)),
        costUsd: cost.totalUsd,
        approval: await approvalNeeded(body.token, quote.maxAmountIn, body.wallet),
        quote: quote.raw.quote,
        permitData: quote.raw.permitData ?? null,
      });
    }
    if (body.action === "swap") {
      if (!body.quote) return NextResponse.json({ success: false, error: "quote is required." }, { status: 400 });
      return NextResponse.json({ success: true, tx: await buildSwap({ quote: body.quote, permitData: body.permitData }, body.signature) });
    }
    return NextResponse.json({ success: false, error: "action must be quote or swap." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? "Uniswap could not do that." }, { status: 502 });
  }
}
