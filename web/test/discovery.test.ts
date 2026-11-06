import { test } from "node:test";
import assert from "node:assert/strict";
import { useSandbox } from "./sandbox";
import { discoverServices, listingFor, rankServices, toService, useDiscoveryFetcher, ARC_NETWORK } from "../src/lib/discovery";
import { matchesSchema, recordSellerOutcome, sellerIsPoor, sellerScore } from "../src/lib/sellerQuality";

/** The marketplace, narrowed to what Lifeline can pay, and the record of who delivers. */

useSandbox();

const arcAccept = (payTo: string, amount = "10000") => ({
  scheme: "exact",
  network: ARC_NETWORK,
  asset: "0x3600000000000000000000000000000000000000",
  payTo,
  amount,
  extra: { name: "GatewayWalletBatched", version: "1" },
});
const listing = (resource: string, payTo: string, opts: { amount?: string; siwx?: boolean; accepts?: any[] } = {}) => ({
  resource,
  accepts: opts.accepts ?? [arcAccept(payTo, opts.amount)],
  metadata: {
    method: "post",
    description: `Sells ${resource}`,
    siwx: opts.siwx ?? false,
    provider: { name: "Seller", category: "WEB_SEARCH_RESEARCH" },
    output: { type: "object", required: ["answer"] },
  },
});

test("a listing only counts if Lifeline can pay it through Gateway on Arc", () => {
  const onBase = { ...arcAccept("0xa"), network: "eip155:8453" };
  const direct = { ...arcAccept("0xb"), extra: { name: "USD Coin", version: "2" } };
  assert.equal(toService(listing("https://x.test/a", "0xa", { accepts: [onBase] })), null);
  assert.equal(toService(listing("https://x.test/b", "0xb", { accepts: [direct] })), null);

  const ok = toService(listing("https://x.test/c", "0xc", { amount: "8000" }));
  assert.equal(ok?.priceUsd, 0.008);
  assert.equal(ok?.method, "POST");
  assert.equal(ok?.provider, "Seller");
});

test("a listing that names a price it cannot state is dropped", () => {
  assert.equal(toService(listing("https://x.test/d", "0xd", { amount: "free" })), null);
});

test("discovery asks only for Arc, caches, and remembers listings", async () => {
  const urls: string[] = [];
  useDiscoveryFetcher(async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ items: [listing("https://x.test/e", "0xe")], pagination: { total: 1 } }) };
  });
  const a = await discoverServices({ query: "search", maxUsd: 0.05 }, 1000);
  const b = await discoverServices({ query: "search", maxUsd: 0.05 }, 2000);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /network=eip155%3A5042002/);
  assert.match(urls[0], /supportsCircleGateway=true/);
  assert.match(urls[0], /maxUsdPrice=0.05/);
  assert.equal(a.services.length, 1);
  assert.equal(b.services.length, 1);
  assert.equal(listingFor("https://x.test/e")?.payTo, "0xe");

  await discoverServices({ query: "search", maxUsd: 0.05 }, 1000 + 61_000);
  assert.equal(urls.length, 2);
});

test("a marketplace error is an error, not an empty list", async () => {
  useDiscoveryFetcher(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  await assert.rejects(discoverServices({ query: "down" }), /503/);
});

test("ranking puts poor sellers last and sign-in sellers after plain ones", () => {
  const base = { method: "GET", description: "", provider: "", category: null, input: null, output: null };
  const s = (url: string, priceUsd: number, score: number, poor: boolean, needsSignIn: boolean) => ({
    ...base,
    url,
    payTo: url,
    priceUsd,
    needsSignIn,
    quality: { score, samples: 10, poor },
  });
  const ranked = rankServices([
    s("poor", 0.001, 0.1, true, false),
    s("signin", 0.001, 0.9, false, true),
    s("pricey", 0.05, 0.9, false, false),
    s("cheap", 0.001, 0.9, false, false),
  ]);
  assert.deepEqual(ranked.map((r) => r.url), ["cheap", "pricey", "signin", "poor"]);
});

test("one bad purchase does not condemn a seller, a pattern does", () => {
  const seller = "0xABC";
  recordSellerOutcome(seller, "failed");
  assert.equal(sellerIsPoor(seller), false);
  for (let i = 0; i < 4; i++) recordSellerOutcome(seller, "malformed");
  assert.equal(sellerIsPoor(seller), true);
  assert.equal(sellerIsPoor("0xabc"), true, "addresses compare without case");
  assert.equal(sellerScore(seller).samples, 5);
});

test("a seller that delivers keeps a good record", () => {
  const seller = "0xGOOD";
  for (let i = 0; i < 10; i++) recordSellerOutcome(seller, "delivered");
  recordSellerOutcome(seller, "failed");
  assert.equal(sellerIsPoor(seller), false);
  assert.ok(sellerScore(seller).score > 0.8);
});

test("responses are checked against the format the seller published", () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
  };
  assert.equal(matchesSchema(schema, { answer: "yes", sources: ["a"] }), true);
  assert.equal(matchesSchema(schema, { sources: [] }), false, "missing a required key");
  assert.equal(matchesSchema(schema, { answer: 1 }), false, "wrong type");
  assert.equal(matchesSchema(schema, { answer: "y", sources: [1] }), false, "wrong item type");
  assert.equal(matchesSchema(schema, "not an object"), false);
});

test("a schema the check cannot read counts as a match", () => {
  assert.equal(matchesSchema(null, { a: 1 }), true);
  assert.equal(matchesSchema({ oneOf: [{ type: "string" }] }, 5), true);
  assert.equal(matchesSchema({ type: "made-up" }, 5), true);
});
