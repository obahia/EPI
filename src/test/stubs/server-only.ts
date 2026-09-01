// Stub for the `server-only` package inside Vitest. Real Next.js builds enforce the
// client/server boundary via their own compiler (the "use server" directive generates a
// client-safe RPC stub, so a Client Component that imports a Server Action never actually
// bundles next/headers/server-only code for the browser -- `npm run build` is what proves
// that, and it does). Vitest runs on plain Vite with no such transform, so importing a
// Client Component that transitively reaches a Server Action trips server-only's real
// guard for a reason that has nothing to do with an actual bug. Aliased in
// vitest.config.mts so unit tests can render those components without fighting a
// test-runner artifact.
export {};
