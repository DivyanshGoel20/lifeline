import fs from "@/lib/storeFs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getHuman, unauthenticated } from "@/lib/session";
import { isConfigured, reportAddress } from "@/lib/intercepta";
import { writeJsonAtomic } from "@/lib/atomicWrite";

/**
 * Report an address to Intercepta as misclassified.
 *
 * A signed-in human only - an agent's mandate cannot - because a report feeds
 * Intercepta's threat data, which other wallets and apps rely on. Held to a
 * few an hour per human, and every report is kept here with who filed it.
 */
type Report = { human: string; address: string; kind: "malicious" | "safe"; message: string; at: number; accepted: boolean; reply?: string };

const PER_HOUR = 10;
const file = () => {
  const c = [path.resolve(process.cwd(), "web", "data", "intercepta-reports.json"), path.resolve(process.cwd(), "data", "intercepta-reports.json")];
  for (const f of c) if (fs.existsSync(f)) return f;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? c[0] : c[1];
};
const read = (): Report[] => {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : [];
  } catch {
    return [];
  }
};

/** Reports this human has filed. */
export async function GET(req: NextRequest) {
  const human = getHuman(req);
  if (!human) return unauthenticated();
  return NextResponse.json({ reports: read().filter((r) => r.human.toLowerCase() === human.toLowerCase()) });
}

export async function POST(req: NextRequest) {
  const human = getHuman(req);
  if (!human) return unauthenticated();
  if (!isConfigured()) return NextResponse.json({ success: false, error: "INTERCEPTA_API_KEY is not set." }, { status: 503 });

  const { address, kind, note } = await req.json().catch(() => ({}));
  if (typeof address !== "string" || !isAddress(address)) {
    return NextResponse.json({ success: false, error: "Not an EVM address." }, { status: 400 });
  }
  if (kind !== "malicious" && kind !== "safe") {
    return NextResponse.json({ success: false, error: "kind must be malicious or safe" }, { status: 400 });
  }
  const all = read();
  const recent = all.filter((r) => r.human.toLowerCase() === human.toLowerCase() && r.at > Date.now() - 3_600_000);
  if (recent.length >= PER_HOUR) {
    return NextResponse.json({ success: false, error: "That is enough reports for an hour." }, { status: 429 });
  }

  const detail = typeof note === "string" ? note.trim().slice(0, 500) : "";
  const message =
    (kind === "malicious"
      ? "Reported as malicious: Intercepta did not flag it."
      : "Reported as safe: Intercepta flagged it wrongly.") + (detail ? ` ${detail}` : "") + " (via Lifeline)";

  let accepted = false;
  let reply: string | undefined;
  try {
    const r = await reportAddress(address, message);
    accepted = r.data?.success !== false;
    reply = r.data?.message;
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? "Intercepta did not take the report." }, { status: 502 });
  }
  writeJsonAtomic(file(), [...all, { human, address: address.toLowerCase(), kind, message, at: Date.now(), accepted, reply }]);
  return NextResponse.json({ success: accepted, message: reply ?? "Reported." });
}
