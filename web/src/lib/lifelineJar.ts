import path from "path";
import { createPublicClient, createWalletClient, encodePacked, formatUnits, http, parseAbi, parseUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import fs from "./storeFs";
import { writeJsonAtomic } from "./atomicWrite";
import { getAgentPrivateKey, authorizeAgentSpend } from "./agentKeys";
import { commitArcRepayment, prepareArcRepayment } from "./repayCore";
import { acquireLedgerLock } from "./ledgerLock";
import type { Agent } from "@/types";

/**
 * Repay in any token, through a Uniswap TJAR Token Jar on Base.
 *
 * Agents earn in whatever their customers pay; debt is in USDC. An agent sends an
 * approved token to the jar and its debt falls by what Uniswap says the token is
 * worth, less a safety margin. Lifeline never swaps or holds the token. Once the jar
 * is worth more than the Releaser's threshold, anyone may pay that threshold in USDC
 * and take everything in it. That USDC comes to Lifeline, and Bridge Kit moves it to Arc.
 *
 * Lifeline advances the repayment, and until the jar clears it carries the risk that
 * the token falls. The margin, the approved list and the per-repayment limit bound it.
 *
 * Off until LIFELINE_JAR_ADDRESS and LIFELINE_JAR_RELEASER_ADDRESS are set.
 */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const BASE_WETH = "0x4200000000000000000000000000000000000006" as const;
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
const USDC_DECIMALS = 6;

/** Only deep, established tokens: a thin one could be priced up and pay a debt with nothing. */
export const JAR_TOKENS = {
  WETH: { address: BASE_WETH, decimals: 18 },
  UNI: { address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83", decimals: 18 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
} as const;
export type JarToken = keyof typeof JAR_TOKENS;
export const isJarToken = (t: unknown): t is JarToken => typeof t === "string" && t in JAR_TOKENS;

const FEE_TIERS = [500, 3000, 10000] as const;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)",
]);
const ROUTER_ABI = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
]);
const RELEASER_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function threshold() view returns (uint256)",
  "function resourceRecipient() view returns (address)",
  "function maxReleaseLength() view returns (uint256)",
  "function releaseCost() view returns (uint256 total, uint256 fee)",
  "function release(uint256 nonce, address[] assets, address recipient, uint256 maxFee)",
]);

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? n : fallback;
};
export const jarLimits = () => ({
  /** What is taken off a token's quoted worth, against the price falling before the jar clears. */
  haircutBps: envNumber("LIFELINE_JAR_HAIRCUT_BPS", 300),
  maxPerRepaymentUsd: envNumber("LIFELINE_JAR_MAX_PER_REPAYMENT_USD", 5),
  /** Lifeline's keeper clears only when the jar is worth this much more than clearing costs. */
  minClearProfitUsd: envNumber("LIFELINE_JAR_MIN_PROFIT_USD", 0.05),
  /** A swap after clearing refuses to get less than this below the quote. */
  slippageBps: envNumber("LIFELINE_JAR_SLIPPAGE_BPS", 100),
});

const jarAddress = () => (process.env.LIFELINE_JAR_ADDRESS || null) as `0x${string}` | null;
const releaserAddress = () => (process.env.LIFELINE_JAR_RELEASER_ADDRESS || null) as `0x${string}` | null;
export const jarConfigured = () => Boolean(jarAddress() && releaserAddress());

const client = () => createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const walletFor = (privateKey: `0x${string}`) =>
  createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: base,
    transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
  });
const keeperKey = () => {
  const pk = (process.env.LIFELINE_JAR_KEEPER_KEY || process.env.PRIVATE_KEY) as `0x${string}` | undefined;
  if (!pk) throw new Error("No key to clear the jar with (LIFELINE_JAR_KEEPER_KEY).");
  return pk;
};

