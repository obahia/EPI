import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      // See src/test/stubs/server-only.ts: Vitest has no equivalent of Next's real
      // client/server compiler split, so a Client Component that transitively imports a
      // Server Action trips server-only's guard for no real reason -- npm run build is
      // what actually proves the boundary holds.
      "server-only": new URL("./src/test/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live in e2e/ and use @playwright/test, not vitest —
    // keep the two runners from picking up each other's files.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
