import fs from "./storeFs";
import { writeJsonAtomic } from "./atomicWrite";
import path from "path";

export interface PaymentRecord {
  paymentId: string;
  agentAddress: string;
  humanProfileId: string;
  sellerAddress: string;
  resourceUrl: string;
  requestedAmount: string; // e.g. "0.01"
  agentGatewayBalance: string; // e.g. "0.00"
  shortfall: string; // e.g. "0.01"
  fundingSource: "AGENT_GATEWAY" | "AGENT_WALLET" | "LIFELINE_FACILITY";
  /** Arc when absent: every payment before Sui was an Arc payment. */
  rail?: "arc" | "sui";
  /** For Sui payments: which network, so the tape links the right explorer. */
  network?: string;
  drawdownId: string | null;
  status: "SUCCESS" | "FAILED" | "REJECTED_CREDIT" | "REFUSED_RISK" | "HELD";
  timestamp: number;
  transactionId?: string;
  memo?: string;
  /** Intercepta's verdict on an Arc payment, taken before it was signed. */
  screening?: { decision: string; reasons: string[]; capUsd: number; holdId?: string };
}

/**
 * Resolved per call rather than at import, because cwd differs by how the
 * process was started: `next dev` runs from web/, a tsx script from the repo
 * root. Pinning `process.cwd()/data` at module load split the ledger in two -
 * payments written by the app and payments written by a script landed in
 * different files. Every other store here already probes both candidates; this
 * one did not.
 */
function getPaymentsFilePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "payments.json"),
    path.resolve(process.cwd(), "data", "payments.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), "data", "payments.json");
}

function ensureDirectoryExists() {
  const dir = path.dirname(getPaymentsFilePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAllPayments(): PaymentRecord[] {
  try {
    ensureDirectoryExists();
    if (!fs.existsSync(getPaymentsFilePath())) {
      return [];
    }
    const content = fs.readFileSync(getPaymentsFilePath(), "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error("[PaymentStore] Error reading payments file:", error);
    return [];
  }
}

export function saveAllPayments(payments: PaymentRecord[]) {
  try {
    ensureDirectoryExists();
    writeJsonAtomic(getPaymentsFilePath(), payments);
  } catch (error) {
    console.error("[PaymentStore] Error writing payments file:", error);
  }
}

export function recordPayment(payment: PaymentRecord): PaymentRecord {
  const all = getAllPayments();
  all.unshift(payment);
  saveAllPayments(all);
  return payment;
}

export function getPaymentsByAgent(agentAddress: string): PaymentRecord[] {
  const all = getAllPayments();
  return all.filter(
    (p) => p.agentAddress.toLowerCase() === agentAddress.toLowerCase()
  );
}

export function getPaymentsByHuman(humanProfileId: string): PaymentRecord[] {
  const all = getAllPayments();
  return all.filter(
    (p) => p.humanProfileId.toLowerCase() === humanProfileId.toLowerCase()
  );
}
