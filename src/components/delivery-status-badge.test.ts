import { describe, expect, it } from "vitest";
import { getDeliveryStatusMeta } from "./delivery-status-badge";
import type { DeliveryStatus } from "@/lib/supabase/dal";

const ALL_STATUSES: DeliveryStatus[] = ["DRAFT", "ISSUED", "CONFIRMED", "CONTESTED", "CANCELLED", "SUPERSEDED"];

describe("getDeliveryStatusMeta", () => {
  it("maps every app.delivery_status enum value without throwing", () => {
    for (const status of ALL_STATUSES) {
      expect(() => getDeliveryStatusMeta(status)).not.toThrow();
    }
  });

  it("gives each status a non-empty pt-BR label", () => {
    for (const status of ALL_STATUSES) {
      expect(getDeliveryStatusMeta(status).label.length).toBeGreaterThan(0);
    }
  });

  it("maps pt-BR labels for the statuses FASE 2 actually produces", () => {
    expect(getDeliveryStatusMeta("DRAFT").label).toBe("Rascunho");
    expect(getDeliveryStatusMeta("ISSUED").label).toBe("Emitida");
    expect(getDeliveryStatusMeta("CANCELLED").label).toBe("Cancelada");
  });

  it("flags CONTESTED as a destructive-variant badge", () => {
    expect(getDeliveryStatusMeta("CONTESTED").variant).toBe("destructive");
  });
});
