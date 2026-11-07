

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { arcEndpoints, arcFetch, healthyArcEndpoint, resetArcRpc } from "../src/lib/arcRpc";

const FIRST = arcEndpoints()[0];
const realFetch = globalThis.fetch;
let calls: { url: string; method: string }[];
let answer: (url: string, method: string) => { status: number; result?: unknown; text?: string };

beforeEach(() => {
  resetArcRpc();
  calls = [];
  answer = () => ({ status: 200, result: "0x1" });
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const { method, id } = JSON.parse(init.body);
    calls.push({ url, method });
    const a = answer(url, method);
    return new Response(a.text ?? JSON.stringify({ jsonrpc: "2.0", id, result: a.result }), { status: a.status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const rpc = async (method: string, id = 1, params: unknown[] = []) => {
  const res = await arcFetch("https://ignored.test", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return res.json();
};

test("the configured endpoint comes first, with public ones behind it", () => {
  assert.equal(arcEndpoints()[0], process.env.ARC_RPC_URL || arcEndpoints()[0]);
  assert.ok(arcEndpoints().length > 2);
});

test("a rate-limited endpoint rests and the next one answers", async () => {
  answer = (url) => (url === FIRST ? { status: 429, text: "slow down" } : { status: 200, result: "0x2" });
  assert.equal((await rpc("eth_getBalance")).result, "0x2");
  assert.equal(calls[0].url, FIRST);
  assert.notEqual(calls[1].url, FIRST);
  // It is left alone while it rests.
  calls = [];
  await rpc("eth_blockNumber");
  assert.notEqual(calls[0].url, FIRST);
  assert.notEqual(healthyArcEndpoint(), FIRST);
});

test("a throttle sent as a 200 counts as a throttle", async () => {
  answer = (url) =>
    url === FIRST ? { status: 200, text: '{"error":{"message":"Request exceeds defined limit."}}' } : { status: 200, result: "0x3" };
  assert.equal((await rpc("eth_getBalance")).result, "0x3");
});

test("identical reads make one call, each answered with its own id", async () => {
  const [a, b, c] = await Promise.all([rpc("eth_getBalance", 1), rpc("eth_getBalance", 2), rpc("eth_getBalance", 3)]);
  assert.equal(calls.length, 1);
  assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
  await rpc("eth_getBalance", 4);
  assert.equal(calls.length, 1, "served from the short memory");
});

test("different reads are not mixed up", async () => {
  await rpc("eth_getBalance", 1, ["0xa"]);
  await rpc("eth_getBalance", 2, ["0xb"]);
  assert.equal(calls.length, 2);
});

test("a write clears remembered reads", async () => {
  await rpc("eth_getBalance");
  await rpc("eth_sendRawTransaction", 2, ["0xsigned"]);
  await rpc("eth_getBalance");
  assert.deepEqual(calls.map((c) => c.method), ["eth_getBalance", "eth_sendRawTransaction", "eth_getBalance"]);
});

test("nonces and receipts are never remembered", async () => {
  await rpc("eth_getTransactionCount");
  await rpc("eth_getTransactionCount");
  await rpc("eth_getTransactionReceipt");
  await rpc("eth_getTransactionReceipt");
  assert.equal(calls.length, 4);
});

test("an error answer is not remembered", async () => {
  answer = () => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}' });
  await rpc("eth_call");
  await rpc("eth_call");
  assert.equal(calls.length, 2);
});

test("only a few calls run at once", async () => {
  let running = 0;
  let peak = 0;
  globalThis.fetch = (async (_i: any, init: any) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return new Response(JSON.stringify({ id: JSON.parse(init.body).id, result: "0x1" }), { status: 200 });
  }) as typeof fetch;
  await Promise.all(Array.from({ length: 20 }, (_, i) => rpc("eth_getBalance", i, [`0x${i}`])));
  assert.ok(peak <= 4, `peak ${peak}`);
});

test("when everything is down it fails instead of hanging", { timeout: 60_000 }, async () => {
  answer = () => ({ status: 429, text: "no" });
  await assert.rejects(rpc("eth_getBalance"), /throttled/);
});
