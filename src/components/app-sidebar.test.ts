import { describe, expect, it } from "vitest";
import { activeNavHref } from "./app-sidebar";

// Exactly one nav row may light up at a time. Two paths have historically broken that:
// the company dashboard (lives under /companies but IS "Painel") and the batches list
// (lives under /deliveries but IS "Lotes").
describe("activeNavHref", () => {
  it("gives the company dashboard to Painel, not to Empresas", () => {
    expect(activeNavHref("/companies/9f1c/dashboard")).toBe("/dashboard");
  });

  it("still gives the companies list itself to Empresas", () => {
    expect(activeNavHref("/companies")).toBe("/companies");
    expect(activeNavHref("/companies/9f1c")).toBe("/companies");
  });

  it("gives the batches list to Lotes, not to Entregas", () => {
    expect(activeNavHref("/deliveries/batches")).toBe("/deliveries/batches");
    expect(activeNavHref("/deliveries/batches/7a20")).toBe("/deliveries/batches");
  });

  it("gives other delivery routes to Entregas", () => {
    expect(activeNavHref("/deliveries")).toBe("/deliveries");
    expect(activeNavHref("/deliveries/7a20")).toBe("/deliveries");
    expect(activeNavHref("/deliveries/batch/new")).toBe("/deliveries");
  });

  it("matches the remaining sections on their own subtrees", () => {
    expect(activeNavHref("/dashboard")).toBe("/dashboard");
    expect(activeNavHref("/employees/import")).toBe("/employees");
    expect(activeNavHref("/epis/3b81")).toBe("/epis");
  });

  it("lights nothing up outside the rail", () => {
    expect(activeNavHref("/login")).toBeNull();
    expect(activeNavHref("/verify/ABC123")).toBeNull();
    // A path that merely starts with the same characters is not inside the subtree.
    expect(activeNavHref("/employees-archive")).toBeNull();
  });
});
