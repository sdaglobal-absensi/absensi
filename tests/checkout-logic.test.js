import { describe, it, expect } from "vitest";
import {
  tzOffsetHours, dayOfWeekFromDateStr, addDaysToDateStr, zonedTimestampMs, todayInOffset,
} from "../supabase/functions/checkout-reminder/logic.ts";

describe("checkout-reminder logic", () => {
  it("offset zona Indonesia", () => {
    expect(tzOffsetHours("Asia/Jakarta")).toBe(7);
    expect(tzOffsetHours("Asia/Makassar")).toBe(8);
    expect(tzOffsetHours("Asia/Jayapura")).toBe(9);
    expect(tzOffsetHours(null)).toBe(7);
  });
  it("hari dalam minggu (0=Minggu)", () => {
    expect(dayOfWeekFromDateStr("2026-10-05")).toBe(1); // Senin
  });
  it("tambah hari", () => expect(addDaysToDateStr("2026-02-28", 1)).toBe("2026-03-01"));
  it("08:15 WIB = 01:15 UTC", () => {
    expect(new Date(zonedTimestampMs("2026-10-05", 8, 15, 7)).toISOString()).toBe("2026-10-05T01:15:00.000Z");
  });
  it("tanggal 'hari ini' mengikuti zona, bukan UTC", () => {
    const utc = Date.UTC(2026, 9, 5, 20, 0, 0); // 20:00 UTC = 03:00 WIB esok
    expect(todayInOffset(7, utc)).toBe("2026-10-06");
    expect(todayInOffset(0, utc)).toBe("2026-10-05");
  });
});
