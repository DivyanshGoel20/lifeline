import fs from "fs";
import path from "path";
import storeFs, { usesRedis } from "./storeFs";

/**
 * Write JSON to disk without leaving a half-written file behind.
 *
 * These stores are read-modify-write, so concurrent requests can still lose an
 * update - that race needs a real database, not a lock file. What this does
 * prevent is a crash or an overlapping write truncating the store to invalid
 * JSON and taking every loan record with it.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  if (usesRedis() && storeFs.isLedger(filePath)) return storeFs.writeLedger(filePath, JSON.stringify(data));

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath); // atomic on POSIX
}
