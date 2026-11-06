/**
 * Lifeline Sui Feed - an x402-gated service settled on Sui.
 *
 * A credit-risk feed for autonomous agents, sold over x402 on Sui: records for
 * autonomous agents, priced by the record. Ask for one and the 402 quotes one;
 * ask for twenty and it quotes twenty.
 *
 * Settlement is x402's exact scheme on Sui. The buyer signs a transaction that
 * pays this seller and sends it unexecuted; the service simulates it, checks
 * the payment, submits it, and serves the records only once the chain agrees.
 * The seller holds no SUI - the buyer's side sponsors the gas.
 *
 *   npm run sui:service
 */
import express from "express";
import path from "node:path";
import { createSettler, encodeHeader, fromUnits, requireDeployment, suiDir, toUnits, x402Network } from "../src";
import type { SuiPaymentRequirements } from "../src";
import { riskFor, universe } from "./risk";

const PORT = Number(process.env.SUI_SERVICE_PORT || process.env.PORT || 4031);
const PRICE_PER_RECORD = 0.005;
const MAX_RECORDS = 400;

const deployment = requireDeployment();
const PAY_TO = process.env.SUI_SELLER_ADDRESS || deployment.operator;
// A function's own disk is read-only outside /tmp, and does not last.
const settler = createSettler({ ledgerFile: path.join(process.env.VERCEL ? "/tmp" : path.join(suiDir(), "data"), `settled-${deployment.network}.json`) });

function clampRecords(raw: unknown): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(String(first ?? "1"), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_RECORDS);
}

const money = (n: number) => `$${n.toFixed(3)}`;

function quote(records: number): SuiPaymentRequirements {
  return {
    scheme: "exact",
    network: x402Network(),
    asset: deployment.coinType,
    amount: toUnits(PRICE_PER_RECORD * records).toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    resource: `/risk?records=${records}`,
    description: "Credit-risk scores for autonomous agents, priced per record",
    extra: { decimals: 6, gas: "buyer-sponsored" },
  };
}

const app = express();

app.get("/", (_req, res) => {
  res.json({
    service: "Lifeline Sui Feed",
    rail: "sui",
    network: x402Network(),
    settlement: "x402 exact scheme, verified and submitted by the seller",
    asset: { coinType: deployment.coinType, decimals: 6 },
    payTo: PAY_TO,
    pricing: {
      model: "per-record",
      perRecord: money(PRICE_PER_RECORD),
      maxRecords: MAX_RECORDS,
      example: `GET /risk?records=5 costs ${money(PRICE_PER_RECORD * 5)}`,
    },
    endpoints: { free: ["/", "/catalogue", "/.well-known/agent"], paid: ["/risk?records=N"] },
  });
});

/** Free, so an agent can see what is for sale before paying for any of it. */
app.get("/catalogue", (_req, res) => {
  res.json({
    rail: "sui",
    network: x402Network(),
    resources: [1, 20, 200].map((n) => ({
      path: `/risk?records=${n}`,
      price: PRICE_PER_RECORD * n,
      title: `Agent risk feed · ${n} record${n === 1 ? "" : "s"}`,
      artifact: "json",
    })),
  });
});

app.get("/.well-known/agent", (_req, res) => {
  res.json({
    service: "Lifeline Sui Feed",
    version: "1.0.0",
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: x402Network(),
      asset: { coinType: deployment.coinType, decimals: 6 },
      payTo: PAY_TO,
      pricing: { model: "per-record", perRecordUsd: PRICE_PER_RECORD, maxRecords: MAX_RECORDS, formula: "records * perRecordUsd" },
      gas: "The buyer sponsors gas. The seller submits the signed transaction and holds no SUI.",
    },
    resources: [
      { path: "/risk", method: "GET", params: { records: `1-${MAX_RECORDS}` }, priced: "per-record" },
    ],
  });
});

app.get("/risk", async (req, res) => {
  const n = clampRecords(req.query.records);
  const requirements = quote(n);
  const header = req.header("payment-signature");

  if (!header) {
    res
      .status(402)
      .set("PAYMENT-REQUIRED", encodeHeader({ x402Version: 2, resource: { url: req.originalUrl }, accepts: [requirements] }))
      .json({ preview: `${n} record${n === 1 ? "" : "s"} available`, price: money(PRICE_PER_RECORD * n), network: requirements.network });
    return;
  }

  const verdict = await settler.verifyAndSettle(header, requirements);
  if (!verdict.ok) {
    res.status(verdict.status).json({ error: "Payment not accepted", reason: verdict.reason });
    return;
  }

  res
    .set(
      "PAYMENT-RESPONSE",
      encodeHeader({ success: true, transaction: verdict.digest, network: requirements.network, payer: verdict.payer })
    )
    .json({
      records: riskFor(n),
      meta: { records: n, pricePerRecord: money(PRICE_PER_RECORD), charged: `${fromUnits(verdict.paid).toFixed(6)}` },
      payment: { payer: verdict.payer, digest: verdict.digest, network: requirements.network },
    });
});

export default app;

if (!process.env.VERCEL) app.listen(PORT, () => {
  console.log(`Lifeline Sui Feed  http://localhost:${PORT}`);
  console.log(`  network  ${x402Network()}`);
  console.log(`  asset    ${deployment.coinType}`);
  console.log(`  payTo    ${PAY_TO}`);
  console.log(`  price    ${money(PRICE_PER_RECORD)} per record, up to ${MAX_RECORDS} (catalogue lists ${universe().length})`);
});
