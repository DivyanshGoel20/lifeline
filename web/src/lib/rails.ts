import { ARC_LABEL } from "./arc";
/**
 * Lifeline settlement rails: Arc and Sui.
 *
 * Arc is the primary debt ledger and credit facility on EVM (Chain ID 5042002).
 * Sui is the non-EVM Move credit execution rail.
 */
export type Rail = "arc" | "sui";

export const RAIL_LABELS: Record<Rail, string> = {
  arc: "Arc",
  sui: "Sui",
};

export const RAIL_FACTS: Record<
  Rail,
  { network: string; facilitator: string; mechanism: string; resource: string }
> = {
  arc: {
    network: ARC_LABEL,
    facilitator: "Circle Gateway",
    mechanism: "batched settlement",
    resource: "Lifeline Premium API",
  },
  sui: {
    network: "Sui testnet",
    facilitator: "Sui Gateway",
    mechanism: "Move credit package",
    resource: "Sui Move Stream",
  },
};
