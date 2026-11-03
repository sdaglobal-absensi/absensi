// =======================================================================
// LAPORAN AKTIVITAS HARIAN — aturan murni (tanpa database/DOM) supaya mudah dites.
// Dipakai oleh js/modules/laporan-aktivitas.js (karyawan mengisi) dan
// js/modules/laporan-aktivitas-kelola.js (HR: rekap, template, tinjauan).
//
// Konsep:
//   Template = daftar BAGIAN (section). Tiap bagian punya JENIS (kind) yang
//   menentukan kolomnya (sesuai format Excel yang dipakai: Aktivitas & Hasil
//   Pekerjaan, Kendala / Temuan, Pekerjaan Outstanding, Rencana Kerja,
//   Ringkasan Kondisi, Monitoring HR, Monitoring GA/Security/Cleaning, Issue &
//   Risiko). Template hanya menyimpan: jenis, judul, baris bawaan (preset) dan
//   jumlah baris kosong. Kolom ada di kode ini, jadi mengubah template tidak
//   perlu migrasi database.
//   Laporan = data isian per bagian + SALINAN template saat dibuat (snapshot),
//   supaya laporan lama tetap tampil benar walau template diubah kemudian.
// =======================================================================

export const STATUS_KERJA = ["Selesai", "Proses", "Tertunda", "Tidak ada"];
export const STATUS_ISU = ["Open", "Proses", "Selesai"];
export const STATUS_INDIKATOR = ["Sesuai", "Perlu perhatian", "Bermasalah"];
export const PRIORITAS = ["Tinggi", "Sedang", "Rendah"];

const text = (key, label, extra = {}) => ({ key, label, type: "text", ...extra });
const date = (key, label) => ({ key, label, type: "date" });
const select = (key, label, options) => ({ key, label, type: "select", options });

// columns[0] = kolom utama (wajib terisi kalau baris lain terisi).
// preset: true = nilainya datang dari template (terkunci pada baris bawaan).
export const SECTION_KINDS = {
  aktivitas: {
    label: "Aktivitas & Hasil Pekerjaan", blankDefault: 2,
    presetExample: "Rekap dan verifikasi absensi\nInput atau update data karyawan\nFollow up dokumen karyawan",
    columns: [
      text("aktivitas", "Aktivitas / pekerjaan", { preset: true }),
      text("target", "Target"), text("realisasi", "Realisasi"),
      select("status", "Status", STATUS_KERJA),
      text("keterangan", "Keterangan / bukti"),
    ],
  },
  kendala: {
    label: "Kendala / Temuan Hari Ini", blankDefault: 4,
    columns: [
      text("kendala", "Kendala / temuan"), text("dampak", "Dampak"), text("tindakan_awal", "Tindakan awal"),
      text("butuh_bantuan", "Butuh bantuan dari"), select("prioritas", "Prioritas", PRIORITAS),
      date("target_selesai", "Target selesai"), select("status", "Status", STATUS_ISU),
    ],
  },
  outstanding: {
    label: "Pekerjaan Outstanding", blankDefault: 4,
    columns: [
      text("pekerjaan", "Pekerjaan belum selesai"), text("alasan", "Alasan belum selesai"),
      text("tindak_lanjut", "Tindak lanjut berikutnya"), text("pic", "PIC"),
      date("target_selesai", "Target selesai"), select("status", "Status", STATUS_ISU), text("catatan", "Catatan"),
    ],
  },
  rencana: {
    label: "Rencana Kerja Berikutnya", blankDefault: 4,
    columns: [
      text("rencana", "Rencana aktivitas"), text("output", "Output yang diharapkan"),
      select("prioritas", "Prioritas", PRIORITAS), text("pic", "PIC / pihak terkait"),
      text("target_waktu", "Target waktu"), text("keterangan", "Keterangan"),
    ],
  },
  ringkasan: {
    label: "Ringkasan Kondisi Hari Ini", blankDefault: 0,
    presetExample: "Total manpower | Sesuai data HC | Orang\nAttendance rate | ≥ 98% | %",
    columns: [
      text("indikator", "Indikator", { preset: true }), text("target", "Target / Acuan", { preset: true }),
      text("realisasi", "Realisasi"), text("satuan", "Satuan", { preset: true }),
      select("status", "Status", STATUS_INDIKATOR), text("catatan", "Catatan"),
    ],
  },
  monitoring_hr: {
    label: "Monitoring HR", blankDefault: 0,
    presetExample: "Manpower | Karyawan masuk / join | Orang\nRecruitment | Kandidat interview | Orang",
    columns: [
      text("area", "Area", { preset: true }), text("indikator", "Aktivitas / indikator", { preset: true }),
      text("target", "Target"), text("realisasi", "Realisasi"), text("satuan", "Satuan", { preset: true }),
      select("status", "Status", STATUS_INDIKATOR), text("pic", "PIC / Unit terkait"), text("keterangan", "Keterangan"),
    ],
  },
  monitoring_ga: {
    label: "Monitoring GA, Security & Cleaning Service", blankDefault: 0,
    presetExample: "GA | Kondisi fasilitas & utilitas | Berfungsi / aman\nSecurity | Patroli / kontrol akses | Sesuai SOP",
    columns: [
      text("area", "Area", { preset: true }), text("indikator", "Indikator / aktivitas", { preset: true }),
      text("target_standar", "Target / standar", { preset: true }), text("realisasi", "Realisasi / temuan"),
      select("status", "Status", STATUS_INDIKATOR), text("pic_vendor", "PIC / Vendor"),
      text("tindak_lanjut", "Tindak lanjut"), date("due_date", "Due date"),
    ],
  },
  issue: {
    label: "Issue, Risiko & Tindak Lanjut", blankDefault: 6,
    columns: [
      text("permasalahan", "Permasalahan / risiko"), text("dampak", "Dampak"), text("tindakan", "Tindakan hari ini"),
      text("pic", "PIC"), select("prioritas", "Prioritas", PRIORITAS),
      date("target_selesai", "Target selesai"), select("status", "Status", STATUS_ISU),
    ],
  },
};

