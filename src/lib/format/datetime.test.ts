import { describe, expect, it } from "vitest";
import { formatDateTimeBr, formatDayBr, formatDayMonthBr, formatShortDateTimeBr, timeZoneLabel } from "./datetime";

describe("formatDateTimeBr", () => {
  it("renders a UTC instant in Brazilian time, not the runtime's", () => {
    // 2026-08-28T10:02:00Z is 07:02 in São Paulo (UTC-3).
    expect(formatDateTimeBr("2026-08-28T10:02:00Z")).toBe("28/08/2026, 07:02:00");
  });

  it("crosses the date boundary correctly", () => {
    // 01:30Z on the 29th is still 22:30 on the 28th in Brazil.
    expect(formatDateTimeBr("2026-08-29T01:30:00Z")).toBe("28/08/2026, 22:30:00");
  });

  it("does not depend on the machine's own zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Europe/Lisbon";
      const lisbon = formatDateTimeBr("2026-08-28T10:02:00Z");
      process.env.TZ = "UTC";
      const utc = formatDateTimeBr("2026-08-28T10:02:00Z");
      expect(lisbon).toBe(utc);
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("formatShortDateTimeBr", () => {
  it("drops the seconds", () => {
    expect(formatShortDateTimeBr("2026-08-28T10:02:45Z")).toBe("28/08/2026, 07:02");
  });
});

describe("timeZone parameter (audit finding DAT-01)", () => {
  it("uses a company's own zone when one is given", () => {
    // 2026-08-28T10:02:00Z is 05:02 in Acre (UTC-5), two hours earlier than Brasília
    // time (UTC-3) -- the exact gap DAT-01 is about.
    expect(formatDateTimeBr("2026-08-28T10:02:00Z", "America/Rio_Branco")).toBe("28/08/2026, 05:02:00");
  });

  it("falls back to Brasília time for null, undefined, or an empty string", () => {
    const expected = formatDateTimeBr("2026-08-28T10:02:00Z");
    expect(formatDateTimeBr("2026-08-28T10:02:00Z", null)).toBe(expected);
    expect(formatDateTimeBr("2026-08-28T10:02:00Z", undefined)).toBe(expected);
    expect(formatDateTimeBr("2026-08-28T10:02:00Z", "")).toBe(expected);
  });
});

describe("timeZoneLabel", () => {
  it("names Brasília time for the default zone and for no zone at all", () => {
    expect(timeZoneLabel("America/Sao_Paulo")).toBe("horário de Brasília");
    expect(timeZoneLabel(null)).toBe("horário de Brasília");
    expect(timeZoneLabel(undefined)).toBe("horário de Brasília");
  });

  it("names a different zone in Portuguese", () => {
    expect(timeZoneLabel("America/Rio_Branco")).toContain("acre");
  });

  it("never throws on an unrecognised zone", () => {
    expect(() => timeZoneLabel("Not/A_Zone")).not.toThrow();
  });
});

describe("formatDayBr", () => {
  it("renders a date column without shifting it", () => {
    expect(formatDayBr("2026-08-28")).toBe("28/08/2026");
  });

  it("keeps the first of the month on the first of the month", () => {
    // The regression this guards: parsing "2026-09-01T00:00:00" as local midnight east of
    // Brazil and then formatting it in São Paulo printed 31/08.
    expect(formatDayBr("2026-09-01")).toBe("01/09/2026");
  });

  it("ignores anything after the date part", () => {
    expect(formatDayBr("2026-09-01T00:00:00Z")).toBe("01/09/2026");
  });

  it("returns the input unchanged when it is not a date", () => {
    expect(formatDayBr("")).toBe("");
    expect(formatDayBr("sem data")).toBe("sem data");
  });
});

describe("formatDayMonthBr", () => {
  it("renders the compact form", () => {
    expect(formatDayMonthBr("2026-08-28")).toBe("28/08");
  });
});
