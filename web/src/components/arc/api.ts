/** Same-origin base. Change only here if the API ever moves. */
export const api = (path: string) => path;

type Transport = (input: string, init?: RequestInit) => Promise<Response>;

let transport: Transport = (input, init) => fetch(input, init);

/** Replace how requests are made (the Studio demo page uses this for sample data). */
export function setTransport(next: Transport | null) {
  transport = next ?? ((input, init) => fetch(input, init));
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function read<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body).error === "string"
        ? (body as { error: string }).error
        : `Lifeline answered ${res.status}.`;
    throw new ApiError(message, res.status);
  }
  if (body === null) throw new ApiError("Lifeline sent an answer this page could not read.", res.status);
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await transport(api(path), { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError("Could not reach Lifeline.", 0);
  }
  return read<T>(res);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await transport(api(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach Lifeline.", 0);
  }
  return read<T>(res);
}

const DECLINED = "You declined in your wallet. Nothing was sent.";

function codeOf(err: unknown): unknown {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; cause?: unknown };
    if (e.code === 4001 || e.code === "ACTION_REJECTED") return 4001;
    if (e.cause) return codeOf(e.cause);
  }
  return undefined;
}

/** One sentence for any failure. A wallet decline (4001) is never an error. */
export function describeError(err: unknown): string {
  if (codeOf(err) === 4001) return DECLINED;
  if (err instanceof Error && err.message) {
    if (/LockedUp/.test(err.message)) return "This deposit is still locked. Try again after the lock ends.";
    return err.message.length > 220 ? `${err.message.slice(0, 220)}…` : err.message;
  }
  return "Something went wrong. Nothing was changed.";
}

export const isDecline = (err: unknown) => codeOf(err) === 4001;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A price, with enough decimals that a fraction of a cent does not read as free. */
export const price = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : usd(n));

/** A positive amount with at most 6 decimals, or null. */
export function parseAmount(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
