import { describe, it, expect } from "vitest";
import {
  SECTION_KINDS, KIND_KEYS, normalizeSections, buildBlankData, normalizeData, isRowFilled,
  completeness, validateForSubmit, flattenReport, presetToText, parsePresetText, presetFields,
  reportStatus, isLateSubmission,
} from "../js/laporanAktivitas.js";

// Contoh template buatan HR (di aplikasi, isi template sepenuhnya ditulis HR).
const P = (...items) => items.map(aktivitas => ({ aktivitas }));
const HR_TEMPLATE = [
  { key: "aktivitas", kind: "aktivitas", title: "Aktivitas & Hasil Pekerjaan", blank_rows: 2, preset: P(
    "Rekap dan verifikasi absensi / checkclock", "Input atau update data karyawan", "Proses administrasi masuk / keluar / mutasi karyawan",
    "Monitoring kontrak PKWT dan dokumen jatuh tempo", "Proses BPJS / benefit / administrasi payroll (sesuai kewenangan)",
    "Koordinasi kebutuhan recruitment dan jadwal interview", "Follow up dokumen atau permintaan karyawan", "Arsip dan pengelolaan dokumen HR") },
  { key: "kendala", kind: "kendala", title: "Kendala / Temuan Hari Ini", blank_rows: 4, preset: [] },
  { key: "outstanding", kind: "outstanding", title: "Pekerjaan Outstanding", blank_rows: 4, preset: [] },
  { key: "rencana", kind: "rencana", title: "Rencana Kerja Berikutnya", blank_rows: 4, preset: [] },
];
const KOORDINATOR_TEMPLATE = [
  { key: "ringkasan", kind: "ringkasan", title: "Ringkasan Kondisi Hari Ini", blank_rows: 0, preset: [
    { indikator: "Total manpower", target: "Sesuai data HC", satuan: "Orang" },
    { indikator: "Attendance rate", target: "≥ 98% (sesuaikan kebijakan)", satuan: "%" } ] },
  { key: "monitoring_ga", kind: "monitoring_ga", title: "Monitoring GA, Security & Cleaning Service", blank_rows: 0, preset: [
    { area: "Security", indikator: "Insiden keamanan / kehilangan / kecelakaan", target_standar: "0 insiden" } ] },
  { key: "issue", kind: "issue", title: "Issue, Risiko & Tindak Lanjut", blank_rows: 6, preset: [] },
];

describe("jenis bagian (format Excel)", () => {
  it("tersedia 8 jenis bagian sesuai format laporan", () => {
    expect(KIND_KEYS).toEqual(["aktivitas", "kendala", "outstanding", "rencana", "ringkasan", "monitoring_hr", "monitoring_ga", "issue"]);
  });
  it("semua kolom pada tiap jenis punya key unik dan kolom utama pertama", () => {
    for (const [kind, def] of Object.entries(SECTION_KINDS)) {
      const keys = def.columns.map(c => c.key);
      expect(new Set(keys).size, kind).toBe(keys.length);
    }
  });
  it("kolom Aktivitas sama dengan format Excel", () => {
    expect(SECTION_KINDS.aktivitas.columns.map(c => c.label)).toEqual([
      "Aktivitas / pekerjaan", "Target", "Realisasi", "Satuan", "Status", "Waktu / PIC terkait", "Keterangan / bukti"]);
    expect(SECTION_KINDS.monitoring_ga.columns.map(c => c.label)).toEqual([
      "Area", "Indikator / aktivitas", "Target / standar", "Realisasi / temuan", "Status", "PIC / Vendor", "Tindak lanjut", "Due date"]);
  });
  it("template buatan HR lolos normalisasi tanpa kehilangan bagian atau baris bawaan", () => {
    for (const tpl of [HR_TEMPLATE, KOORDINATOR_TEMPLATE]) {
      const n = normalizeSections(tpl);
      expect(n).toHaveLength(tpl.length);
      n.forEach((sec, i) => expect(sec.preset).toHaveLength(tpl[i].preset.length));
    }
    const k = normalizeSections(KOORDINATOR_TEMPLATE);
    expect(k[1].preset[0]).toEqual({ area: "Security", indikator: "Insiden keamanan / kehilangan / kecelakaan", target_standar: "0 insiden" });
  });
  it("template kosong tanpa baris bawaan tetap valid (HR belum menulis isinya)", () => {
    const n = normalizeSections([{ kind: "aktivitas" }, { kind: "kendala" }]);
    expect(n.map(x => x.preset)).toEqual([[], []]);
    expect(buildBlankData(n)[n[0].key]).toEqual([{}, {}]); // hanya baris kosong bawaan jenisnya
  });
});

describe("normalizeSections", () => {
  it("membuang jenis tak dikenal, menjamin key unik & membatasi baris kosong", () => {
    const n = normalizeSections([
      { key: "a", kind: "aktivitas", title: "  ", preset: [{ aktivitas: "X" }, { aktivitas: "" }], blank_rows: 99 },
      { key: "a", kind: "kendala", blank_rows: -3 },
      { kind: "ngawur" },
    ]);
    expect(n).toHaveLength(2);
    expect(n[0].title).toBe("Aktivitas & Hasil Pekerjaan");
    expect(n[0].preset).toEqual([{ aktivitas: "X" }]);
    expect(n[0].blank_rows).toBe(15);
    expect(n[1].key).not.toBe(n[0].key);
    expect(n[1].blank_rows).toBe(0);
  });
  it("input bukan array -> kosong", () => {
    expect(normalizeSections(null)).toEqual([]);
    expect(normalizeSections("x")).toEqual([]);
  });
});

