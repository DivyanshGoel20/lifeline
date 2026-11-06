import express from "express";
import { createGatewayMiddleware, BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { riskCurveSvg, dossierSvg } from "./artifacts";
import { screenIncoming, verdictLine, DEMO_RISKY_PAYTO, DEMO_FAKE_USDC } from "../web/src/lib/intercepta";

type PaidRequest = express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

const app = express();

// Who this seller is paid. No fallback: the old one was the address of private
// key 0x…01, which anyone can sign for.
const SELLER_WALLET =
  process.env.SELLER_WALLET_ADDRESS ||
  (process.env.SELLER_PRIVATE_KEY ? privateKeyToAccount(process.env.SELLER_PRIVATE_KEY as `0x${string}`).address : "");
if (!SELLER_WALLET) {
  console.error("No seller wallet: set SELLER_WALLET_ADDRESS (or SELLER_PRIVATE_KEY) in the root .env");
  process.exit(1);
}
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://gateway-api-testnet.circle.com";
// Its own variable, not PORT: the Next app already owns 3000, and a shared
// PORT in .env silently pointed both at the same socket.
const PORT = process.env.PREMIUM_API_PORT || process.env.PORT || 4402;

/**
 * Every payer is screened with Intercepta before Circle is asked to verify the
 * payment, let alone settle it. A wallet with sanctions, stolen-funds or scam
 * exposure is turned away with the reason; the abort becomes a 402.
 */
const screenPayer = async ({ paymentPayload, requirements }: any) => {
  const payer = paymentPayload?.payload?.authorization?.from;
  if (!payer) return { abort: true as const, reason: "Payment names no payer" };
  const usd = Number(formatUnits(BigInt(requirements.amount), 6));
  const verdict = await screenIncoming(payer, usd);
  console.log(`[intercepta] payer ${payer} -> ${verdict.decision}: ${verdict.reasons[0] ?? ""}`);
  if (verdict.decision === "refuse") return { abort: true as const, reason: verdictLine(verdict) };
};

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_WALLET,
  facilitatorUrl: FACILITATOR_URL,
}).onBeforeVerify(screenPayer);

// A seller whose quote names a payee with a mainnet record. Buyers that screen
// what they pay refuse it before signing; it is here so that can be seen.
const unvetted = createGatewayMiddleware({
  sellerAddress: DEMO_RISKY_PAYTO,
  facilitatorUrl: FACILITATOR_URL,
}).onBeforeVerify(screenPayer);

app.get("/", (_req, res) => {
  res.json({
    service: "Lifeline Premium API",
    rail: "arc",
    settlement: "x402 via Circle Gateway",
    paid: ["/premium-data", "/risk-curve", "/dossier", "/unvetted", "/lookalike"],
  });
});

app.get(
  "/premium-data",
  gateway.require("$0.01"),
  (req: PaidRequest, res) => {
    const { payer, amount, network } = req.payment!;

    // A small, self-describing result: what was bought is as plain as how.
    const now = new Date();
    res.json({
      success: true,
      title: "Alpha signal",
      artifact: "json",
      message: "Premium data unlocked.",
      data: {
        signal: "DEMO-ALPHA-001",
        market: "ETH / USDC",
        direction: "long",
        confidence: "0.74",
        horizon: "4h",
        entry: 3284.5,
        stop: 3221.0,
        generatedAt: now.toISOString(),
        note: "Demo data - not financial advice.",
      },
      payment: {
        payer,
        amount: formatUnits(BigInt(amount), 6) + " USDC",
        network,
      },
    });
  }
);

/**
 * Tiers, so the expensive paths can be exercised.
 *
 * A cent-priced endpoint never tests what happens when a charge is a
 * meaningful fraction of a fifty cent credit line. These do: twenty cents draws
 * visibly against headroom, and forty-five cents twice over is refused, which
 * is the behaviour worth showing.
 *
 * Each returns an artefact rather than a payload, so the difference between
 * tiers is something you can see.
 */
app.get(
  "/risk-curve",
  gateway.require("$0.20"),
  (req: PaidRequest, res) => {
    const { payer, amount, network } = req.payment!;
    res.json({
      success: true,
      artifact: "svg",
      title: "Exposure curve · 30d",
      svg: riskCurveSvg(payer),
      payment: {
        payer,
        amount: formatUnits(BigInt(amount), 6) + " USDC",
        network,
      },
    });
  }
);

app.get(
  "/dossier",
  gateway.require("$0.45"),
  (req: PaidRequest, res) => {
    const { payer, amount, network } = req.payment!;
    res.json({
      success: true,
      artifact: "svg",
      title: "Underwriting dossier",
      svg: dossierSvg(payer),
      payment: {
        payer,
        amount: formatUnits(BigInt(amount), 6) + " USDC",
        network,
      },
    });
  }
);

app.get("/unvetted", unvetted.require("$0.01"), (_req: PaidRequest, res) => {
  res.json({ success: true, message: "This should not have been bought." });
});

/**
 * A seller that asks to be paid in a lookalike USDC. The payee is this clean
 * seller; the token in its quote is a fake "USD Coin" Intercepta rates
 * malicious. A buyer that checks what it pays in refuses before signing; a
 * payment that did arrive is refused here too, since Gateway settles only
 * real USDC.
 */
let gatewayKind: Promise<any> | null = null;
const arcKind = () =>
  (gatewayKind ??= new BatchFacilitatorClient({ url: FACILITATOR_URL })
    .getSupported()
    .then((s: any) => s.kinds.find((k: any) => k.network === "eip155:5042002" && k.extra?.verifyingContract))
    .catch((err) => {
      gatewayKind = null;
      throw err;
    }));

app.get("/lookalike", async (req, res) => {
  if (req.header("payment-signature")) {
    res.status(402).json({ error: "Payment refused", reason: "This seller's quote is not payable" });
    return;
  }
  const kind = await arcKind().catch(() => null);
  if (!kind) {
    res.status(503).json({ error: "No payment network available" });
    return;
  }
  const quote = {
    x402Version: 2,
    resource: { url: "/lookalike", description: 'Discount feed (pays in "USDC")', mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:5042002",
        asset: DEMO_FAKE_USDC,
        amount: "10000",
        payTo: SELLER_WALLET,
        maxTimeoutSeconds: 604_900,
        extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: kind.extra.verifyingContract },
      },
    ],
  };
  res.status(402).set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(quote)).toString("base64")).json({});
});

/** What is for sale, and at what price. Unmetered - the catalogue is free. */
app.get("/catalogue", (_req, res) => {
  res.json({
    resources: [
      { path: "/premium-data", price: 0.01, title: "Alpha signal", artifact: "json" },
      { path: "/risk-curve", price: 0.2, title: "Exposure curve \u00b7 30d", artifact: "svg" },
      { path: "/dossier", price: 0.45, title: "Underwriting dossier", artifact: "svg" },
      { path: "/unvetted", price: 0.01, title: "Unvetted feed", artifact: "json" },
      { path: "/lookalike", price: 0.01, title: 'Discount feed (pays in "USDC")', artifact: "json" },
    ],
  });
});

export default app;

if (!process.env.VERCEL) app.listen(PORT, () => {
  console.log(`Lifeline Premium API running on http://localhost:${PORT}`);
});
