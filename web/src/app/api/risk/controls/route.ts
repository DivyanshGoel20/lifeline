import { NextResponse } from "next/server";
import { riskStatus } from "@/lib/riskControls";

export const dynamic = "force-dynamic";

/**
 * How much Lifeline has out, against its limits, and whether new credit is
 * paused. Totals only, nothing about anyone: lenders and borrowers should be
 * able to see this without an account.
 */
export async function GET() {
  return NextResponse.json(riskStatus());
}
