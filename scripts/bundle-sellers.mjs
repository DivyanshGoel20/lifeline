// Bundles each seller into one file for Vercel, whose TypeScript step cannot
// resolve this repo's extensionless imports under Node's ES modules.
// Run before deploying a seller. The output is generated, so it is not committed.
import { build } from "esbuild";

const banner = `import { createRequire as __cr } from "module";
import { fileURLToPath as __fu } from "url";
import { dirname as __dn } from "path";
const require = __cr(import.meta.url);
const __filename = __fu(import.meta.url);
const __dirname = __dn(__filename);`;

for (const [entry, outfile] of [
  ["premium-api/server.ts", "premium-api/api/index.mjs"],
  ["sui/service/server.ts", "sui/api/index.mjs"],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: banner },
    tsconfig: "web/tsconfig.json",
    alias: { "@": new URL("../web/src", import.meta.url).pathname },
    logLevel: "warning",
  });
  console.log("bundled", outfile);
}
