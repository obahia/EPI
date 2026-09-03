"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js. Registration is the one thing that genuinely belongs in an effect:
 * it touches a browser API, after mount, and synchronises nothing back into React state.
 *
 * Development is skipped on purpose -- a worker sitting in front of the dev server's HMR
 * navigations produces confusing stale-page reports that have nothing to do with the code
 * being written.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const timer = window.setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // An unregistrable worker costs the install prompt and the offline page, nothing
        // more -- the app itself is unaffected, so this must never surface to the user.
      });
    }, 1_000); // let the first paint finish first

    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
