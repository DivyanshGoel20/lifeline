import { NextRequest, NextResponse } from "next/server";
import { verifySiweMessage } from "@worldcoin/minikit-js/siwe";
import type { MiniAppWalletAuthSuccessPayload } from "@worldcoin/minikit-js/commands";
import { attachSession } from "@/lib/session";
import { humanForWallet } from "@/lib/walletLinks";
import { mintToken } from "@/lib/signedToken";
import { recordAuthFailure } from "@/lib/authReports";

const WALLET_COOKIE = "lifeline_wallet";

/**
 * Sign in from World App with the wallet.
 *
 * Verifies MiniKit's Sign-In with Ethereum against the nonce this server
 * issued. A wallet already linked to a human signs that human in. An unlinked
 * one is remembered for a few minutes in a signed cookie, so the next step -
 * World ID's proof of who the human is - can bind it.
 */
export async function POST(req: NextRequest) {
  const { payload } = (await req.json().catch(() => ({}))) as { payload?: MiniAppWalletAuthSuccessPayload };
  const nonce = req.cookies.get("lifeline_siwe")?.value;
  if (!payload || !nonce) {
    return NextResponse.json({ verified: false, error: "Start sign-in again: the nonce is missing." }, { status: 400 });
  }

  let wallet: string;
  try {
    const { isValid, siweMessageData } = await verifySiweMessage(payload, nonce);
    if (!isValid || !siweMessageData.address) throw new Error("Signature did not verify");
    wallet = siweMessageData.address;
  } catch (err: any) {
    recordAuthFailure({ step: "server:wallet", detail: err?.message });
    return NextResponse.json({ verified: false, error: err?.message ?? "Wallet sign-in failed" }, { status: 400 });
  }

  const human = humanForWallet(wallet);
  const res = NextResponse.json(
    human ? { verified: true, linked: true, nullifierHash: human, wallet } : { verified: true, linked: false, wallet }
  );
  res.cookies.set("lifeline_siwe", "", { path: "/", maxAge: 0 });
  if (human) return attachSession(res, human);

  res.cookies.set(WALLET_COOKIE, mintToken("wallet", { w: wallet }, 15 * 60), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 15 * 60,
  });
  return res;
}
