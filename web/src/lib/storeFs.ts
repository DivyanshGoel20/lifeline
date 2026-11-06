import realFs from "fs";
import path from "path";
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "worker_threads";

/**
 * The ledgers' file system.
 *
 * Lifeline's stores are JSON files read and written synchronously, on a disk that
 * outlives the process. Serverless has no such disk: each function has its own,
 * and it does not last. With Redis configured (KV_REST_API_URL or
 * UPSTASH_REDIS_REST_URL), the data/*.json files live there instead, and the stores
 * do not know the difference. Without it this is plain `fs`, so local runs and tests
 * use files exactly as they always have.
 *
 * Calls stay synchronous because the stores are: a worker thread makes the request
 * and this thread waits for it. A worker survives between requests, so this costs
 * one round trip per call. Very short-lived reads are served from memory, because a
 * single request reads the same file many times.
 *
 * Not a database: two instances can still lose an update to the same file, and the
 * ledger lock is per process. This is fine for a testnet deployment with light use.
 */
const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const usesRedis = () => Boolean(url() && token());

const isLedger = (p: unknown): p is string =>
  typeof p === "string" && path.basename(path.dirname(p)) === "data" && p.endsWith(".json");
const keyOf = (p: string) => `lifeline:data:${path.basename(p)}`;
const isDataDir = (p: unknown) => typeof p === "string" && path.basename(p) === "data";

const WORKER = `
const { parentPort, workerData } = require("worker_threads");
parentPort.on("message", async ({ command, port, signal }) => {
  let reply;
  try {
    const res = await fetch(workerData.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + workerData.token, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(12000),
    });
    const body = await res.json();
    reply = res.ok && !body.error ? { result: body.result } : { error: body.error || ("Redis answered " + res.status) };
  } catch (err) {
    reply = { error: String(err && err.message || err) };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

const g = globalThis as unknown as { __lifelineKvWorker?: Worker };
function worker(): Worker {
  if (!g.__lifelineKvWorker) {
    g.__lifelineKvWorker = new Worker(WORKER, { eval: true, workerData: { url: url(), token: token() } });
    // It must not keep a process alive by itself.
    g.__lifelineKvWorker.unref();
  }
  return g.__lifelineKvWorker;
}

function redis(command: (string | number)[]): any {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  worker().postMessage({ command, port: port2, signal }, [port2 as MessagePort]);
  const waited = Atomics.wait(signal, 0, 0, 15000);
  const reply = receiveMessageOnPort(port1)?.message;
  port1.close();
  if (waited === "timed-out" || !reply) throw new Error("Redis did not answer in time.");
  if (reply.error) throw new Error(`Redis: ${reply.error}`);
  return reply.result;
}

const CACHE_MS = 150;
const recent = new Map<string, { at: number; value: string | null }>();

function read(p: string): string | null {
  const key = keyOf(p);
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = redis(["GET", key]) as string | null;
  recent.set(key, { at: Date.now(), value });
  return value;
}

function enoent(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: "ENOENT" });
}

const storeFs = {
  existsSync(p: any): boolean {
    if (usesRedis() && isLedger(p)) return read(p) !== null;
    if (usesRedis() && isDataDir(p)) return true;
    return realFs.existsSync(p);
  },
  readFileSync(p: any, options?: any): any {
    if (usesRedis() && isLedger(p)) {
      const value = read(p);
      if (value === null) throw enoent(p);
      return value;
    }
    return realFs.readFileSync(p, options);
  },
  mkdirSync(p: any, options?: any): any {
    if (usesRedis() && isDataDir(p)) return undefined;
    return realFs.mkdirSync(p, options);
  },
  /** Replaces the file whole, so there is no half-written state to protect against. */
  writeLedger(p: string, content: string): void {
    const key = keyOf(p);
    redis(["SET", key, content]);
    recent.set(key, { at: Date.now(), value: content });
  },
  isLedger,
};

export default storeFs;