export const KIND_KEYS = Object.keys(SECTION_KINDS);
const MAX_BLANK = 15;
const MAX_PRESET = 40;
const MAX_SECTIONS = 10;
const MAX_VALUE_LEN = 500;

export const presetFields = kind => (SECTION_KINDS[kind]?.columns || []).filter(c => c.preset).map(c => c.key);
export const mainField = kind => SECTION_KINDS[kind]?.columns?.[0]?.key;

const clean = (v, max = MAX_VALUE_LEN) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------
// TEMPLATE
// ---------------------------------------------------------------------

// Rapikan template (dari editor/DB) menjadi bentuk yang pasti valid.
export function normalizeSections(raw) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_SECTIONS) break;
    const kind = SECTION_KINDS[s?.kind] ? s.kind : null;
    if (!kind) continue;
    let key = clean(s.key, 40).replace(/[^a-zA-Z0-9_]/g, "_") || `s${out.length + 1}_${kind}`;
    while (seen.has(key)) key += "_x";
    seen.add(key);
    const fields = presetFields(kind);
    const preset = (Array.isArray(s.preset) ? s.preset : []).slice(0, MAX_PRESET).map(p => {
      const row = {};
      fields.forEach(f => { row[f] = clean(p?.[f]); });
      return row;
    }).filter(row => Object.values(row).some(Boolean));
    const blank = Number.isFinite(Number(s.blank_rows)) ? Math.min(MAX_BLANK, Math.max(0, Math.trunc(Number(s.blank_rows)))) : SECTION_KINDS[kind].blankDefault;
    out.push({ key, kind, title: clean(s.title, 120) || SECTION_KINDS[kind].label, preset, blank_rows: blank });
  }
  return out;
}

// Editor: satu baris bawaan per baris teks; kolom dipisah "|" (hanya kalau jenisnya punya >1 kolom bawaan).
export function presetToText(kind, preset = []) {
  const fields = presetFields(kind);
  return preset.map(row => fields.map(f => row[f] || "").join(" | ")).join("\n");
}
export function parsePresetText(kind, txt) {
  const fields = presetFields(kind);
  return String(txt || "").split("\n").map(l => l.trim()).filter(Boolean).slice(0, MAX_PRESET).map(line => {
    const row = {};
    if (fields.length === 1) { row[fields[0]] = clean(line); return row; }
    const parts = line.split("|").map(p => p.trim());
    fields.forEach((f, i) => { row[f] = clean(parts[i]); });
    return row;
  });
}

// ---------------------------------------------------------------------
// DATA LAPORAN
// ---------------------------------------------------------------------

// Baris bawaan (terkunci, ditandai _p) + baris kosong sesuai template.
export function buildBlankData(sections) {
  const data = {};
  for (const s of sections) {
    data[s.key] = [
      ...s.preset.map(p => ({ _p: true, ...p })),
      ...Array.from({ length: s.blank_rows }, () => ({})),
    ];
  }
  return data;
}

