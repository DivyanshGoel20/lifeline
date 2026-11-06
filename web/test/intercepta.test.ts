import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useSandbox } from "./sandbox";
import { screenOutgoing, screenIncoming, clearCache, ARC_USDC } from "../src/lib/intercepta";
import { createHold, openHolds, resolveHold, getHold } from "../src/lib/holdStore";

/**
 * The policy that turns Intercepta's answers into pay, cap, hold or refuse.
 *
 * Intercepta itself is stood in for here, answer by answer, so each branch of
 * the policy can be pinned down. The live calls are exercised by
 * test/e2e/intercepta.e2e.ts against the real API.
 */

useSandbox();

const PAYEE = "0x" + "ab".repeat(20);
const AGENT = "0x" + "cd".repeat(20);
const TYPED = { primaryType: "TransferWithAuthorization", message: {} };

type Answers = { address?: object; message?: object; token?: object; status?: number };
let answers: Answers;
let calls: string[];

beforeEach(() => {
  process.env.INTERCEPTA_API_KEY = "test";
  clearCache();
  calls = [];
  answers = {
    address: { toxicScore: 0, traits: [] },
    message: { messageType: "TransferWithAuthorization", domain: { name: "GatewayWalletBatched" }, riskGroup: "Low", detectors: [] },
  };
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (answers.status) return new Response("boom", { status: answers.status });
    const body = /analysis\/signature/.test(url)
      ? answers.message
      : /token-intelligence/.test(url)
        ? answers.token ?? {}
        : answers.address;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});

const out = (over: Partial<Parameters<typeof screenOutgoing>[0]> = {}) =>
  screenOutgoing({ from: AGENT, payTo: PAYEE, asset: ARC_USDC, amountUsd: 0.01, typedData: TYPED, website: "http://x", ...over });

test("a clean payee, real USDC and a plain authorisation is paid", async () => {
  const v = await out();
  assert.equal(v.decision, "pay");
  assert.deepEqual(v.checks.map((c) => c.subject).sort(), ["authorization", "payTo", "token"]);
  assert.ok(calls.some((u) => u.includes(`/account/${PAYEE}/toxic-score`)), "payee deep-scanned");
  assert.ok(calls.some((u) => u.includes("/analysis/signature")), "authorisation scanned");
});

test("a sanctioned payee is refused, with the trait as the reason", async () => {
  answers.address = { toxicScore: 95, traits: [{ name: "sanction_address", risk: 100, txsCount: 3, description: "OFAC" }] };
  const v = await out();
  assert.equal(v.decision, "refuse");
  assert.match(v.reasons[0], /sanction address/);
  assert.equal(v.capUsd, 0);
});

test("a severe trait refuses even on a low score", async () => {
  answers.address = { toxicScore: 5, traits: [{ name: "known_scammer", risk: 40, txsCount: 1, description: "" }] };
  assert.equal((await out()).decision, "refuse");
});

test("warning signs cap what the agent may pay alone", async () => {
  answers.address = { toxicScore: 40, traits: [{ name: "mixer_transfers", risk: 40, txsCount: 2, description: "" }] };
  const small = await out({ amountUsd: 0.05 });
  assert.equal(small.decision, "cap");
  assert.equal(small.capUsd, 0.1);
  const big = await out({ amountUsd: 1 });
  assert.equal(big.decision, "hold");
  assert.match(big.reasons.at(-1)!, /over the \$0\.10/);
});

test("a clean payee above the auto-approve limit goes to the human", async () => {
  const v = await out({ amountUsd: 5 });
  assert.equal(v.decision, "hold");
  assert.equal(v.capUsd, 0.4);
});

