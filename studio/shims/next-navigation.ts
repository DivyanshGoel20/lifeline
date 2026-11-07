/** next/navigation, for Vite: what Lifeline's pages use of it, over the browser's history. */
const go = (url: string, replace: boolean) => {
  window.history[replace ? "replaceState" : "pushState"](null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

const router = {
  push: (url: string) => go(url, false),
  replace: (url: string) => go(url, true),
  back: () => window.history.back(),
  refresh: () => window.location.reload(),
};

export const useRouter = () => router;
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
