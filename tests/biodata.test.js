import { describe, it, expect } from "vitest";
import { hitungPtkp, ptkpNominal } from "../js/biodata.js";

describe("hitungPtkp", () => {
  it("belum diisi -> null", () => expect(hitungPtkp("", 2)).toBeNull());
  it("menikah -> K/n", () => expect(hitungPtkp("menikah", 2)).toBe("K/2"));
  it("status lain -> TK/n", () => {
    for (const s of ["belum_menikah", "cerai_hidup", "cerai_mati"]) expect(hitungPtkp(s, 1)).toBe("TK/1");
  });
  it("anak dibatasi 0..3", () => {
    expect(hitungPtkp("menikah", 7)).toBe("K/3");
    expect(hitungPtkp("menikah", -2)).toBe("K/0");
    expect(hitungPtkp("menikah", "abc")).toBe("K/0");
  });
});

describe("ptkpNominal", () => {
  it("nominal dasar & tambahan tanggungan", () => {
    expect(ptkpNominal("TK/0")).toBe(54_000_000);
    expect(ptkpNominal("K/0")).toBe(58_500_000);
    expect(ptkpNominal("K/3")).toBe(58_500_000 + 3 * 4_500_000);
  });
  it("kode tidak valid -> null", () => {
    expect(ptkpNominal("K/4")).toBeNull();
    expect(ptkpNominal(null)).toBeNull();
    expect(ptkpNominal("XX/1")).toBeNull();
  });
});
