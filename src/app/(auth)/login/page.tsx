import { LoginView, type Mode } from "./login-view";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; next?: string }>;
}) {
  const { mode, next } = await searchParams;
  const initialMode: Mode = mode === "signup" ? "signup" : "signin";
  // Validated again in the action -- this only keeps a bogus value out of the markup.
  const safeNext = typeof next === "string" && /^\/convite\/[A-Za-z0-9_-]{43}$/.test(next) ? next : null;
  return <LoginView initialMode={initialMode} next={safeNext} />;
}
