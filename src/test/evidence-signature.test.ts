import { describe, expect, it } from "vitest";
import { parseSignatureDataUrl } from "@/lib/evidence/signature";

const PNG_MAGIC_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString("base64");
const VALID_DATA_URL = `data:image/png;base64,${PNG_MAGIC_B64}`;

describe("parseSignatureDataUrl", () => {
  it("accepts a well-formed PNG data URL", () => {
    expect(parseSignatureDataUrl(VALID_DATA_URL)).toEqual({ format: "image/png", data: PNG_MAGIC_B64 });
  });

  it("rejects a non-data-URL string", () => {
    expect(parseSignatureDataUrl("not a data url")).toBeNull();
  });

  it("rejects a different mime type (e.g. jpeg)", () => {
    expect(parseSignatureDataUrl(`data:image/jpeg;base64,${PNG_MAGIC_B64}`)).toBeNull();
  });

  it("rejects an empty base64 payload", () => {
    expect(parseSignatureDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("rejects bytes that don't start with the PNG magic number", () => {
    const notPng = Buffer.from("this is not a png").toString("base64");
    expect(parseSignatureDataUrl(`data:image/png;base64,${notPng}`)).toBeNull();
  });

  it("rejects a payload larger than the size cap", () => {
    const huge = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(300_000),
    ]).toString("base64");
    expect(parseSignatureDataUrl(`data:image/png;base64,${huge}`)).toBeNull();
  });
});
