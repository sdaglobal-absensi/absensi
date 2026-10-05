import { describe, it, expect, vi } from "vitest";
vi.mock("../js/supabaseClient.js", () => ({ supabase: {} }));
const { addDays, leaveTypeLabel } = await import("../js/leaveRules.js");

describe("addDays", () => {
  it("lintas bulan & tahun", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("tahun kabisat & mundur", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("leaveTypeLabel", () => {
  const rules = [{ kode: "nikah", label: "Pernikahan" }];
  it("label dasar", () => {
    expect(leaveTypeLabel({ type: "izin" }, rules)).toBe("Izin Tidak Masuk");
    expect(leaveTypeLabel({ type: "sakit" }, rules)).toBe("Sakit");
  });
  it("cuti khusus memuat label aturan", () => {
    expect(leaveTypeLabel({ type: "cuti", leave_category: "khusus", special_leave_code: "nikah" }, rules))
      .toBe("Cuti Khusus — Pernikahan");
  });
  it("cuti tahunan", () => {
    expect(leaveTypeLabel({ type: "cuti", leave_category: "tahunan" }, rules)).toBe("Cuti Tahunan");
  });
});
