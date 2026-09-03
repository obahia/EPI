import { test, expect } from "@playwright/test";

// The home page has carried the Selo brand since the rebrand (see
// memory/project_epi_selo_rebrand.md) -- this test still asserted the pre-rebrand FASE 0
// placeholder headline ("Plataforma de Entrega Digital de EPI") and had been failing ever
// since, silently, because it was never wired into ci.yml (audit finding TST-01).
test("home page renders the Selo landing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Selo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Entrar" })).toBeVisible();
});
