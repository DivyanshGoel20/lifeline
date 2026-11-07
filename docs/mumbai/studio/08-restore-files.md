Restore the product files exactly. I have uploaded fresh copies of five files your lint step changed, plus vite.config.ts and src/types.ts.

Do only this:
1. Run the production build (vite build) and report whether it passes.
2. Do NOT run `bun run check`, `bun run lint`, oxlint or any formatter, and do not edit any file under src/. They rewrite the product's files, and these must stay byte-for-byte.
3. If the build fails, do not fix it. Tell me the error.

No audits and no new features. Never put keys in your reply.