// Gabungkan data tersimpan dengan struktur template (snapshot): baris bawaan baru
// otomatis muncul, kolom yang tidak dikenal dibuang, nilai dipangkas.
export function normalizeData(sections, data) {
  const out = {};
  for (const s of sections) {
    const cols = SECTION_KINDS[s.kind].columns;
    const saved = Array.isArray(data?.[s.key]) ? data[s.key] : [];
    const sanitize = (row, isPreset) => {
      const r = isPreset ? { _p: true } : {};
      cols.forEach(c => { if (row?.[c.key] != null) r[c.key] = clean(row[c.key]); });
      return r;
    };
    const savedPreset = saved.filter(r => r?._p);
    const savedExtra = saved.filter(r => !r?._p);
    // baris bawaan mengikuti template (urutan & teks), nilai isian diambil dari yang tersimpan
    const presetRows = s.preset.map((p, i) => ({ ...sanitize(savedPreset[i], true), ...p }));
    out[s.key] = [...presetRows, ...savedExtra.map(r => sanitize(r, false))];
    const wanted = s.preset.length + s.blank_rows;
    while (out[s.key].length < wanted) out[s.key].push({});
  }
  return out;
}

// Baris dianggap terisi kalau ada kolom NON-bawaan yang diisi (baris tambahan: kolom apa pun).
export function isRowFilled(kind, row) {
  const cols = SECTION_KINDS[kind].columns;
  return cols.some(c => (!row?._p || !c.preset) && String(row?.[c.key] ?? "").trim() !== "");
}

// Hitung kelengkapan: baris bawaan yang sudah diisi / seluruh baris bawaan.
// Baris tambahan terisi dihitung terpisah.
export function completeness(sections, data) {
  let presetTotal = 0, presetFilled = 0, extraFilled = 0;
  for (const s of sections) {
    for (const row of data?.[s.key] || []) {
      const filled = isRowFilled(s.kind, row);
      if (row._p) { presetTotal++; if (filled) presetFilled++; }
      else if (filled) extraFilled++;
    }
  }
  const pct = presetTotal ? Math.round(presetFilled / presetTotal * 100) : null;
  return { presetTotal, presetFilled, extraFilled, pct, filled: presetFilled + extraFilled };
}

// Aturan kirim: minimal satu baris terisi, dan baris TAMBAHAN yang terisi harus
// punya kolom utama (supaya tidak ada baris tanpa judul).
export function validateForSubmit(sections, data) {
  const errors = [];
  let any = false;
  for (const s of sections) {
    const main = mainField(s.kind);
    const mainLabel = SECTION_KINDS[s.kind].columns[0].label;
    (data?.[s.key] || []).forEach((row, i) => {
      if (!isRowFilled(s.kind, row)) return;
      any = true;
      if (!row._p && !String(row[main] ?? "").trim()) errors.push(`Bagian "${s.title}", baris ${i + 1}: kolom "${mainLabel}" masih kosong.`);
    });
  }
  if (!any) errors.unshift("Laporan masih kosong. Isi minimal satu baris sebelum mengirim.");
  return errors;
}

// ---------------------------------------------------------------------
// RINGKASAN & EKSPOR
// ---------------------------------------------------------------------

// Satu baris ekspor per baris terisi: { Bagian, No, <label kolom>: nilai ... }
export function flattenReport(sections, data) {
  const rows = [];
  for (const s of sections) {
    const cols = SECTION_KINDS[s.kind].columns;
    (data?.[s.key] || []).forEach((row, i) => {
      if (!isRowFilled(s.kind, row)) return;
      const r = { Bagian: s.title, No: i + 1 };
      cols.forEach(c => { r[c.label] = row[c.key] ?? ""; });
      rows.push(r);
    });
  }
  return rows;
}

// Status laporan untuk rekap. report: baris daily_reports atau null.
export function reportStatus(report, expected) {
  if (!report) return expected ? "belum" : "tidak_wajib";
  if (report.reviewed_at) return "ditinjau";
  return report.status === "submitted" ? "terkirim" : "draf";
}

export const REPORT_STATUS_LABEL = {
  belum: "Belum mengisi", draf: "Draf", terkirim: "Terkirim", ditinjau: "Ditinjau", tidak_wajib: "Tidak wajib",
};

// Terlambat = dikirim SETELAH tanggal laporannya (zona waktu kantor).
export function isLateSubmission(report, tzOffsetMinutes = 7 * 60) {
  if (!report?.submitted_at) return false;
  const local = new Date(new Date(report.submitted_at).getTime() + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
  return local > report.report_date;
}
