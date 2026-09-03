import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginView } from "@/app/(auth)/login/login-view";
import { I18nProvider } from "@/i18n/provider";
import { getDictionary } from "@/i18n/dictionaries";

// Note: page.tsx is now an async Server Component (it awaits `searchParams` to pick the
// initial sign-in/sign-up mode for the landing page's "Começar grátis" deep link), and
// Next.js's own Vitest guide states async Server Components are not supported by Vitest --
// "we recommend using E2E tests for async components." LoginView is the Client Component
// page.tsx renders, kept separate precisely so it stays unit-testable here; the
// authenticated dashboard flow is covered by Playwright E2E instead (FASE 1, once a test
// Supabase project/mocking strategy exists).
describe("LoginView", () => {
  it("renders the sign-in form", () => {
    render(
      <I18nProvider locale="pt" dict={getDictionary("pt")}>
        <LoginView initialMode="signin" />
      </I18nProvider>,
    );
    // The mockup's login (screen 4a) leads with the product headline, not with the word
    // "Entrar" -- that is the submit button, asserted below.
    expect(screen.getByRole("heading", { name: "Prova de entrega de EPI, selada." })).toBeDefined();
    expect(screen.getByLabelText("E-mail")).toBeDefined();
    expect(screen.getByLabelText("Senha")).toBeDefined();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDefined();
    expect(screen.getByLabelText("Lembrar de mim")).toBeDefined();
    expect(screen.getByRole("link", { name: "Esqueceu a senha?" })).toBeDefined();
  });
});