describe("editor teks baris bawaan", () => {
  it("satu kolom bawaan: seluruh baris = nilai (tanda | tidak memecah)", () => {
    expect(parsePresetText("aktivitas", "Cek A | B\n\n  Cek C ")).toEqual([{ aktivitas: "Cek A | B" }, { aktivitas: "Cek C" }]);
  });
  it("banyak kolom bawaan: dipisah | sesuai urutan kolom", () => {
    const rows = parsePresetText("monitoring_ga", "GA | Kondisi fasilitas | Berfungsi\nSecurity | Patroli");
    expect(rows).toEqual([
      { area: "GA", indikator: "Kondisi fasilitas", target_standar: "Berfungsi" },
      { area: "Security", indikator: "Patroli", target_standar: "" },
    ]);
  });
  it("presetToText kebalikan parsePresetText", () => {
    const preset = [{ area: "GA", indikator: "Kondisi", target_standar: "Aman" }];
    expect(parsePresetText("monitoring_ga", presetToText("monitoring_ga", preset))).toEqual(preset);
    expect(presetFields("ringkasan")).toEqual(["indikator", "target", "satuan"]);
  });
});

const sections = normalizeSections(HR_TEMPLATE);

describe("data laporan", () => {
  it("buildBlankData: baris bawaan terkunci (_p) lalu baris kosong", () => {
    const d = buildBlankData(sections);
    expect(d.aktivitas).toHaveLength(10);
    expect(d.aktivitas[0]._p).toBe(true);
    expect(d.aktivitas[8]).toEqual({});
    expect(d.kendala).toHaveLength(4);
  });
  it("baris bawaan belum dihitung terisi walau teks bawaannya ada", () => {
    const d = buildBlankData(sections);
    expect(isRowFilled("aktivitas", d.aktivitas[0])).toBe(false);
    d.aktivitas[0].realisasi = "10";
    expect(isRowFilled("aktivitas", d.aktivitas[0])).toBe(true);
  });
  it("completeness: persen dari baris bawaan + baris tambahan terisi terpisah", () => {
    const d = buildBlankData(sections);
    d.aktivitas[0].status = "Selesai"; d.aktivitas[1].realisasi = "5"; d.aktivitas[2].keterangan = "ok"; d.aktivitas[3].target = "3";
    d.aktivitas[8].aktivitas = "Tugas ekstra";
    expect(completeness(sections, d)).toMatchObject({ presetTotal: 8, presetFilled: 4, extraFilled: 1, pct: 50, filled: 5 });
  });
  it("completeness tanpa baris bawaan -> pct null", () => {
    const s = normalizeSections([{ kind: "kendala", blank_rows: 2 }]);
    expect(completeness(s, buildBlankData(s)).pct).toBeNull();
  });
  it("normalizeData: baris bawaan baru muncul, kolom asing dibuang, isian lama dipertahankan", () => {
    const old = { aktivitas: [{ _p: true, aktivitas: "lama", realisasi: "7", hacker: "x" }], kendala: [{ kendala: "Listrik mati" }] };
    const n = normalizeData(sections, old);
    expect(n.aktivitas).toHaveLength(10);
    expect(n.aktivitas[0].aktivitas).toBe("Rekap dan verifikasi absensi / checkclock"); // teks mengikuti template
    expect(n.aktivitas[0].realisasi).toBe("7");
    expect(n.aktivitas[0].hacker).toBeUndefined();
    expect(n.kendala[0].kendala).toBe("Listrik mati");
    expect(n.kendala).toHaveLength(4);
  });
});

describe("validateForSubmit", () => {
  it("laporan kosong ditolak", () => {
    expect(validateForSubmit(sections, buildBlankData(sections))[0]).toMatch(/masih kosong/);
  });
  it("satu baris bawaan terisi sudah cukup", () => {
    const d = buildBlankData(sections);
    d.aktivitas[0].status = "Selesai";
    expect(validateForSubmit(sections, d)).toEqual([]);
  });
  it("baris tambahan terisi tapi kolom utama kosong ditolak dengan petunjuk letak", () => {
    const d = buildBlankData(sections);
    d.aktivitas[0].status = "Selesai";
    d.kendala[1].dampak = "Terlambat";
    const errs = validateForSubmit(sections, d);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Kendala \/ Temuan Hari Ini.*baris 2.*Kendala \/ temuan/);
  });
});

describe("ekspor, status, keterlambatan", () => {
  it("flattenReport hanya memuat baris terisi dengan label kolom", () => {
    const d = buildBlankData(sections);
    d.aktivitas[1].realisasi = "12"; d.aktivitas[1].satuan = "Data";
    const rows = flattenReport(sections, d);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Bagian: "Aktivitas & Hasil Pekerjaan", No: 2, "Aktivitas / pekerjaan": "Input atau update data karyawan", Realisasi: "12", Satuan: "Data" });
  });
  it("reportStatus", () => {
    expect(reportStatus(null, true)).toBe("belum");
    expect(reportStatus(null, false)).toBe("tidak_wajib");
    expect(reportStatus({ status: "draft" }, true)).toBe("draf");
    expect(reportStatus({ status: "submitted" }, true)).toBe("terkirim");
    expect(reportStatus({ status: "submitted", reviewed_at: "2026-10-24T01:00:00Z" }, true)).toBe("ditinjau");
  });
  it("terlambat = dikirim setelah tanggal laporan menurut jam kantor (WIB)", () => {
    expect(isLateSubmission({ report_date: "2026-10-23", submitted_at: "2026-10-23T16:59:00Z" })).toBe(false); // 23:59 WIB
    expect(isLateSubmission({ report_date: "2026-10-23", submitted_at: "2026-10-23T17:01:00Z" })).toBe(true);  // 00:01 WIB 24 Okt
    expect(isLateSubmission({ report_date: "2026-10-23", submitted_at: null })).toBe(false);
  });
});
