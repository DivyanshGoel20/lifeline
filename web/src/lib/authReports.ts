import path from "path";
import fs from "./storeFs";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * Why sign-ins failed, kept so a failure on someone's phone can be diagnosed.
 *
 * World App has no console to read and hosted logs do not last. Only the step, the
 * error code and a short message are kept: never a proof, a signature or a cookie.
 */
export type AuthReport = { at: number; step: string; code?: string; detail?: string };

const KEEP = 100;

function file(): string {
  const c = [path.resolve(process.cwd(), "web", "data", "auth-reports.json"), path.resolve(process.cwd(), "data", "auth-reports.json")];
  for (const f of c) if (fs.existsSync(f)) return f;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? c[0] : c[1];
}

export function readAuthReports(): AuthReport[] {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : [];
  } catch {
    return [];
  }
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);

/** Never throws: failing to record a failure must not change what the person sees. */
export function recordAuthFailure(r: { step: unknown; code?: unknown; detail?: unknown }): void {
  try {
    const row: AuthReport = { at: Date.now(), step: clip(r.step, 60) ?? "unknown", code: clip(r.code, 80), detail: clip(r.detail, 300) };
    writeJsonAtomic(file(), [...readAuthReports(), row].slice(-KEEP));
  } catch (err: any) {
    console.warn("[auth-report] Could not record:", err?.message ?? err);
  }
}
