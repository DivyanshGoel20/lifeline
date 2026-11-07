import React, { Suspense, lazy } from "react";

/** next/dynamic, for Vite. The loader may give a module or a component, as in Next.js. */
export default function dynamic<P extends object>(loader: () => Promise<any>, _options?: { ssr?: boolean; loading?: () => React.ReactNode }) {
  const Lazy = lazy(async () => {
    const loaded = await loader();
    return { default: loaded?.default ?? loaded };
  });
  return function Dynamic(props: P) {
    return (
      <Suspense fallback={null}>
        <Lazy {...(props as any)} />
      </Suspense>
    );
  };
}
