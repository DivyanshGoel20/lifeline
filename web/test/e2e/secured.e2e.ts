/**
 * Arc's newer features, end to end, against the deployed vault and pool.
 *
 *   npm run dev            # in one terminal
 *   npm run e2e:secured    # here
 *
 * A fresh wallet links to a fresh human, binds as the deposit's controller, and
 * deposits. The line grows, a draw beyond the earned tier goes through, and on
 * default the deposit pays the debt. The same wallet lends into the pool, and an
 * agent buys from a real marketplace seller. Everything settles on Arc testnet.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createWalletClient, formatUnits, parseAbi, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { attachSession } from "../../src/lib/session";
import {
  LIFELINE_CREDIT_FACILITY_ABI,
  arcTestnetChain,
  computeProfileId,
  ensureHumanProfileOnChain,
  getArcTransport,
  getOnChainProfile,
  getPublicClient,
} from "../../src/lib/facilityContract";
import { LIFELINE_CREDIT_FACILITY_ADDRESS } from "../../src/lib/arc";
import { linkMessage } from "../../src/lib/securedLine";

const APP = process.env.LIFELINE_APP_URL || "http://localhost:3000";
const HUMAN = "0x" + crypto.randomBytes(32).toString("hex");

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail !== "" ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const client = getPublicClient();
const operator = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const operatorWallet = createWalletClient({ account: operator, chain: arcTestnetChain, transport: getArcTransport() });
const key = generatePrivateKey();
const user = privateKeyToAccount(key);
const userWallet = createWalletClient({ account: user, chain: arcTestnetChain, transport: getArcTransport() });

const session = attachSession(NextResponse.json({}), HUMAN).cookies.get("lifeline_session")!.value;
let cookie = `lifeline_session=${session}`;

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({} as any)) };
}

async function send(calls: { to: string; data: string }[]) {
  const hashes: string[] = [];
  for (const c of calls) {
    const hash = await userWallet.sendTransaction({ to: c.to as `0x${string}`, data: c.data as `0x${string}` });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`reverted ${hash}`);
    hashes.push(hash);
  }
  return hashes;
}

const near = (a: number, b: number, e = 0.005) => Math.abs(a - b) < e;

async function main() {
  console.log(`\nhuman ${HUMAN}\nwallet ${user.address}\n`);
  await ensureHumanProfileOnChain(HUMAN);

  const fund = await operatorWallet.sendTransaction({ to: user.address, value: parseUnits("3.2", 18) });
  await client.waitForTransactionReceipt({ hash: fund });
  check("wallet funded", true, fund);

  console.log("\nlinking");
  const nonceRes = await call("GET", "/api/auth/wallet/nonce");
  cookie += `; lifeline_siwe=${nonceRes.body.nonce}`;
  const bad = await call("POST", "/api/secured", { action: "link", wallet: operator.address, signature: await user.signMessage({ message: linkMessage(nonceRes.body.nonce) }) });
  check("a signature from another wallet does not link", bad.status === 400, bad.body.error);
  const link = await call("POST", "/api/secured", { action: "link", wallet: user.address, signature: await user.signMessage({ message: linkMessage(nonceRes.body.nonce) }) });
  check("the wallet links with a signature", link.body.success === true, link.body.error ?? "");
  const bind = await call("POST", "/api/secured", { action: "bind", wallet: user.address });
  check("bound as the deposit's controller", bind.body.success === true, bind.body.txHash ?? bind.body.error);

  console.log("\ndeposit-backed credit");
  const before = await call("GET", "/api/secured");
  check("starts at the earned tier", near(before.body.line.totalCreditLimit, 0.5), before.body.line.totalCreditLimit);
  const dep = await call("POST", "/api/secured", { action: "deposit", amountUsd: 1 });
  check("deposit transaction", (await send(dep.body.calls)).length === 2);
  const synced = await call("POST", "/api/secured", { action: "sync" });
  check("$1 deposit adds $0.80 of credit", near(synced.body.creditUsd, 0.8), synced.body.creditUsd);
  check("the line is $1.30", near(synced.body.line.totalCreditLimit, 1.3), synced.body.line.totalCreditLimit);
  const onChain = await getOnChainProfile(HUMAN);
  check("the facility's limit moved too", near(Number(onChain!.creditLimit), 1.3), onChain!.creditLimit);

  const provisioned = await call("POST", "/api/agent/provision", { label: "e2e-secured", capUsd: 2 });
  const agent = provisioned.body.agent?.address as string;
  check("agent provisioned", !!agent, agent);
  const draw = await call("POST", "/api/borrow", { agentAddress: agent, amount: 0.9, memo: "e2e secured" });
  check("a $0.90 draw, past the $0.50 tier, goes through", draw.body.success === true, draw.body.txHash ?? draw.body.error);

  console.log("\nmarketplace");
  const found = await call("GET", "/api/x402/discover?limit=50&maxUsd=0.05");
  const open = (found.body.services ?? []).find((s: any) => !s.needsSignIn && s.method === "GET");
  check("the marketplace lists a service that needs no sign-in", !!open, open?.url);
  if (open) {
    const bought = await call("POST", "/api/pay", { url: open.url, agentAddress: agent, method: open.method });
    check("an agent buys from a real seller", bought.body.success === true, bought.body.transactionId ?? bought.body.error ?? bought.status);
  }

  console.log("\ndefault");
  const profileId = computeProfileId(HUMAN);
  const debtBefore = Number((await getOnChainProfile(HUMAN))!.outstandingDebt);
  const mark = await operatorWallet.writeContract({
    address: LIFELINE_CREDIT_FACILITY_ADDRESS,
    abi: parseAbi(["function markDefault(bytes32 profileId)"]),
    functionName: "markDefault",
    args: [profileId],
  });
  await client.waitForTransactionReceipt({ hash: mark });
  const vault = process.env.LIFELINE_COLLATERAL_VAULT_ADDRESS as `0x${string}`;
  const VAULT = parseAbi(["function latchDefault(bytes32)", "function seize(bytes32) returns (uint256)", "function assetsOf(bytes32) view returns (uint256)"]);
  // A stranger can do both: collecting does not depend on Lifeline's servers.
  const latch = await userWallet.writeContract({ address: vault, abi: VAULT, functionName: "latchDefault", args: [profileId] });
  await client.waitForTransactionReceipt({ hash: latch });
  const seize = await userWallet.writeContract({ address: vault, abi: VAULT, functionName: "seize", args: [profileId] });
  const receipt = await client.waitForTransactionReceipt({ hash: seize });
  check("the deposit is seized", receipt.status === "success", seize);
  const after = await getOnChainProfile(HUMAN);
  const left = await client.readContract({ address: vault, abi: VAULT, functionName: "assetsOf", args: [profileId] });
  check("the debt fell by what was taken", Number(after!.outstandingDebt) < debtBefore, `${debtBefore} -> ${after!.outstandingDebt}, ${formatUnits(left, 6)} left in the vault`);

  console.log("\nlending pool");
  const pool = await call("GET", `/api/pool?lender=${user.address}`);
  check("the pool reads from the chain", pool.body.configured === true && pool.body.lockupSeconds === 86400, `lockup ${pool.body.lockupSeconds}s`);
  const lend = await call("POST", "/api/pool", { action: "deposit", amountUsd: 1 });
  check("a lender deposits", (await send(lend.body.calls)).length === 2);
  const lent = await call("GET", `/api/pool?lender=${user.address}`);
  check("the deposit shows", near(lent.body.lenderAssetsUsd, 1), lent.body.lenderAssetsUsd);
  check("and it is locked for a day", lent.body.lenderLockedUntil > Date.now() / 1000 + 86000, new Date(lent.body.lenderLockedUntil * 1000).toISOString());
  const out = await call("POST", "/api/pool", { action: "withdraw", amountUsd: 1 });
  const early = await send(out.body.calls).then(() => false, () => true);
  check("withdrawing inside the lockup reverts", early);

  console.log("\nlenders' money behind a loan");
  const human2 = "0x" + crypto.randomBytes(32).toString("hex");
  await ensureHumanProfileOnChain(human2);
  cookie = `lifeline_session=${attachSession(NextResponse.json({}), human2).cookies.get("lifeline_session")!.value}`;
  const borrower = (await call("POST", "/api/agent/provision", { label: "e2e-pool", capUsd: 2 })).body.agent?.address as string;
  const p0 = (await call("GET", "/api/pool")).body;
  const loan = await call("POST", "/api/borrow", { agentAddress: borrower, amount: 0.2, memo: "e2e pool" });
  check("a loan is made", loan.body.success === true, loan.body.txHash ?? loan.body.error);
  const p1 = (await call("GET", "/api/pool")).body;
  check("the pool funded it", near(p1.outstandingUsd - p0.outstandingUsd, 0.2, 0.0001), `lent out ${p0.outstandingUsd} -> ${p1.outstandingUsd}`);
  const topUp = await operatorWallet.sendTransaction({ to: borrower as `0x${string}`, value: parseUnits("0.3", 18) });
  await client.waitForTransactionReceipt({ hash: topUp });
  const repaid = await call("POST", "/api/repay", { agentAddress: borrower, amount: 1 });
  check("the borrower repays", repaid.body.success === true, repaid.body.txHash ?? repaid.body.error);
  const p2 = (await call("GET", "/api/pool")).body;
  check("the principal is back in the pool", near(p2.outstandingUsd, p0.outstandingUsd, 0.0001), `lent out ${p2.outstandingUsd}`);
  check("lenders earned what the borrower paid", p2.interestEarnedUsd > p0.interestEarnedUsd, `interest ${p0.interestEarnedUsd} -> ${p2.interestEarnedUsd}`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exit(1);
});
