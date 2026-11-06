import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { attachSession, signPayload } from "@/lib/session";
import { ensureHumanProfileOnChain } from "@/lib/facilityContract";
import { allow, clientIp } from "@/lib/rateLimit";
import { worldBypassed } from "@/lib/worldBypass";

export const dynamic = "force-dynamic";

const COOKIE = "lifeline_test_account";
const YEAR = 60 * 60 * 24 * 365;
const signed = (human: string) => signPayload(`test-account:${human}`);

function remembered(req: NextRequest): string | null {
  const [human, signature] = (req.cookies.get(COOKIE)?.value ?? "").split(".");
  if (!human || !signature) return null;
  const expected = Buffer.from(signed(human));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? human : null;
}

/**
 * A test account, with World ID switched off (see worldBypass). This browser keeps the
 * same account when it comes back. It does not exist at all unless the switch is on.
 */
export async function POST(req: NextRequest) {
  if (!worldBypassed()) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let human = remembered(req);
  if (!human) {
    if (!allow(`test-session:${clientIp(req)}`, 10, 60 * 60_000)) {
      return NextResponse.json({ verified: false, error: "Too many test accounts. Try again in an hour." }, { status: 429 });
    }
    human = `0x${crypto.randomBytes(32).toString("hex")}`;
  }

  let profileError: string | undefined;
  try {
    await ensureHumanProfileOnChain(human);
  } catch (err: any) {
    profileError = err?.shortMessage ?? err?.message ?? String(err);
  }

  const res = attachSession(
    NextResponse.json({ verified: !profileError, nullifierHash: human, ...(profileError ? { error: `The credit profile could not be created: ${profileError}` } : {}) }),
    human
  );
  res.cookies.set(COOKIE, `${human}.${signed(human)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: YEAR,
  });
  return res;
}
