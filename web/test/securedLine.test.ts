process.env.LIFELINE_SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.LIFELINE_COLLATERAL_VAULT_ADDRESS = "0x00000000000000000000000000000000000000c0";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useSandbox } from "./sandbox";
import { addAgentToStore, getAgentByAddress, getHumanFacilityStats } from "../src/lib/agentStore";
import { createLoan, getActiveLoansByHuman } from "../src/lib/loanStore";
import { collateralCreditUsd, collateralRecord, saveCollateral } from "../src/lib/collateralStore";
import { bindDepositWallet, depositCalls, seizeCollateral, syncCollateral, useVaultChain, withdrawalCalls } from "../src/lib/securedLine";
import { useChainHooks } from "../src/lib/standing";
import { repayFromOtherChain } from "../src/lib/crosschainRepay";

/** Deposit-backed credit and cross-chain repayment, with the chain stood in for. */

const dir = useSandbox();
const HUMAN = "human-secured";
const AGENT = "0x00000000000000000000000000000000000000a1";
const WALLET = "0x00000000000000000000000000000000000000d1";
const ZERO = "0x0000000000000000000000000000000000000000";

let vault: { assetsUsd: number; creditUsd: number; controller: string; pendingWithdrawalUsd: number; readyAt: number };
let limits: number[];
let bound: string[];
let seizeResult: { txHash: string; takenUsd: number };

useChainHooks({
  arc: { suspend: async () => "0x", activate: async () => "0x", markDefault: async () => "0x" },
  sui: { setStatus: async () => undefined },
});

beforeEach(() => {
  for (const f of fs.readdirSync(path.join(dir, "data"))) fs.rmSync(path.join(dir, "data", f), { force: true });
  vault = { assetsUsd: 0, creditUsd: 0, controller: ZERO, pendingWithdrawalUsd: 0, readyAt: 0 };
  limits = [];
  bound = [];
  seizeResult = { txHash: "", takenUsd: 0 };
  useVaultChain({
    read: async () => vault,
    setLimit: async (_h, usd) => limits.push(usd),
    bind: async (_h, w) => (bound.push(w), "0xbind"),
    seize: async () => seizeResult,
  });
  addAgentToStore({ address: AGENT, name: "a", humanOwner: HUMAN, creditLimit: 500, outstandingDebt: 0, currentBalance: 0, totalBorrowed: 0, totalRepaid: 0, status: "Healthy" } as any);
});

test("a deposit raises the line by what it backs, on top of the earned tier", async () => {
  const tier = getHumanFacilityStats(HUMAN).totalCreditLimit;
  vault.assetsUsd = 100;
  vault.creditUsd = 80;
  const synced = await syncCollateral(HUMAN);
  assert.equal(synced.limitChanged, true);
  assert.equal(collateralCreditUsd(HUMAN), 80);
  assert.equal(getHumanFacilityStats(HUMAN).totalCreditLimit, tier + 80);
  assert.equal(getHumanFacilityStats(HUMAN).totalAvailableCredit, tier + 80);
});

test("the on-chain limit is only written when it changed", async () => {
  vault.creditUsd = 80;
  await syncCollateral(HUMAN);
  assert.equal(limits.length, 1);
  await syncCollateral(HUMAN);
  assert.equal(limits.length, 1);
});

test("asking to withdraw lowers the line at the next sync", async () => {
  vault.creditUsd = 80;
  await syncCollateral(HUMAN);
  vault.creditUsd = 40;
  await syncCollateral(HUMAN);
  assert.equal(collateralCreditUsd(HUMAN), 40);
});

test("a human with no deposit has exactly the line they had", () => {
  assert.equal(collateralRecord(HUMAN), null);
  assert.equal(collateralCreditUsd(HUMAN), 0);
});

test("a wallet binds once, and no other wallet can take over", async () => {
  assert.deepEqual(await bindDepositWallet(HUMAN, WALLET), { alreadyBound: false, txHash: "0xbind" });
  assert.deepEqual(bound, [WALLET]);

  vault.controller = WALLET;
  assert.deepEqual(await bindDepositWallet(HUMAN, WALLET.toUpperCase().replace("0X", "0x")), { alreadyBound: true });
  await assert.rejects(bindDepositWallet(HUMAN, "0x00000000000000000000000000000000000000e2"), /different wallet/);
});

