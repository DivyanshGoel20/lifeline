import fs from "./storeFs";
import path from "path";
import { writeJsonAtomic } from "./atomicWrite";

/**
 * What each mandate has borrowed so far. A mandate's cap is for the life of
 * the token, not per purchase: without this, a $1 card could draw $1 again
 * and again until the whole line was gone.
 */
function file(): string {
  const candidates = [
    path.resolve(process.cwd(), "web", "data", "mandate-spend.json"),
    path.resolve(process.cwd(), "data", "mandate-spend.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? candidates[0] : candidates[1];
}
const read = (): Record<string, number> => {
  try {
    return fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
};

export const mandateSpent = (id: string) => read()[id] ?? 0;

export function recordMandateSpend(id: string | undefined, usd: number) {
  if (!id || !(usd > 0)) return;
  const all = read();
  all[id] = Math.round(((all[id] ?? 0) + usd) * 1e6) / 1e6;
  writeJsonAtomic(file(), all);
}
