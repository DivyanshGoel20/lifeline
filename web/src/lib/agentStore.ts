import { collateralCreditUsd } from "./collateralStore";
import fs from "./storeFs";
import { writeJsonAtomic } from "./atomicWrite";
import path from "path";
import { Agent } from "@/types";
import { getHumanCreditTier } from "./reputationStore";
import { railDebtTotal } from "./railDebt";

function getAgentsFilePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "agents.json"),
    path.resolve(process.cwd(), "data", "agents.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), "data", "agents.json");
}

function ensureDirectoryExists() {
  const filePath = getAgentsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAllAgents(): Agent[] {
  try {
    ensureDirectoryExists();
    const filePath = getAgentsFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error("[AgentStore] Error reading agents file:", error);
    return [];
  }
}

export function saveAllAgents(agents: Agent[]) {
  try {
    ensureDirectoryExists();
    const filePath = getAgentsFilePath();
    writeJsonAtomic(filePath, agents);
  } catch (error) {
    console.error("[AgentStore] Error writing agents file:", error);
  }
}

export function getAgentsByOwner(owner?: string): Agent[] {
  const all = getAllAgents();
  if (!owner) return all;
  return all.filter((a) => {
    return !!a.humanOwner && a.humanOwner.toLowerCase() === owner.toLowerCase();
  });
}

export function addAgentToStore(newAgent: Agent): Agent {
  const all = getAllAgents();
  const existingIndex = all.findIndex(
    (a) => a.address.toLowerCase() === newAgent.address.toLowerCase()
  );

  if (existingIndex >= 0) {
    // Updating an agent never moves it to another human.
    const current = all[existingIndex];
    if ((current.humanOwner || "").toLowerCase() !== (newAgent.humanOwner || "").toLowerCase()) {
      throw new Error("That agent belongs to a different human.");
    }
    all[existingIndex] = { ...current, ...newAgent };
    saveAllAgents(all);
    return all[existingIndex];
  }

  all.unshift(newAgent);
  saveAllAgents(all);
  return newAgent;
}

export function updateAgentInStore(
  address: string,
  updates: Partial<Agent>
): Agent | null {
  const all = getAllAgents();
  const index = all.findIndex(
    (a) => a.address.toLowerCase() === address.toLowerCase()
  );

  if (index === -1) return null;

  all[index] = { ...all[index], ...updates };
  saveAllAgents(all);
  return all[index];
}

export function getAgentByAddress(address: string): Agent | null {
  const all = getAllAgents();
  return (
    all.find((a) => a.address.toLowerCase() === address.toLowerCase()) || null
  );
}

/**
 * The human's Arc line. Arc and Sui are separate lines - separate limits,
 * separate debt, separate repayment records - so what is drawn on Sui never
 * touches Arc's headroom, and the other way round (see getSuiFacilityStats).
 */
/** The rail an agent belongs to. Agents from before rails were separate are Arc's. */
export const agentRail = (agent: Pick<Agent, "rail">): "arc" | "sui" => (agent.rail === "sui" ? "sui" : "arc");

export function getHumanFacilityStats(
  humanOwner: string
): {
  humanOwner: string;
  agentCount: number;
  totalCreditLimit: number;
  totalOutstandingDebt: number;
  arcOutstandingDebt: number;
  totalAvailableCredit: number;
  totalBorrowed: number;
  totalRepaid: number;
} {
  // Arc's agents only: a Sui agent is on the Sui line.
  const humanAgents = getAgentsByOwner(humanOwner).filter((a) => agentRail(a) === "arc");
  const tier = getHumanCreditTier(humanOwner, "arc");
  // What their record has earned, plus what their deposit backs.
  const totalCreditLimit = tier.creditLimit + collateralCreditUsd(humanOwner);
  const arcOutstandingDebt = Math.round(
    humanAgents.reduce((sum, a) => sum + (a.outstandingDebt || 0), 0) * 10000
  ) / 10000;
  const totalBorrowed = Math.round(
    humanAgents.reduce((sum, a) => sum + (a.totalBorrowed || 0), 0) * 10000
  ) / 10000;
  const totalRepaid = Math.round(
    humanAgents.reduce((sum, a) => sum + (a.totalRepaid || 0), 0) * 10000
  ) / 10000;
  const totalAvailableCredit = Math.max(
    0,
    Math.round((totalCreditLimit - arcOutstandingDebt) * 100) / 100
  );

  return {
    humanOwner,
    agentCount: humanAgents.length,
    totalCreditLimit,
    totalOutstandingDebt: arcOutstandingDebt,
    arcOutstandingDebt,
    totalAvailableCredit,
    totalBorrowed,
    totalRepaid,
  };
}

/** The human's Sui line: its own limit, from its own record, and its own debt. */
export function getSuiFacilityStats(humanOwner: string): {
  creditLimit: number;
  outstandingDebt: number;
  availableCredit: number;
} {
  const creditLimit = getHumanCreditTier(humanOwner, "sui").creditLimit;
  // Defaulted debt still counts (railDebtTotal): freeing the headroom would
  // make failing to pay the cheapest way to borrow again.
  const outstandingDebt = railDebtTotal(humanOwner);
  return {
    creditLimit,
    outstandingDebt,
    availableCredit: Math.max(0, Math.round((creditLimit - outstandingDebt) * 100) / 100),
  };
}

export function removeAgentFromStore(address: string): boolean {
  const all = getAllAgents();
  const filtered = all.filter(
    (a) => a.address.toLowerCase() !== address.toLowerCase()
  );

  if (filtered.length === all.length) return false;

  saveAllAgents(filtered);
  return true;
}

