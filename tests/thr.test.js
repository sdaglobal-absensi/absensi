import { describe, it, expect } from "vitest";
import { masaKerja, addMonthsISO, computeThr } from "../js/thrRules.js";

describe("masaKerja", () => {
  it("tepat 1 bulan sudah dihitung 1 bulan penuh", () => {
    expect(masaKerja("2027-01-10", "2027-02-10").full).toBe(1);
  });
  it("sehari sebelum genap 1 bulan belum berhak", () => {
    const m = masaKerja("2027-01-10", "2027-02-09");
    expect(m.full).toBe(0);
    expect(m.sisaHari).toBe(30);
  });
  it("12 bulan atau lebih dibatasi 12 untuk rumus", () => {
    const m = masaKerja("2024-03-01", "2027-03-10");
    expect(m.full).toBe(36);
    expect(m.dipakai).toBe(12);
  });
  it("tanggal masuk akhir bulan dijepit ke akhir bulan target (31 Jan -> 28 Feb)", () => {
    expect(masaKerja("2027-01-31", "2027-02-28").full).toBe(1);
    expect(masaKerja("2027-01-31", "2027-02-27").full).toBe(0);
  });
  it("pembulatan atas15: sisa 15 hari naik, 14 hari tidak", () => {
    expect(masaKerja("2027-01-01", "2027-03-16", "atas15").dipakai).toBe(3); // 2 bln + 15 hari
    expect(masaKerja("2027-01-01", "2027-03-15", "atas15").dipakai).toBe(2); // 2 bln + 14 hari
    expect(masaKerja("2027-01-01", "2027-03-16", "bawah").dipakai).toBe(2);
  });
  it("pembulatan tidak membuat yang belum 1 bulan menjadi berhak (full tetap 0)", () => {
    const m = masaKerja("2027-02-01", "2027-02-20", "atas15");
    expect(m.full).toBe(0);
  });
  it("tanggal masuk kosong atau setelah tanggal acuan = 0", () => {
    expect(masaKerja(null, "2027-03-01").full).toBe(0);
    expect(masaKerja("2027-04-01", "2027-03-01").full).toBe(0);
  });
});

describe("addMonthsISO", () => {
  it("mundur 12 bulan & jepit akhir bulan", () => {
    expect(addMonthsISO("2027-03-10", -12)).toBe("2026-03-10");
    expect(addMonthsISO("2028-02-29", -12)).toBe("2027-02-28");
  });
});

const pay = { reference_date: "2027-03-10", pembulatan: "bawah", include_tunjangan: true, pph21_persen: 5 };
const tunj = [{ nama: "Tunjangan Jabatan", nominal: 500000 }, { nama: "Tunjangan Loyalitas", nominal: 250000 }];
const salary = { monthly_salary: 5000000 };
const bulanan = (join, extra = {}) => ({ id: "u1", full_name: "Budi", status_karyawan: "bulanan", join_date: join, ...extra });

describe("computeThr — bulanan", () => {
  it("masa kerja >= 12 bulan: 1 bulan upah (gaji pokok + tunjangan tetap)", () => {
    const r = computeThr({ emp: bulanan("2025-01-01"), pay, salary, allowances: tunj });
    expect(r.eligible).toBe(true);
    expect(r.snapshot.upah_sebulan).toBe(5750000);
    expect(r.thr_bruto).toBe(5750000);
    expect(r.pph21).toBe(287500); // 5%
    expect(r.thr_neto).toBe(5462500);
  });
  it("masa kerja 6 bulan: prorata 6/12", () => {
    const r = computeThr({ emp: bulanan("2026-09-10"), pay, salary, allowances: tunj });
    expect(r.snapshot.masa_kerja_bulan).toBe(6);
    expect(r.thr_bruto).toBe(2875000);
  });
  it("tunjangan dimatikan: hanya gaji pokok", () => {
    const r = computeThr({ emp: bulanan("2025-01-01"), pay: { ...pay, include_tunjangan: false }, salary, allowances: tunj });
    expect(r.snapshot.upah_sebulan).toBe(5000000);
    expect(r.snapshot.tunjangan).toEqual([]);
    expect(r.thr_bruto).toBe(5000000);
  });
  it("masa kerja < 1 bulan tidak berhak (Rp 0)", () => {
    const r = computeThr({ emp: bulanan("2027-02-20"), pay, salary, allowances: tunj });
    expect(r.eligible).toBe(false);
    expect(r.thr_bruto).toBe(0);
    expect(r.snapshot.alasan).toMatch(/kurang dari 1 bulan/);
  });
  it("tanpa tanggal masuk / tanpa status ditandai tidak berhak dengan alasan", () => {
    expect(computeThr({ emp: bulanan(null), pay, salary }).snapshot.alasan).toMatch(/Tanggal masuk/);
    expect(computeThr({ emp: bulanan("2025-01-01", { status_karyawan: null }), pay, salary }).snapshot.alasan).toMatch(/Status karyawan/);
  });
  it("riwayat gaji belum ada: peringatan, THR Rp 0", () => {
    const r = computeThr({ emp: bulanan("2025-01-01"), pay: { ...pay, include_tunjangan: false }, salary: undefined });
    expect(r.thr_bruto).toBe(0);
    expect(r.snapshot.warnings.join(" ")).toMatch(/gaji bulanan belum ada/);
  });
  it("PPh21 0% tidak memotong apa pun", () => {
    const r = computeThr({ emp: bulanan("2025-01-01"), pay: { ...pay, pph21_persen: 0 }, salary, allowances: tunj });
    expect(r.pph21).toBe(0);
    expect(r.thr_neto).toBe(r.thr_bruto);
  });
});

describe("computeThr — harian", () => {
  const harian = join => ({ id: "u2", full_name: "Sari", status_karyawan: "harian", join_date: join });
  const slips = n => Array.from({ length: n }, (_, i) => ({ period: `2026-${String(12 - i).padStart(2, "0")}`, pokok: 3000000, tunjangan: 100000 }));

  it("12 slip final: rata-rata upah sebulan x 1", () => {
    const r = computeThr({ emp: harian("2024-01-01"), pay, slips: slips(12) });
    expect(r.snapshot.basis).toBe("harian");
    expect(r.snapshot.upah_sebulan).toBe(3100000);
    expect(r.thr_bruto).toBe(3100000);
    expect(r.snapshot.warnings).toEqual([]);
  });
  it("slip final lebih sedikit dari masa kerja: tetap dihitung tapi diberi peringatan", () => {
    const r = computeThr({ emp: harian("2024-01-01"), pay, slips: slips(4) });
    expect(r.thr_bruto).toBe(3100000);
    expect(r.snapshot.warnings.join(" ")).toMatch(/hanya dari 4 slip/);
  });
  it("belum ada slip final sama sekali: Rp 0 + peringatan isi manual", () => {
    const r = computeThr({ emp: harian("2024-01-01"), pay, slips: [] });
    expect(r.thr_bruto).toBe(0);
    expect(r.snapshot.warnings.join(" ")).toMatch(/isi THR manual/);
  });
  it("masa kerja 3 bulan: prorata 3/12 dari rata-rata", () => {
    const r = computeThr({ emp: harian("2026-12-05"), pay, slips: slips(3) });
    expect(r.snapshot.masa_kerja_bulan).toBe(3);
    expect(r.thr_bruto).toBe(775000);
    expect(r.snapshot.warnings).toEqual([]);
  });
});
