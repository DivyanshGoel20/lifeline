import { NextRequest, NextResponse } from "next/server";
import { formatUnits, isAddress, parseAbi } from "viem";
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
]);
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
