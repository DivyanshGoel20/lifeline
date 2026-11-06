import { NextRequest, NextResponse } from "next/server";
import { getHuman, unauthenticated } from "@/lib/session";
import { linkWallet } from "@/lib/walletLinks";
import { readToken } from "@/lib/signedToken";
import { recordAuthFailure } from "@/lib/authReports";

/**
 * Bind the wallet that just signed in to the human World ID just proved.
 *
 * Both halves are server-issued: the session cookie the uniqueness proof
 * minted, and the signed wallet cookie from Sign-In with Ethereum. Neither can
 * be named in the request body.
 */
export async function POST(req: NextRequest) {
  const human = getHuman(req);
  if (!human) return unauthenticated();
  const claim = readToken<{ w: string }>("wallet", req.cookies.get("lifeline_wallet")?.value);
  if (!claim) {
    return NextResponse.json({ success: false, error: "Sign in with your World App wallet first." }, { status: 400 });
  }
  const linked = linkWallet(claim.w, human);
  if (!linked.ok) {
    recordAuthFailure({ step: "server:wallet-link", detail: linked.reason });
    return NextResponse.json({ success: false, error: linked.reason }, { status: 409 });
  }

  const res = NextResponse.json({ success: true, wallet: claim.w });
  res.cookies.set("lifeline_wallet", "", { path: "/", maxAge: 0 });
  return res;
}
