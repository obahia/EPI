import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "@/app/(auth)/login/page";

// Note: DashboardPage is now an async Server Component (reads the session, redirects if
// unauthenticated) and Next.js's own Vitest guide states async Server Components are not
// supported by Vitest -- "we recommend using E2E tests for async components." LoginPage
// stays a Client Component precisely so its rendering is still unit-testable here; the
// authenticated dashboard flow is covered by Playwright E2E instead (FASE 1, once a test
// Supabase project/mocking strategy exists).
describe("LoginPage", () => {
  it("renders the sign-in form", () => {
    render(<LoginPage />);
    // shadcn's CardTitle renders a styled <div>, not a semantic heading element, so this
    // asserts on text content rather than the "heading" accessible role.
    expect(screen.getByText("Entrar", { selector: '[data-slot="card-title"]' })).toBeDefined();
    expect(screen.getByLabelText("E-mail")).toBeDefined();
    expect(screen.getByLabelText("Senha")).toBeDefined();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDefined();
  });
});
