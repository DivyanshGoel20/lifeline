import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

/** Against a stand-in for Redis's REST API, in its own process: this thread blocks while it waits. */
const SERVER = `
const m = new Map();
require("http").createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.headers.authorization !== "Bearer t0k3n") { res.statusCode = 401; return res.end(JSON.stringify({ error: "bad token" })); }
    const [cmd, k, v] = JSON.parse(b);
    if (cmd === "SET") m.set(k, v);
    res.end(JSON.stringify({ result: cmd === "GET" ? (m.has(k) ? m.get(k) : null) : "OK" }));
  });
}).listen(0, function () { process.stdout.write(String(this.address().port)); });
`;

test("the stores read and write Redis when it is configured", async () => {
  const child = spawn(process.execPath, ["-e", SERVER]);
  after(() => child.kill());
  const port = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d))));

  process.env.KV_REST_API_URL = `http://127.0.0.1:${port}`;
  process.env.KV_REST_API_TOKEN = "t0k3n";
  const { default: fs } = await import("../src/lib/storeFs");
  const { writeJsonAtomic } = await import("../src/lib/atomicWrite");
  const file = path.resolve("/no/such/dir/data/redis-test.json");

  assert.equal(fs.existsSync(file), false);
  assert.throws(() => fs.readFileSync(file, "utf8"), /ENOENT/);
  writeJsonAtomic(file, { a: 1 });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });

  // Past the short memory of recent reads: this comes from the server.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });

  // Not a ledger: still the real disk.
  assert.equal(fs.existsSync("/no/such/dir/other.json"), false);
  assert.ok(String(fs.readFileSync(path.resolve(__dirname, "storeFs.test.ts"), "utf8")).includes("stand-in"));
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  // A worker left waiting must not hold the test run open.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});
