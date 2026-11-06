import fs from "fs";
import { writeJsonAtomic } from "./atomicWrite";
import path from "path";
import { CREDIT_TIERS, CreditTier } from "./reputationEngine";
import { updateOnChainCreditLimit } from "./facilityContract";

/**
 * Arc and Sui are separate lines, each with its own record: repaying on one
 * builds that rail's record and raises that rail's limit, and nothing else.
 * Arc records keep the key they always had; Sui's is suffixed.
 */
export type RecordRail = "arc" | "sui";
const recordKey = (humanOwner: string, rail: RecordRail) =>
  rail === "arc" ? humanOwner.toLowerCase() : `${humanOwner.toLowerCase()}:sui`;

export interface HumanReputationData {
  humanOwner: string;
  totalInterestPaid: number;
  totalActiveDurationDays: number;
  repaymentsCount: number;
  currentTierNumber: number;
  tierGraduatedAt?: number;
  lastRepaymentAt?: number;
  /** Set when this rail's line defaulted: the record starts again from the first tier. */
  defaultedAt?: number;
  defaults?: number;
}

function getReputationFilePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "reputation.json"),
    path.resolve(process.cwd(), "data", "reputation.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), "data", "reputation.json");
}

function ensureDirectoryExists() {
  const filePath = getReputationFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAllReputationRecords(): Record<string, HumanReputationData> {
  try {
    ensureDirectoryExists();
    const filePath = getReputationFilePath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error("[ReputationStore] Error reading reputation file:", error);
    return {};
  }
}

export function saveAllReputationRecords(data: Record<string, HumanReputationData>) {
  try {
    ensureDirectoryExists();
    const primary = getReputationFilePath();
    // One file; the mirrored second copy was never read.
    writeJsonAtomic(primary, data);
  } catch (error) {
    console.error("[ReputationStore] Error writing reputation file:", error);
  }
}

export function getHumanReputationRecord(humanOwner: string, rail: RecordRail = "arc"): HumanReputationData {
  const all = getAllReputationRecords();
  const key = recordKey(humanOwner, rail);
  if (all[key]) {
    return all[key];
  }

  // Default Tier 1 Starter
  const initial: HumanReputationData = {
    humanOwner,
    totalInterestPaid: 0,
    totalActiveDurationDays: 0,
    repaymentsCount: 0,
    currentTierNumber: 1,
  };
  all[key] = initial;
  saveAllReputationRecords(all);
  return initial;
}

export function getHumanCreditTier(humanOwner: string, rail: RecordRail = "arc"): CreditTier {
  const record = getHumanReputationRecord(humanOwner, rail);
  const tier = CREDIT_TIERS.find((t) => t.tierNumber === record.currentTierNumber);
  // A record from when there were more tiers keeps the top one, not the first.
  return tier || CREDIT_TIERS[CREDIT_TIERS.length - 1];
}

/**
 * A default costs the record: back to the first tier, with the repayments and
 * time that earned the old one wiped. Paying the debt off afterwards lets it
 * grow again from there - never back to where it was.
 */
export function penalizeDefault(humanOwner: string, rail: RecordRail): HumanReputationData {
  const all = getAllReputationRecords();
  const key = recordKey(humanOwner, rail);
  const before = all[key] ?? getHumanReputationRecord(humanOwner, rail);
  const after: HumanReputationData = {
    ...before,
    totalInterestPaid: 0,
    totalActiveDurationDays: 0,
    repaymentsCount: 0,
    currentTierNumber: 1,
    defaultedAt: Date.now(),
    defaults: (before.defaults ?? 0) + 1,
  };
  all[key] = after;
  saveAllReputationRecords(all);
  return after;
}

/**
 * Record a settled repayment and check for automatic tier graduation.
 */
// One update at a time per record: each reads the record, waits seconds on
// Arc, then writes it back, and two at once kept only the later one.
const g = globalThis as unknown as { __lifelineReputationQueue?: Map<string, Promise<unknown>> };
const queue = (g.__lifelineReputationQueue ??= new Map());

export function recordRepaymentInReputation(params: Parameters<typeof recordRepaymentNow>[0]): ReturnType<typeof recordRepaymentNow> {
  const key = `${params.rail ?? "arc"}:${params.humanOwner.toLowerCase()}`;
  const run = (queue.get(key) ?? Promise.resolve()).catch(() => {}).then(() => recordRepaymentNow(params));
  queue.set(key, run);
  void run.finally(() => {
    if (queue.get(key) === run) queue.delete(key);
  }).catch(() => {});
  return run;
}

async function recordRepaymentNow(params: {
  humanOwner: string;
  interestPaid: number;
  loanDurationDays: number;
  rail?: RecordRail;
}): Promise<{
  upgraded: boolean;
  previousTier: CreditTier;
  currentTier: CreditTier;
  onChainTxHash?: string | null;
}> {
  const rail = params.rail ?? "arc";
  const all = getAllReputationRecords();
  const key = recordKey(params.humanOwner, rail);
  const record = all[key] || {
    humanOwner: params.humanOwner,
    totalInterestPaid: 0,
    totalActiveDurationDays: 0,
    repaymentsCount: 0,
    currentTierNumber: 1,
  };

  record.totalInterestPaid =
    Math.round((record.totalInterestPaid + params.interestPaid) * 10000) / 10000;
  record.totalActiveDurationDays =
    Math.round((record.totalActiveDurationDays + params.loanDurationDays) * 10) / 10;
  record.repaymentsCount += 1;
  record.lastRepaymentAt = Date.now();

  const prevTierNumber = record.currentTierNumber;
  const previousTier =
    CREDIT_TIERS.find((t) => t.tierNumber === prevTierNumber) || CREDIT_TIERS[0];

  // Evaluate tier graduation
  let eligibleTier = CREDIT_TIERS[0];
  for (let i = CREDIT_TIERS.length - 1; i >= 0; i--) {
    const t = CREDIT_TIERS[i];
    if (
      // Sui draws carry no fee, so its line grows on repayments and time.
      (rail === "sui" || record.totalInterestPaid >= t.requiredInterestPaid) &&
      record.totalActiveDurationDays >= t.requiredActiveDurationDays &&
      record.repaymentsCount >= t.requiredRepaymentsCount
    ) {
      eligibleTier = t;
      break;
    }
  }

  let upgraded = false;
  let onChainTxHash: string | null = null;

  if (eligibleTier.tierNumber > record.currentTierNumber) {
    console.log(
      `[ReputationStore] Human ${params.humanOwner} graduated to ${eligibleTier.name} ($${eligibleTier.creditLimit} limit)!`
    );
    record.currentTierNumber = eligibleTier.tierNumber;
    record.tierGraduatedAt = Date.now();
    upgraded = true;

    // The Arc contract holds the Arc limit. Sui's is carried to its facility
    // with each draw (see suiRail), so there is nothing to write here for it.
    if (rail === "arc") try {
      onChainTxHash = await updateOnChainCreditLimit(
        params.humanOwner,
        eligibleTier.creditLimit
      );
      if (onChainTxHash) {
        console.log(
          `[ReputationStore] On-chain credit limit upgraded to $${eligibleTier.creditLimit} USDC in tx ${onChainTxHash}`
        );
      }
    } catch (err: any) {
      console.warn("[ReputationStore] On-chain limit upgrade error:", err.message);
    }
  }

  all[key] = record;
  saveAllReputationRecords(all);

  const currentTier =
    CREDIT_TIERS.find((t) => t.tierNumber === record.currentTierNumber) || CREDIT_TIERS[0];

  return {
    upgraded,
    previousTier,
    currentTier,
    onChainTxHash,
  };
}
