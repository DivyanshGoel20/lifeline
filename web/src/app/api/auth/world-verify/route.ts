import { NextRequest, NextResponse } from "next/server";
import { verifyWorldSelfieProof } from "@/lib/world";
import { ensureHumanProfileOnChain } from "@/lib/facilityContract";
import { attachSession } from "@/lib/session";
import { recordAuthFailure } from "@/lib/authReports";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const proofPayload = body.idkitResponse || body.result || body.proof || body;

    const verification = await verifyWorldSelfieProof(proofPayload, body.signal);

    if (!verification.success) {
      recordAuthFailure({ step: "server:world-verify", code: verification.code, detail: verification.error });
      return NextResponse.json(
        { verified: false, error: verification.error, code: verification.code },
        { status: 400 }
      );
    }

    // Fail closed. Without a nullifier there is no way to say which human this
    // is, and a guessed identity would void one-human-one-credit-line.
    const nullifierHash: string | undefined = verification.nullifier;

    if (!nullifierHash) {
      return NextResponse.json(
        {
          verified: false,
          error: "Verification succeeded but no nullifier was returned; cannot identify the human",
          code: "missing_nullifier",
        },
        { status: 400 }
      );
    }

    // Verification can succeed while the chain write fails. Say so rather than
    // swallowing it: the human has no credit profile yet, and the dashboard
    // should know why agents cannot be authorised.
    let profileProvisioned = true;
    let profileError: string | undefined;
    try {
      await ensureHumanProfileOnChain(nullifierHash);
    } catch (profileErr: any) {
      profileProvisioned = false;
      profileError = profileErr?.message || String(profileErr);
      console.warn("[World-Verify] Could not provision on-chain profile:", profileError);
    }

    // The proof is the only thing that mints a session. The cookie is signed,
    // so every route that spends reads the human from it rather than from a
    // value the browser could have typed.
    return attachSession(
      NextResponse.json({
        verified: true,
        success: true,
        nullifierHash,
        credential: "Proof of Human (World ID)",
        profileProvisioned,
        ...(profileError ? { profileError } : {}),
      }),
      nullifierHash
    );
  } catch (error: any) {
    console.error("[World-Verify] Error:", error);
    return NextResponse.json(
      { verified: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
