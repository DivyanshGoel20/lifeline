import { ARC_LABEL } from "@/lib/arc";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    network: ARC_LABEL,
    settlement: "Circle Gateway / Lifeline overdraft",
    resources: [
      {
        path: "/api/paid/signal",
        price: 0.01,
        title: "Alpha Signal Intelligence",
        artifact: "json",
        description: "Low-cost high-frequency alpha data. Easily payable with agent Gateway balance."
      },
      {
        path: "/api/paid/risk-curve",
        price: 0.2,
        title: "Exposure curve · 30d",
        artifact: "svg",
        description: "Visual credit waterline SVG. Tests moderate drawdown against the credit line."
      },
      {
        path: "/api/paid/dossier",
        price: 0.45,
        title: "Underwriting dossier",
        artifact: "svg",
        description: "Comprehensive risk report SVG. Tests significant overdraft and fails closed if credit limit exceeded."
      }
    ]
  });
}
