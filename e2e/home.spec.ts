import { test, expect } from "@playwright/test";

test("home page renders the FASE 0 placeholder", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Plataforma de Entrega Digital de EPI" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Entrar" })).toBeVisible();
});
