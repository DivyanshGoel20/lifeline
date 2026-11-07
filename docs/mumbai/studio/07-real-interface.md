Make this app Lifeline's real interface. I have uploaded the product's own files into src/, plus vite.config.ts, vercel.json, index.html, package.json and src/main.tsx. A production build of exactly these files has already passed and been compared with the live product.

Do only this:
1. Delete the old page: src/lifeline/ and src/page/. Nothing imports them any more.
2. Install the dependencies in package.json.
3. Run the production build (vite build). If something in the Studio environment breaks it, make the smallest fix. Do not change any file's behaviour, wording or styling, and do not redesign anything. These files are the product and must stay byte-for-byte unless a build error forces a change, and you must tell me about any change.
4. Keep vercel.json in the project root: /api must reach https://lifeline-arc.vercel.app.
5. In AGENTS.md, replace "What This App Does" with: Lifeline gives AI agents a credit line backed by one World ID-verified human. This app is Lifeline's interface, brought into Arc Studio from the existing product. Its API runs at https://lifeline-arc.vercel.app.
6. Publish or update the share link's deployment if you are able to, and tell me plainly if that is a step I must do in the web workspace.

No audits and no new features. Never put keys in your reply.