test("a seizure pays down the debt on Lifeline's ledger too", async () => {
  createLoan({ agentAddress: AGENT, agentName: "a", humanOwner: HUMAN, amount: 10, txHash: "" });
  saveCollateral(HUMAN, { assetsUsd: 10, creditUsd: 8, syncedAt: 1 });
  seizeResult = { txHash: "0xseize", takenUsd: 10.1 };

  const out = await seizeCollateral(HUMAN);
  assert.equal(out.takenUsd, 10.1);
  assert.equal(getActiveLoansByHuman(HUMAN).length, 0);
  assert.equal(getAgentByAddress(AGENT)?.outstandingDebt, 0);
  assert.equal(collateralCreditUsd(HUMAN), 0, "synced with the vault afterwards");
});

test("a partial seizure leaves the rest owed", async () => {
  createLoan({ agentAddress: AGENT, agentName: "a", humanOwner: HUMAN, amount: 10, txHash: "" });
  seizeResult = { txHash: "0xseize", takenUsd: 4 };
  await seizeCollateral(HUMAN);
  assert.ok(Math.abs((getAgentByAddress(AGENT)?.outstandingDebt ?? 0) - 6.1) < 0.001);
});

test("nothing to seize books nothing", async () => {
  createLoan({ agentAddress: AGENT, agentName: "a", humanOwner: HUMAN, amount: 10, txHash: "" });
  assert.deepEqual(await seizeCollateral(HUMAN), { takenUsd: 0 });
  assert.equal(getActiveLoansByHuman(HUMAN).length, 1);
});

test("deposit and withdrawal calls are built for the wallet to sign", () => {
  const dep = depositCalls(HUMAN, 12.5);
  assert.equal(dep.length, 2);
  assert.equal(dep[0].to, "0x3600000000000000000000000000000000000000");
  assert.equal(dep[1].to, process.env.LIFELINE_COLLATERAL_VAULT_ADDRESS);
  assert.ok(dep[0].data.startsWith("0x095ea7b3"), "an approve");
  const out = withdrawalCalls(HUMAN, 5, WALLET);
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------- cross-chain

const agent = { address: AGENT, humanOwner: HUMAN } as any;
const base = { human: HUMAN, agent, from: "Base_Sepolia" as const, amountUsd: 5 };
const steps = [{ name: "burn", state: "success", txHash: "0xburn" }, { name: "mint", state: "success", txHash: "0xmint" }];

function deps(over: Record<string, unknown> = {}) {
  let balance = 1;
  const booked: number[] = [];
  return {
    booked,
    deps: {
      pause: async () => undefined,
      key: () => "0xkey" as `0x${string}`,
      allow: () => ({ ok: true }),
      wallet: async () => balance,
      bridge: async () => {
        balance += 4.99;
        return { state: "success", steps };
      },
      book: async (p: { amountUsd: number }) => (booked.push(p.amountUsd), { repaidUsd: p.amountUsd, txHash: "0xrepay" }),
      ...over,
    } as any,
  };
}

test("repays what actually arrived, not what was sent", async () => {
  const d = deps();
  const out = await repayFromOtherChain(base, d.deps);
  assert.equal(out.bridgedUsd, 4.99);
  assert.deepEqual(d.booked, [4.99]);
  assert.equal(out.steps[1].txHash, "0xmint");
});

test("a bridge that fails repays nothing and says where it stopped", async () => {
  const d = deps({ bridge: async () => ({ state: "error", steps: [{ name: "burn", state: "error", errorMessage: "no gas" }] }) });
  await assert.rejects(repayFromOtherChain(base, d.deps), /no gas/);
  assert.deepEqual(d.booked, []);
});

test("a balance that lags the mint is waited for", async () => {
  let reads = 0;
  const d = deps({
    bridge: async () => ({ state: "success", steps }),
    wallet: async () => (++reads < 4 ? 1 : 5.99),
  });
  const out = await repayFromOtherChain(base, d.deps);
  assert.equal(out.bridgedUsd, 4.99);
  assert.deepEqual(d.booked, [4.99]);
});

test("money that has not arrived is not repaid", async () => {
  const d = deps({ bridge: async () => ({ state: "success", steps }) });
  await assert.rejects(repayFromOtherChain(base, d.deps), /reached the agent's wallet/);
  assert.deepEqual(d.booked, []);
});

test("the key's spending ceiling applies to a bridge too", async () => {
  let bridged = false;
  const d = deps({
    allow: () => ({ ok: false, reason: "over its ceiling" }),
    bridge: async () => ((bridged = true), { state: "success", steps }),
  });
  await assert.rejects(repayFromOtherChain(base, d.deps), /over its ceiling/);
  assert.equal(bridged, false);
});

test("without the agent's key nothing moves", async () => {
  const d = deps({ key: () => null });
  await assert.rejects(repayFromOtherChain(base, d.deps), /does not hold this agent's key/);
});
