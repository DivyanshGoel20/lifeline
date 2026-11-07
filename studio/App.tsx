import React, { useEffect, useState } from "react";
import Home from "@/app/page";
import Arc from "@/app/arc/page";
import Sui from "@/app/sui/page";
import Mini from "@/app/mini/page";
import Connect from "@/app/connect/[code]/page";
import Whitechain from "@/app/whitechain/page";
import WhitechainMerchant from "@/app/whitechain/merchant/page";

/**
 * Lifeline's pages, in Arc Studio. These are the product's own page files. Next.js picks
 * them by folder, and this does the same by path, because Studio's app is Vite.
 */
function page(path: string): React.ReactNode {
  const p = path.replace(/\/$/, "") || "/";
  if (p === "/") return <Home />;
  if (p === "/arc") return <Arc />;
  if (p === "/sui") return <Sui />;
  if (p === "/mini" || p === "/mini/mini") return <Mini />;
  if (p === "/whitechain") return <Whitechain />;
  if (p === "/whitechain/merchant") return <WhitechainMerchant />;
  const connect = p.match(/^\/connect\/([^/]+)$/);
  if (connect) return <Connect params={{ code: decodeURIComponent(connect[1]) }} />;
  return <Home />;
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return <>{page(path)}</>;
}
