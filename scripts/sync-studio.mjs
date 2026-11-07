// Copies Lifeline's real interface into an Arc Studio project, so Studio runs the product's
// own files rather than a look-alike. Run with an output folder:
//
//   node scripts/sync-studio.mjs <studio-project-folder>
//
// Which files go is worked out from the imports, starting at the pages, so nothing is
// listed by hand. The backend stays in web/: Studio's app calls it through vercel.json.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const web = path.join(root, "web");
const out = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Say where the Studio project is.");

const pages = ["page.tsx", "arc/page.tsx", "sui/page.tsx", "mini/page.tsx", "connect/[code]/page.tsx", "whitechain/page.tsx", "whitechain/merchant/page.tsx", "providers.tsx"];
const result = await build({
  entryPoints: pages.map((p) => path.join(web, "src/app", p)),
  bundle: true,
  write: false,
  metafile: true,
  outdir: "/tmp/unused",
  format: "esm",
  platform: "browser",
  logLevel: "silent",
  jsx: "automatic",
  tsconfig: path.join(web, "tsconfig.json"),
  external: ["next/*"],
  loader: { ".css": "empty" },
});

const own = Object.keys(result.metafile.inputs)
  .map((f) => path.resolve(root, f))
  .filter((f) => f.startsWith(path.join(web, "src")) && !f.includes("node_modules"));

const copied = [];
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied.push(path.relative(out, to));
};
// Type-only imports leave no trace in a bundle, so the shared types are named here.
for (const f of new Set([...own, path.join(web, "src/app/globals.css"), path.join(web, "src/types/index.ts")].filter((f) => fs.existsSync(f)))) copy(f, path.join(out, path.relative(web, f)));
copy(path.join(root, "studio/App.tsx"), path.join(out, "src/App.tsx"));
copy(path.join(root, "studio/shims/next-dynamic.tsx"), path.join(out, "src/shims/next-dynamic.tsx"));
copy(path.join(root, "studio/shims/next-navigation.ts"), path.join(out, "src/shims/next-navigation.ts"));
copy(path.join(root, "studio/vercel.json"), path.join(out, "vercel.json"));
if (fs.existsSync(path.join(web, "public/icon.svg"))) copy(path.join(web, "public/icon.svg"), path.join(out, "public/icon.svg"));


// Studio's own shell stays (its wallet providers and "Built with Arc Studio" mark). It only
// needs to load Lifeline's styles and providers, and its dependencies.
copy(path.join(root, "studio/vite.config.ts"), path.join(out, "vite.config.ts"));
const edit = (rel, fn) => {
  const p = path.join(out, rel);
  if (fs.existsSync(p)) fs.writeFileSync(p, fn(fs.readFileSync(p, "utf8")));
};
// Safe to run again: a project that already has these is left alone.
edit("src/main.tsx", (s) =>
  s.includes("LifelineProviders")
    ? s
    : s
        .replace("import './lifeline/globals.css'", "import '@/app/globals.css'")
        .replace("import App from './App'", "import App from './App'\nimport LifelineProviders from '@/app/providers'")
        .replace("<App />", "<LifelineProviders><App /></LifelineProviders>")
);
edit("index.html", (s) =>
  s
    .replace(/<title>.*<\/title>/, "<title>Lifeline - credit for agents, on a human's pulse</title>")
    .replace(/family=Hanken\+Grotesk[^"]*"/, 'family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300;1,6..72,400&family=Hanken+Grotesk:wght@400;500;600&family=Martian+Mono:wght@300;400;500&display=swap"')
    .replace(/<body[^>]*>/, '<body class="strip">')
);
const webPkg = JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf8"));
edit("package.json", (s) => {
  const pkg = JSON.parse(s);
  for (const name of ["@circle-fin/bridge-kit", "@stripe/react-stripe-js", "@stripe/stripe-js", "@worldcoin/idkit", "@worldcoin/minikit-js", "@worldcoin/minikit-react", "qrcode"]) {
    pkg.dependencies[name] = webPkg.dependencies[name];
  }
  pkg.devDependencies["@types/qrcode"] = webPkg.devDependencies["@types/qrcode"];
  return JSON.stringify(pkg, null, 2) + "\n";
});

fs.writeFileSync(path.join(out, ".lifeline-synced-files"), copied.sort().join("\n") + "\n");
console.log(`Copied ${copied.length} files to ${out}`);
