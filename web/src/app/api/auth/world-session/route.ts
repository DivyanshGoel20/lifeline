import { NextRequest, NextResponse } from "next/server";
import { verifyWorldSelfieProof } from "@/lib/world";
import { attachSession, getHuman, rememberedAccount } from "@/lib/session";
import { bindSession, humanForSession, sessionForHuman, spendNullifier } from "@/lib/worldSessions";
import { readToken } from "@/lib/signedToken";
import { recordAuthFailure } from "@/lib/authReports";

export const dynamic = "force-dynamic";

/**
 * Which World ID session to ask this device for.
 *
 * A browser that has signed in before remembers its account; World App opened
 * from the dashboard's link carries it in a signed token. Either way the
 * answer is only which session to prove - signing in still takes the proof.
 */
export async function GET(req: NextRequest) {
  const link = new URL(req.url).searchParams.get("link");
  const human = link ? readToken<{ h: string }>("link", link)?.h ?? null : rememberedAccount(req);
  if (link && !human) {
    return NextResponse.json({ sessionId: null, error: "That link has expired. Open Lifeline in World App from the dashboard again." }, { status: 400 });
  }
  return NextResponse.json({ sessionId: human ? sessionForHuman(human) : null });
}

/**
 * Verify a World ID session proof.
 *
 * A session already bound to a human signs that human in. A new session is
 * bound only to the human who has just proved uniqueness on this device - the
 * signed session cookie says who - and never replaces one they already have.
 */
export async function POST(req: NextRequest) {
  const { result } = (await req.json().catch(() => ({}))) as { result?: any };
  const sessionId: string | undefined = result?.session_id;
  if (!sessionId || !Array.isArray(result?.responses)) {
    return NextResponse.json({ verified: false, error: "Not a World ID session proof." }, { status: 400 });
  }

  const verification = await verifyWorldSelfieProof(result, undefined, { allowSession: true });
  if (!verification.success) {
    recordAuthFailure({ step: "server:world-session", code: verification.code, detail: verification.error });
    return NextResponse.json({ verified: false, error: verification.error, code: verification.code }, { status: 400 });
  }

  const nullifier = String(result.responses[0]?.session_nullifier?.[0] ?? "");
  if (!nullifier) return NextResponse.json({ verified: false, error: "The proof carries no session nullifier." }, { status: 400 });
  if (!spendNullifier(nullifier)) {
    return NextResponse.json({ verified: false, error: "That proof has already been used.", code: "proof_replayed" }, { status: 400 });
  }

  let human = humanForSession(sessionId);
  if (!human) {
    const joining = getHuman(req);
    if (!joining) {
      return NextResponse.json(
        { verified: false, error: "This World ID session is not linked to a Lifeline account.", code: "unknown_session" },
        { status: 400 }
      );
    }
    const bound = bindSession(joining, sessionId);
    if (!bound.ok) return NextResponse.json({ verified: false, error: bound.reason }, { status: 409 });
    human = joining;
  }

  return attachSession(NextResponse.json({ verified: true, nullifierHash: human }), human);
}
