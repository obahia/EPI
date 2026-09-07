import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  assertSafeXlsx,
  neutralizeFormula,
  XlsxRejectedError,
  XLSX_MAX_FILE_BYTES,
} from "./xlsx";

/**
 * Builds a minimal but structurally valid ZIP so the guards can be tested against real
 * bytes rather than a mock. Only the fields assertSafeXlsx reads are meaningful.
 */
function buildZip(entries: { name: string; uncompressedSize: number; payload?: Buffer }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = entry.payload ?? Buffer.alloc(0);

    const local = Buffer.alloc(30 + name.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    payload.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);

  return new Uint8Array(Buffer.concat([localBytes, centralBytes, eocd]));
}

describe("assertSafeXlsx", () => {
  it("accepts an ordinary small archive", () => {
    const payload = deflateRawSync(Buffer.alloc(4096, 0x41));
    expect(() =>
      assertSafeXlsx(buildZip([{ name: "xl/worksheets/sheet1.xml", uncompressedSize: 4096, payload }])),
    ).not.toThrow();
  });

  it("refuses anything that is not a ZIP", () => {
    const notZip = new Uint8Array(Buffer.from("this is a CSV, not a spreadsheet at all!!"));
    expect(() => assertSafeXlsx(notZip)).toThrow(XlsxRejectedError);
    try {
      assertSafeXlsx(notZip);
    } catch (error) {
      expect((error as XlsxRejectedError).reason).toBe("not_a_zip");
    }
  });

  it("refuses a file over the size cap before looking at its contents", () => {
    const big = new Uint8Array(XLSX_MAX_FILE_BYTES + 1);
    big[0] = 0x50;
    big[1] = 0x4b;
    try {
      assertSafeXlsx(big);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as XlsxRejectedError).reason).toBe("file_too_large");
    }
  });

  it("refuses a zip bomb: tiny archive declaring a huge expansion", () => {
    // ~1 KB on disk claiming 500 MB expanded -- the classic shape.
    const payload = deflateRawSync(Buffer.alloc(64 * 1024, 0));
    const zip = buildZip([
      { name: "xl/worksheets/sheet1.xml", uncompressedSize: 500 * 1024 * 1024, payload },
    ]);
    try {
      assertSafeXlsx(zip);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as XlsxRejectedError).reason).toBe("uncompressed_too_large");
    }
  });

  it("refuses an implausible compression ratio even when the total stays under the absolute cap", () => {
    const payload = deflateRawSync(Buffer.alloc(1024, 0));
    // ~1 KB of payload declaring 50 MB: under the 100 MB absolute cap, far over 100:1.
    const zip = buildZip([{ name: "sheet.xml", uncompressedSize: 50 * 1024 * 1024, payload }]);
    try {
      assertSafeXlsx(zip);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as XlsxRejectedError).reason).toBe("compression_ratio");
    }
  });

  it("refuses an archive with an absurd number of entries", () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({
      name: `s${i}.xml`,
      uncompressedSize: 16,
    }));
    try {
      assertSafeXlsx(buildZip(entries));
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as XlsxRejectedError).reason).toBe("too_many_entries");
    }
  });

  it("refuses a truncated central directory instead of reading past the buffer", () => {
    const zip = buildZip([{ name: "sheet.xml", uncompressedSize: 100 }]);
    const truncated = zip.slice(0, zip.length - 30);
    expect(() => assertSafeXlsx(truncated)).toThrow(XlsxRejectedError);
  });
});

describe("neutralizeFormula", () => {
  it("prefixes every character Excel treats as the start of a formula", () => {
    expect(neutralizeFormula("=1+1")).toBe("'=1+1");
    expect(neutralizeFormula("+1")).toBe("'+1");
    expect(neutralizeFormula("-1")).toBe("'-1");
    expect(neutralizeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeFormula("\tcmd")).toBe("'\tcmd");
  });

  it("neutralises the real-world payload shape", () => {
    expect(neutralizeFormula('=cmd|\'/c calc\'!A1')).toBe('\'=cmd|\'/c calc\'!A1');
  });

  it("leaves ordinary values untouched", () => {
    expect(neutralizeFormula("Maria Silva")).toBe("Maria Silva");
    expect(neutralizeFormula("529.982.247-25")).toBe("529.982.247-25");
    expect(neutralizeFormula("")).toBe("");
  });
});
