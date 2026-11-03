// Pembuat HTML untuk Laporan Aktivitas Harian (hanya string, tanpa akses DOM/database
// supaya bisa dites). Dipakai oleh:
//   - laporan-aktivitas.js        : form isian karyawan (editable)
//   - laporan-aktivitas-kelola.js : baca laporan + cetak (readonly)
import { SECTION_KINDS, isRowFilled } from "./laporanAktivitas.js";

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Teks judul baris bawaan: nilai semua kolom bawaan digabung ("Area • Indikator • Target").
export function presetTitle(kind, row) {
  return SECTION_KINDS[kind].columns.filter(c => c.preset).map(c => row[c.key]).filter(Boolean).join(" • ");
}

function fieldHtml(col, value, { secKey, rowIdx, disabled }) {
  const attrs = `data-sec="${esc(secKey)}" data-row="${rowIdx}" data-col="${col.key}" ${disabled ? "disabled" : ""}`;
  const v = value ?? "";
  let input;
  if (col.type === "select") {
    input = `<select ${attrs}><option value="">—</option>${col.options.map(o => `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  } else if (col.type === "date") {
    input = `<input type="date" ${attrs} value="${esc(v)}">`;
  } else {
    input = `<input type="text" maxlength="500" ${attrs} value="${esc(v)}">`;
  }
  return `<label class="lap-f"><span>${esc(col.label)}</span>${input}</label>`;
}

// Warna pilihan status/prioritas: hijau = beres, kuning = berjalan, merah = perlu perhatian.
const TONE = {
  Selesai: "ok", Sesuai: "ok", Rendah: "ok",
  Proses: "warn", "Perlu perhatian": "warn", Sedang: "warn",
  Tertunda: "bad", Bermasalah: "bad", Open: "bad", Tinggi: "bad",
  "Tidak ada": "muted",
};

// Pilihan singkat (<= 4 opsi) tampil sebagai tombol sekali ketuk, bukan menu dropdown.
const asChips = col => col.type === "select" && col.options.length <= 4;

function chipsHtml(col, value, { secKey, rowIdx, disabled }) {
  const attrs = `data-sec="${esc(secKey)}" data-row="${rowIdx}" data-col="${col.key}" ${disabled ? "disabled" : ""}`;
  const name = `${secKey}-${rowIdx}-${col.key}`;
  return `<div class="lap-chips" role="radiogroup" aria-label="${esc(col.label)}">${col.options.map(o =>
    `<label class="lap-chip" data-tone="${TONE[o] || "muted"}"><input type="radio" name="${esc(name)}" value="${esc(o)}" ${attrs} ${o === value ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
}

// Teks ringkas di kepala bagian: "1 dari 2 terisi".
export function sectionCountText(kind, rows = []) {
  const preset = rows.filter(r => r._p);
  if (preset.length) return `${preset.filter(r => isRowFilled(kind, r)).length} dari ${preset.length} terisi`;
  const n = rows.filter(r => isRowFilled(kind, r)).length;
  return n ? `${n} baris terisi` : "Belum ada isian";
}

// Form isian. data = { [sectionKey]: [row, ...] }, baris bawaan bertanda _p.
export function renderEditableSections(sections, data, { disabled = false } = {}) {
  return sections.map(s => {
    const cols = SECTION_KINDS[s.kind].columns;
    const rows = data[s.key] || [];
    const body = rows.map((row, i) => {
      const isPreset = !!row._p;
      const editable = cols.filter(c => !isPreset || !c.preset);
      // Baris bawaan: status jadi tombol di kepala baris (seperti daftar centang). Selain itu di kolom isian.
      const statusCol = isPreset ? editable.find(c => c.key === "status" && asChips(c)) : null;
      const fieldCols = editable.filter(c => c !== statusCol);
      const ctx = { secKey: s.key, rowIdx: i, disabled };
      const head = isPreset
        ? `<div class="lap-row-title">${esc(presetTitle(s.kind, row)) || "&nbsp;"}</div>`
        : `<div class="lap-row-title muted">Baris tambahan</div>${disabled ? "" : `<button type="button" class="btn-link lap-del" data-del="${esc(s.key)}" data-row="${i}" title="Hapus baris">Hapus</button>`}`;
      const field = c => asChips(c)
        ? `<div class="lap-fg"><span class="lap-fl">${esc(c.label)}</span>${chipsHtml(c, row[c.key] ?? "", ctx)}</div>`
        : fieldHtml(c, row[c.key], ctx);
      return `<div class="lap-row ${isPreset ? "is-preset" : ""} ${isRowFilled(s.kind, row) ? "is-filled" : ""}" data-row-wrap="${i}">
        <div class="lap-row-head"><span class="lap-no">${i + 1}</span>${head}${statusCol ? chipsHtml(statusCol, row[statusCol.key] ?? "", ctx) : ""}</div>
        <div class="lap-fields">${fieldCols.map(field).join("")}</div>
      </div>`;
    }).join("");
    return `<section class="lap-sec lap-sec-edit" data-sec-wrap="${esc(s.key)}">
      <header class="lap-sec-head"><h3 class="lap-sec-title">${esc(s.title)}</h3><span class="lap-sec-count" data-count="${esc(s.key)}">${esc(sectionCountText(s.kind, rows))}</span></header>
      ${body || `<p class="muted lap-empty">Belum ada baris.</p>`}
      ${disabled ? "" : `<div class="lap-sec-foot"><button type="button" class="lap-add" data-add="${esc(s.key)}">+ Tambah baris</button></div>`}
    </section>`;
  }).join("");
}

// Tampilan baca-saja: per bagian satu tabel berisi baris yang terisi saja.
export function renderReadonlySections(sections, data) {
  return sections.map(s => {
    const cols = SECTION_KINDS[s.kind].columns;
    const rows = (data[s.key] || []).map((row, i) => ({ row, i })).filter(({ row }) => isRowFilled(s.kind, row));
    const skipped = (data[s.key] || []).filter(r => r._p && !isRowFilled(s.kind, r)).length;
    const table = rows.length ? `
      <div class="table-wrap"><table class="table lap-ro">
        <thead><tr><th>No</th>${cols.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(({ row, i }) => `<tr><td>${i + 1}</td>${cols.map(c => `<td>${esc(row[c.key] ?? "") || "–"}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>` : `<p class="muted lap-empty">Tidak ada isian pada bagian ini.</p>`;
    return `<section class="lap-sec lap-sec-ro">
      <h3 class="lap-sec-title">${esc(s.title)}</h3>
      ${table}
      ${skipped ? `<p class="muted small lap-skip">${skipped} baris bawaan tidak diisi.</p>` : ""}
    </section>`;
  }).join("");
}
