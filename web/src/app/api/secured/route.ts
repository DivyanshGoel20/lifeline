import { NextRequest, NextResponse } from "next/server";
import { isAddress, verifyMessage } from "viem";
import { getHuman, unauthenticated } from "@/lib/session";
import { humanForWallet, linkWallet } from "@/lib/walletLinks";
import { invalidateTelemetryCache } from "@/lib/telemetryCache";
import { getHumanFacilityStats } from "@/lib/agentStore";
import {
  bindDepositWallet,
  cancelWithdrawalCalls,
  depositCalls,
  linkMessage,
  syncCollateral,
  vaultAddress,
  withdrawalCalls,
} from "@/lib/securedLine";

export const dynamic = "force-dynamic";

/**
 * A human's deposit-backed credit. The wallet signs deposits and withdrawals
 * itself; Lifeline never holds this money. These calls say what to sign, connect
 * the wallet to the human, and bring the line in step after a change.
 */
export async function GET(req: NextRequest) {
  const human = getHuman(req);
  if (!human) return unauthenticated();
  if (!vaultAddress()) return NextResponse.json({ configured: false });
  try {
    const state = await syncCollateral(human);
    return NextResponse.json({ configured: true, vault: vaultAddress(), ...state, line: getHumanFacilityStats(human) });
  } catch (err: any) {
    return NextResponse.json({ configured: true, error: err?.shortMessage ?? err?.message ?? "Could not read the vault" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const human = getHuman(req);
  if (!human) return unauthenticated();
  if (!vaultAddress()) {
    return NextResponse.json({ success: false, error: "Deposit-backed credit is not set up." }, { status: 503 });
  }

  const { action, wallet, amountUsd, to, signature } = await req.json().catch(() => ({} as any));
  const amount = Number(amountUsd);

  try {
    switch (action) {
      // A wallet from the browser, proving it is its owner's with a signature
      // over a nonce this server issued.
      case "link": {
        const nonce = req.cookies.get("lifeline_siwe")?.value;
        if (!nonce || !isAddress(wallet ?? "") || !signature) {
          return NextResponse.json({ success: false, error: "Start again: wallet, signature and a fresh nonce are needed." }, { status: 400 });
        }
        const valid = await verifyMessage({ address: wallet, message: linkMessage(nonce), signature }).catch(() => false);
        if (!valid) return NextResponse.json({ success: false, error: "That signature is not from this wallet." }, { status: 400 });
        const linked = linkWallet(wallet, human);
        if (!linked.ok) return NextResponse.json({ success: false, error: linked.reason }, { status: 409 });
        const res = NextResponse.json({ success: true, wallet });
        res.cookies.set("lifeline_siwe", "", { path: "/", maxAge: 0 });
        return res;
      }
      // Only a wallet this human has already proved is theirs can control the
      // deposit, or anyone signed in could claim a deposit by naming a wallet.
      case "bind": {
        if (!isAddress(wallet ?? "")) return NextResponse.json({ success: false, error: "wallet must be an address." }, { status: 400 });
        const owner = humanForWallet(wallet);
        if (!owner || owner.toLowerCase() !== human.toLowerCase()) {
          return NextResponse.json({ success: false, error: "Link this wallet to your account first." }, { status: 403 });
        }
        return NextResponse.json({ success: true, ...(await bindDepositWallet(human, wallet)) });
      }
      case "deposit":
        if (!(amount > 0)) return NextResponse.json({ success: false, error: "amountUsd must be positive." }, { status: 400 });
        return NextResponse.json({ success: true, calls: depositCalls(human, amount) });
      case "withdraw":
        if (!(amount > 0) || !isAddress(to ?? "")) {
          return NextResponse.json({ success: false, error: "amountUsd must be positive and to an address." }, { status: 400 });
        }
        return NextResponse.json({ success: true, calls: withdrawalCalls(human, amount, to) });
      case "cancel":
        return NextResponse.json({ success: true, calls: cancelWithdrawalCalls(human) });
      case "sync": {
        const state = await syncCollateral(human);
        invalidateTelemetryCache(human);
        return NextResponse.json({ success: true, ...state, line: getHumanFacilityStats(human) });
      }
      default:
        return NextResponse.json({ success: false, error: "action must be link, bind, deposit, withdraw, cancel or sync." }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.shortMessage ?? err?.message ?? "The vault refused that" }, { status: 502 });
  }
}
