import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * One .env for the whole repo.
 *
 * The web app, the premium API and the Sui scripts all read the root .env, so
 * it is loaded into process.env here - never into `env:`, which inlines every
 * value into the build output and would ship PRIVATE_KEY inside .next. A value
 * already set in the environment wins, so a deploy can override the file.
 */
const rootEnvPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // On Vercel the Sui deployment records are read at run time, so they must ship.
  experimental: {
    outputFileTracingRoot: path.resolve(__dirname, ".."),
    outputFileTracingIncludes: { "/**": ["../sui/deployments/**", "../sui/lifeline/Move.toml"] },
  },
  // @lifeline/sui is the repo's own sui/ workspace, shipped as TypeScript.
  transpilePackages: ["@worldcoin/idkit", "@worldcoin/idkit-core", "@lifeline/sui"],

  // World appends a mini app path to the App URL, so an App URL that already
  // ends in /mini turns /mini into /mini/mini. Either way lands on the app.
  // The registry's authorization document, where partners' World clients point.
  async rewrites() {
    return [{ source: "/.well-known/lifeline-sector.json", destination: "/api/registry/sector" }];
  },

  async redirects() {
    return [{ source: "/mini/mini", destination: "/mini", permanent: false }];
  },
};

export default nextConfig;
