"use client";

import { useEffect } from "react";

/** A script from an older deployment: the page open across a release asks for files that are gone. */
const isStaleBuild = (error: Error) => /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module/i.test(`${error?.name} ${error?.message}`);
const RELOADED = "lifeline_reloaded_for_new_build";

/**
 * The last resort, when the app itself fails to start. Without it, a page open across a
 * deployment could be left blank. One automatic reload picks up the new build; anything
 * else says what happened and offers a way back.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    if (!isStaleBuild(error)) return;
    try {
      if (sessionStorage.getItem(RELOADED)) return;
      sessionStorage.setItem(RELOADED, "1");
    } catch {
      return;
    }
    window.location.reload();
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#f3eee5", color: "#1b1613", fontFamily: "Georgia, serif", padding: 24 }}>
        <div style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: 30, fontWeight: 400, margin: "0 0 12px" }}>Lifeline could not load this page.</h1>
          <p style={{ fontFamily: "system-ui, sans-serif", fontSize: 14, lineHeight: 1.5, margin: "0 0 20px" }}>
            Nothing was paid or changed. Reloading usually fixes it.
          </p>
          <button
            onClick={() => {
              reset();
              window.location.reload();
            }}
            style={{ background: "#1b1613", color: "#f3eee5", border: 0, padding: "10px 16px", cursor: "pointer", fontSize: 13 }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