test("a quote in anything but Arc's USDC is refused", async () => {
  answers.token = { riskLevel: "high", category: "malicious", token: { chainId: 1, address: "0x1", symbol: "USDC" }, detectors: [] };
  const v = await out({ asset: "0x" + "99".repeat(20) });
  assert.equal(v.decision, "refuse");
  assert.match(v.reasons[0], /not Arc's native USDC.*USDC, high risk, malicious/);
});

test("a lookalike USDC is named as a fake, in Intercepta's words", async () => {
  answers.token = {
    riskLevel: "high", category: "malicious", action: "block",
    token: { chainId: 1, address: "0x7401", symbol: "USDC" },
    detectors: [{ code: "FAKE_TOKEN", description: "Visual or ticker spoof of a famous coin." }, { code: "KNOWN_MALICIOUS", description: "flagged" }],
  };
  const v = await out({ asset: "0x740192316891b06aeddF20c741aBFC76d4CbECB0" });
  assert.equal(v.decision, "refuse");
  assert.match(v.reasons[0], /is a fake USDC - Intercepta: high risk, malicious, action block/);
  assert.deepEqual(v.checks.find((c) => c.subject === "token")!.detectors!.map((d) => d.code), ["FAKE_TOKEN", "KNOWN_MALICIOUS"]);
});

test("a High-risk authorisation is refused", async () => {
  // The shape the live API returned for an authorisation paying a flagged address.
  answers.message = {
    domain: { name: "GatewayWalletBatched", chainId: "8453" },
    messageType: "TransferWithAuthorization",
    riskGroup: "High",
    detectors: [{ code: "KNOWN_MALICIOUS", description: "Spender address flagged in phishing list." }],
    addresses: [{ address: PAYEE, type: "eoa", detectors: ["KNOWN_MALICIOUS"] }],
  };
  const v = await out();
  assert.equal(v.decision, "refuse");
  assert.match(v.reasons[0], /phishing list.*known malicious \(0xabab/);
});

test("an authorisation Intercepta did not read is not a pass", async () => {
  // What comes back when the typed data is sent as a string: nothing parsed, "Low".
  answers.message = { domain: { name: null, chainId: "8453" }, messageType: null, riskGroup: "Low", detectors: [], addresses: [] };
  const v = await out();
  assert.equal(v.decision, "hold");
  assert.match(v.reasons[0], /could not read the authorisation/);
});

test("no answer from Intercepta is a hold, never a pass", async () => {
  answers.status = 500;
  const v = await out();
  assert.equal(v.decision, "hold");
  assert.ok(v.checks.some((c) => c.level === "unknown"));
});

test("no key is a hold, and nothing is called", async () => {
  delete process.env.INTERCEPTA_API_KEY;
  const v = await out();
  assert.equal(v.decision, "hold");
  assert.equal(calls.length, 0);
});

test("answers are reused for a while, to spare the quota", async () => {
  await out();
  const first = calls.length;
  await out();
  assert.equal(calls.length, first + 1, "only the authorisation, which differs each time, is asked again");
});

test("a seller refuses a flagged payer and accepts a clean one", async () => {
  assert.equal((await screenIncoming(AGENT, 1)).decision, "pay");
  clearCache();
  answers.address = { toxicScore: 80, traits: [{ name: "attack_money_target", risk: 90, txsCount: 1, description: "stolen funds" }] };
  const v = await screenIncoming(AGENT, 1);
  assert.equal(v.decision, "refuse");
  assert.ok(calls.some((u) => u.includes("/quick-scan")), "the hot path uses quick scan");
});

test("a seller cannot wait for a human, so an unscreened payer is refused", async () => {
  answers.status = 403;
  const v = await screenIncoming(AGENT, 1);
  assert.equal(v.decision, "refuse");
  assert.match(v.reasons[0], /refused the API key/);
});

test("holds belong to their human and are answered once", async () => {
  const verdict = await out({ amountUsd: 5 });
  const h = createHold({ human: "0xH", agentAddress: AGENT, url: "http://x/dossier", method: "GET", payTo: PAYEE, amountUsd: 5, verdict });
  assert.equal(openHolds("0xh").length, 1);
  assert.equal(openHolds("0xother").length, 0);
  resolveHold(h.holdId, "declined");
  assert.equal(getHold(h.holdId)?.status, "declined");
  assert.equal(openHolds("0xH").length, 0);
});
