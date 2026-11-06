import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData, formatUnits, isAddress, parseAbi, parseUnits } from "viem";
import { getPublicClient } from "@/lib/facilityContract";

export const dynamic = "force-dynamic";

const POOL_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function cash() view returns (uint256)",
  "function outstanding() view returns (uint256)",
  "function exposureCap() view returns (uint256)",
  "function maxUtilizationBps() view returns (uint256)",
  "function utilizationBps() view returns (uint256)",
  "function drawable() view returns (uint256)",
  "function totalInterestEarned() view returns (uint256)",
  "function totalWrittenOff() view returns (uint256)",
  "function assetsOf(address lender) view returns (uint256)",
  "function deposit(uint256 assets) returns (uint256)",
  "function withdraw(uint256 assets) returns (uint256)",
]);
const USDC = "0x3600000000000000000000000000000000000000";
const APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const usd = (n: bigint) => Number(formatUnits(n, 6));

/** The lending pool's position, from the chain. Public: lenders decide on this. */
export async function GET(req: NextRequest) {
  const address = process.env.LIFELINE_LENDING_POOL_ADDRESS as `0x${string}` | undefined;
  if (!address) return NextResponse.json({ configured: false });

  const lender = new URL(req.url).searchParams.get("lender");
  if (lender && !isAddress(lender)) return NextResponse.json({ error: "lender must be an address." }, { status: 400 });

  try {
    const client = getPublicClient();
    const read = (functionName: any, args: any[] = []) => client.readContract({ address, abi: POOL_ABI, functionName, args } as any) as Promise<bigint>;
    const [totalAssets, cash, outstanding, exposureCap, maxUtilizationBps, utilizationBps, drawable, interest, writtenOff] = await Promise.all([
      read("totalAssets"),
      read("cash"),
      read("outstanding"),
      read("exposureCap"),
      read("maxUtilizationBps"),
      read("utilizationBps"),
      read("drawable"),
      read("totalInterestEarned"),
      read("totalWrittenOff"),
    ]);
    return NextResponse.json({
      configured: true,
      pool: address,
      totalAssetsUsd: usd(totalAssets),
      cashUsd: usd(cash),
      outstandingUsd: usd(outstanding),
      exposureCapUsd: usd(exposureCap),
      maxUtilizationBps: Number(maxUtilizationBps),
      utilizationBps: Number(utilizationBps),
      drawableUsd: usd(drawable),
      interestEarnedUsd: usd(interest),
      writtenOffUsd: usd(writtenOff),
      ...(lender ? { lenderAssetsUsd: usd(await read("assetsOf", [lender])) } : {}),
    });
  } catch (err: any) {
    return NextResponse.json({ configured: true, error: err?.shortMessage ?? err?.message ?? "Could not read the pool" }, { status: 502 });
  }
}

/**
 * The transactions a lender signs to put money in or take it out. Lifeline only
 * says what to sign; the lender's own wallet moves the money.
 */
export async function POST(req: NextRequest) {
  const address = process.env.LIFELINE_LENDING_POOL_ADDRESS as `0x${string}` | undefined;
  if (!address) return NextResponse.json({ success: false, error: "The lending pool is not set up." }, { status: 503 });

  const { action, amountUsd } = await req.json().catch(() => ({} as any));
  const amount = Number(amountUsd);
  if (!(amount > 0)) return NextResponse.json({ success: false, error: "amountUsd must be positive." }, { status: 400 });
  const assets = parseUnits(amount.toFixed(6), 6);

  if (action === "deposit") {
    return NextResponse.json({
      success: true,
      calls: [
        { to: USDC, data: encodeFunctionData({ abi: APPROVE, functionName: "approve", args: [address, assets] }), description: "Allow the pool to take this USDC" },
        { to: address, data: encodeFunctionData({ abi: POOL_ABI, functionName: "deposit", args: [assets] }), description: "Deposit" },
      ],
    });
  }
  if (action === "withdraw") {
    return NextResponse.json({
      success: true,
      calls: [{ to: address, data: encodeFunctionData({ abi: POOL_ABI, functionName: "withdraw", args: [assets] }), description: "Withdraw" }],
    });
  }
  return NextResponse.json({ success: false, error: "action must be deposit or withdraw." }, { status: 400 });
}
