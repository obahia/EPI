import { LoginView, type Mode } from "./login-view";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  const initialMode: Mode = mode === "signup" ? "signup" : "signin";
  return <LoginView initialMode={initialMode} />;
}