async function confirm(hash: `0x${string}`, what: string) {
  const receipt = await client().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted (${hash})`);
  return hash;
}

/** Every way to route this token to USDC on Uniswap v3: directly, or through WETH. */
function routes(token: `0x${string}`): `0x${string}`[] {
  const direct = FEE_TIERS.map((fee) => encodePacked(["address", "uint24", "address"], [token, fee, BASE_USDC]));
  if (token.toLowerCase() === BASE_WETH.toLowerCase()) return direct;
  const viaWeth = FEE_TIERS.flatMap((fee) =>
    FEE_TIERS.map((next) =>
      encodePacked(["address", "uint24", "address", "uint24", "address"], [token, fee, BASE_WETH, next, BASE_USDC])
    )
  );
  return [...direct, ...viaWeth];
}

/** What Uniswap would pay in USDC for this much of a token, and the route it would take. */
export async function quoteToUsdc(token: JarToken, amount: bigint): Promise<{ usdc: bigint; path: `0x${string}` }> {
  const c = client();
  const quotes = await Promise.all(
    routes(JAR_TOKENS[token].address).map(async (path) => {
      try {
        const { result } = await c.simulateContract({ address: QUOTER_V2, abi: QUOTER_ABI, functionName: "quoteExactInput", args: [path, amount] });
        return { usdc: result[0] as bigint, path };
      } catch {
        return { usdc: 0n, path }; // no such pool
      }
    })
  );
  const best = quotes.reduce((a, b) => (b.usdc > a.usdc ? b : a));
  if (best.usdc === 0n) throw new Error(`Uniswap has no route from ${token} to USDC on Base.`);
  return best;
}

/** What a repayment in this token would take off a debt. */
export async function quoteCredit(token: JarToken, amount: string) {
  const units = parseUnits(amount, JAR_TOKENS[token].decimals);
  if (units <= 0n) throw new Error("The amount must be positive.");
  const { usdc } = await quoteToUsdc(token, units);
  const worthUsd = Number(formatUnits(usdc, USDC_DECIMALS));
  const { haircutBps, maxPerRepaymentUsd } = jarLimits();
  const creditUsd = Math.floor(worthUsd * (1 - haircutBps / 10_000) * 1e6) / 1e6;
  return { token, amount, worthUsd, creditUsd, haircutBps, maxPerRepaymentUsd };
}

/* ------------------------------------------------------------ the record */

type JarRepayment = {
  human: string;
  agentAddress: string;
  token: JarToken;
  amount: string;
  creditUsd: number;
  txHash: string;
  status: "sent" | "booked";
  at: number;
  repaidUsd?: number;
  repayTxHash?: string;
};

function recordFile(): string {
  const c = [path.resolve(process.cwd(), "web", "data", "jar-repayments.json"), path.resolve(process.cwd(), "data", "jar-repayments.json")];
  for (const f of c) if (fs.existsSync(f)) return f;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? c[0] : c[1];
}
function readRecord(): JarRepayment[] {
  try {
    return fs.existsSync(recordFile()) ? JSON.parse(fs.readFileSync(recordFile(), "utf8")) : [];
  } catch {
    return [];
  }
}
const saveRecord = (rows: JarRepayment[]) => writeJsonAtomic(recordFile(), rows);
function updateRecord(txHash: string, change: Partial<JarRepayment>) {
  saveRecord(readRecord().map((r) => (r.txHash === txHash ? { ...r, ...change } : r)));
}

/* ------------------------------------------------------------ repaying */

export type JarBooker = (p: { human: string; agent: Agent; amountUsd: number; reference: string }) => Promise<{ repaidUsd: number; txHash: string }>;
export type JarSender = (p: { privateKey: `0x${string}`; token: JarToken; units: bigint }) => Promise<`0x${string}`>;
export type JarQuoter = (token: JarToken, amount: string) => Promise<{ creditUsd: number; worthUsd: number }>;

const bookIt: JarBooker = async ({ human, agent, amountUsd, reference }) => {
  const release = await acquireLedgerLock(human);
  try {
    const prepared = await prepareArcRepayment(human, amountUsd);
    if (!prepared.ok) throw new Error(prepared.error);
    const done = await commitArcRepayment({
      humanOwner: human,
      payingAgent: agent,
      beneficiaryAddress: agent.address,
      amount: prepared.amount,
      funding: { kind: "jar", reference },
    });
    return { repaidUsd: done.result.amountRepaid, txHash: done.txHash };
  } finally {
    release();
  }
};

const sendToJar: JarSender = async ({ privateKey, token, units }) => {
  const c = client();
  const address = JAR_TOKENS[token].address;
  const jar = jarAddress()!;
  const owner = privateKeyToAccount(privateKey).address;
  const held = (await c.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] })) as bigint;
  if (held < units) throw new Error(`The agent holds ${formatUnits(held, JAR_TOKENS[token].decimals)} ${token} on Base, which is not enough.`);
  const before = (await c.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [jar] })) as bigint;
  const hash = await confirm(
    await walletFor(privateKey).writeContract({ address, abi: ERC20_ABI, functionName: "transfer", args: [jar, units] }),
    "Sending to the jar"
  );
  const after = (await c.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [jar] })) as bigint;
  if (after - before < units) throw new Error(`The jar received less than was sent (${hash}).`);
  return hash;
};

/**
 * Pay Arc debt with a token on Base. The token moves first, so a failure after that
 * point is kept on record and booked by the next attempt, never sent twice.
 */
export async function repayWithToken(
  p: { human: string; agent: Agent; token: JarToken; amount: string },
  deps: {
    send?: JarSender;
    book?: JarBooker;
    quote?: JarQuoter;
    key?: (a: string) => `0x${string}` | null;
    allow?: (a: string, usd: number) => { ok: boolean; reason?: string };
    owed?: (human: string) => Promise<number>;
    configured?: () => boolean;
  } = {}
) {
  const {
    send = sendToJar,
    book = bookIt,
    quote = quoteCredit,
    key = getAgentPrivateKey as any,
    allow = authorizeAgentSpend,
    configured = jarConfigured,
    owed = async (h: string) => {
      const prepared = await prepareArcRepayment(h, Number.MAX_SAFE_INTEGER);
      return prepared.ok ? prepared.owed : 0;
    },
  } = deps;

  if (!configured()) throw new Error("Repaying in other tokens is not set up.");

  const pending = readRecord().find((r) => r.human === p.human && r.agentAddress === p.agent.address && r.status === "sent");
  if (pending) return finish(pending, p, book);

  const privateKey = key(p.agent.address);
  if (!privateKey) throw new Error("Lifeline does not hold this agent's key, so it cannot move its money.");

  const quoted = await quote(p.token, p.amount);
  const { maxPerRepaymentUsd } = jarLimits();
  if (quoted.creditUsd > maxPerRepaymentUsd) {
    throw new Error(`That is worth $${quoted.creditUsd.toFixed(2)}. One repayment in tokens is limited to $${maxPerRepaymentUsd.toFixed(2)}.`);
  }
  // Tokens in the jar cannot come back, so anything over the debt would be lost.
  const debt = await owed(p.human);
  if (!(debt > 0)) throw new Error("Nothing is owed.");
  if (quoted.creditUsd > debt + 0.01) {
    throw new Error(`That is worth $${quoted.creditUsd.toFixed(2)} after the margin, and only $${debt.toFixed(2)} is owed. Send less: the excess would not come back.`);
  }
  const allowed = allow(p.agent.address, quoted.creditUsd);
  if (!allowed.ok) throw new Error(`Lifeline will not sign for this agent: ${allowed.reason}`);

  const txHash = await send({ privateKey, token: p.token, units: parseUnits(p.amount, JAR_TOKENS[p.token].decimals) });
  const row: JarRepayment = {
    human: p.human,
    agentAddress: p.agent.address,
    token: p.token,
    amount: p.amount,
    creditUsd: quoted.creditUsd,
    txHash,
    status: "sent",
    at: Date.now(),
  };
  saveRecord([...readRecord(), row]);
  return finish(row, p, book);
}

async function finish(row: JarRepayment, p: { human: string; agent: Agent }, book: JarBooker) {
  const done = await book({ human: p.human, agent: p.agent, amountUsd: row.creditUsd, reference: `jar:${row.txHash}` });
  updateRecord(row.txHash, { status: "booked", repaidUsd: done.repaidUsd, repayTxHash: done.txHash });
  return { token: row.token, amount: row.amount, creditUsd: row.creditUsd, repaidUsd: done.repaidUsd, jarTxHash: row.txHash, repayTxHash: done.txHash };
}

/* ------------------------------------------------------------ the jar */

/** What is in the jar, what it is worth, and what it costs to clear. Public. */
export async function jarStatus() {
  if (!jarConfigured()) return { configured: false as const };
  const c = client();
  const jar = jarAddress()!;
  const releaser = releaserAddress()!;
  const held = await Promise.all(
    (Object.keys(JAR_TOKENS) as JarToken[]).map(async (token) => {
      const units = (await c.readContract({ address: JAR_TOKENS[token].address, abi: ERC20_ABI, functionName: "balanceOf", args: [jar] })) as bigint;
      const quote = units > 0n ? await quoteToUsdc(token, units).catch(() => null) : null;
      return { token, units, usdc: quote?.usdc ?? 0n, path: quote?.path ?? null };
    })
  );
  const [cost, nonce, recipient] = await Promise.all([
    c.readContract({ address: releaser, abi: RELEASER_ABI, functionName: "releaseCost" }) as Promise<readonly [bigint, bigint]>,
    c.readContract({ address: releaser, abi: RELEASER_ABI, functionName: "nonce" }) as Promise<bigint>,
    c.readContract({ address: releaser, abi: RELEASER_ABI, functionName: "resourceRecipient" }) as Promise<string>,
  ]);
  const usd = (n: bigint) => Number(formatUnits(n, USDC_DECIMALS));
  return {
    configured: true as const,
    chain: "Base",
    jar,
    releaser,
    resourceRecipient: recipient,
    nonce: nonce.toString(),
    worthUsd: usd(held.reduce((n, h) => n + h.usdc, 0n)),
    costToClearUsd: usd(cost[0]),
    feeUsd: usd(cost[1]),
    tokens: held.map((h) => ({ token: h.token, amount: formatUnits(h.units, JAR_TOKENS[h.token].decimals), worthUsd: usd(h.usdc) })),
    unbooked: readRecord().filter((r) => r.status === "sent").length,
    limits: jarLimits(),
    _held: held,
    _cost: cost,
    _nonce: nonce,
  };
}

/** The public part of the jar's status. */
export async function jarSummary() {
  const s = await jarStatus();
  if (!s.configured) return s;
  const { _held, _cost, _nonce, ...open } = s;
  return open;
}

/**
 * Lifeline's own keeper: clear the jar when it is worth it, then swap what came out to
 * USDC on Uniswap. Anyone may do the first half, and if someone does, the threshold still
 * reaches Lifeline. This exists so nothing depends on a searcher turning up.
 */
export async function clearJar() {
  const s = await jarStatus();
  if (!s.configured) return { cleared: false, reason: "not set up" };

  const { minClearProfitUsd, slippageBps } = jarLimits();
  const items = s._held.filter((h) => h.units > 0n && h.path);
  const keep = (n: bigint) => (n * BigInt(10_000 - slippageBps)) / 10_000n;
  const expected = items.reduce((n, h) => n + keep(h.usdc), 0n);
  const [cost, fee] = s._cost;
  const need = cost + parseUnits(minClearProfitUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const worthUsd = Number(formatUnits(expected, USDC_DECIMALS));
  const costUsd = Number(formatUnits(cost, USDC_DECIMALS));
  if (items.length === 0 || expected < need) {
    return { cleared: false, reason: `The jar is worth $${worthUsd.toFixed(2)}. Clearing costs $${costUsd.toFixed(2)}.`, worthUsd, costUsd };
  }

  const c = client();
  const wallet = walletFor(keeperKey());
  const keeper = wallet.account.address;
  const releaser = releaserAddress()!;

  const usdcBefore = (await c.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [keeper] })) as bigint;
  if (usdcBefore < cost) {
    throw new Error(`The keeper holds $${formatUnits(usdcBefore, USDC_DECIMALS)} on Base and clearing costs $${costUsd.toFixed(2)}.`);
  }
  const write = async (args: any, what: string) => confirm(await wallet.writeContract(args), what);

  await write({ address: BASE_USDC, abi: ERC20_ABI, functionName: "approve", args: [releaser, cost] }, "Approving the release");
  const releaseTx = await write(
    { address: releaser, abi: RELEASER_ABI, functionName: "release", args: [s._nonce, items.map((h) => JAR_TOKENS[h.token].address), keeper, fee] },
    "Clearing the jar"
  );

  const swaps: { token: JarToken; usdc: string; txHash: string }[] = [];
  for (const h of items) {
    const address = JAR_TOKENS[h.token].address;
    await write({ address, abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER_02, h.units] }, "Approving the swap");
    // Quoted again: the price the release was decided on may have moved.
    const fresh = await quoteToUsdc(h.token, h.units);
    const txHash = await write(
      {
        address: SWAP_ROUTER_02,
        abi: ROUTER_ABI,
        functionName: "exactInput",
        args: [{ path: fresh.path, recipient: keeper, amountIn: h.units, amountOutMinimum: keep(fresh.usdc) }],
      },
      `Swapping ${h.token}`
    );
    swaps.push({ token: h.token, usdc: formatUnits(fresh.usdc, USDC_DECIMALS), txHash });
  }
  const usdcAfter = (await c.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [keeper] })) as bigint;
  return { cleared: true, releaseTx, swaps, costUsd, usdcBeforeUsd: formatUnits(usdcBefore, USDC_DECIMALS), usdcAfterUsd: formatUnits(usdcAfter, USDC_DECIMALS) };
}

/**
 * Bring what the jar earned to Arc, to replace what Lifeline advanced. Base mainnet can
 * only reach Arc mainnet: a testnet is a different network with different money.
 */
export async function bridgeProceedsToArc(amountUsd: number) {
  if (!(amountUsd > 0)) throw new Error("The amount must be positive.");
  const [{ BridgeKit }, { createViemAdapterFromPrivateKey }] = await Promise.all([
    import("@circle-fin/bridge-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const adapter = createViemAdapterFromPrivateKey({ privateKey: keeperKey() });
  const result = await new BridgeKit().bridge({
    from: { adapter, chain: "Base" },
    to: { adapter, chain: "Arc" },
    amount: amountUsd.toFixed(USDC_DECIMALS),
  } as any);
  return { state: result.state, steps: (result.steps as any[]).map((s) => ({ name: s.name, state: s.state, txHash: s.txHash })) };
}
