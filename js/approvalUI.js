import { esc } from "./approvalHelper.js";
import { avatarHTML } from "./core.js";

// =======================================================================
// Komponen tampilan bersama untuk halaman Approval (Izin, Lembur, dan
// Perubahan Data): toolbar (tab status + pencarian + urutan), kartu tabel,
// sel karyawan, badge status, tombol aksi, dan state kosong.
// Pencarian & pengurutan dilakukan di sisi browser atas data yang sudah
// dimuat, jadi terasa instan; hanya pergantian tab status yang query ulang.
// =======================================================================

const STATUS_TABS = [
  ["pending", "Menunggu"],
  ["approved", "Disetujui"],
  ["rejected", "Ditolak"],
  ["all", "Semua"],
];

const SORTS = [
  ["newest", "Terbaru"],
  ["oldest", "Terlama"],
  ["az", "Nama A–Z"],
  ["za", "Nama Z–A"],
];

export const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`;
const ICON_INBOX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>`;
const ICON_NO_RESULT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8.5 8.5l5 5M13.5 8.5l-5 5"/></svg>`;

export function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}

// Kerangka halaman: judul, tab status, kolom cari, urutan, dan wadah tabel.
export function pageHTML({ title, subtitle, searchPlaceholder }) {
  return `
    <div class="page-header ap-page-header">
      <div>
        <h1>${esc(title)}</h1>
        <p class="muted ap-subtitle">${esc(subtitle)}</p>
      </div>
    </div>
    <div class="ap-toolbar">
      <div class="ap-tabs" id="ap-status" role="tablist" aria-label="Filter status">
        ${STATUS_TABS.map(([v, l], i) => `<button type="button" role="tab" class="ap-tab${i === 0 ? " active" : ""}" data-status="${v}" aria-selected="${i === 0}">${l}</button>`).join("")}
      </div>
      <div class="ap-tools">
        <div class="ap-search">
          ${ICON_SEARCH}
          <input type="search" id="ap-search" placeholder="${esc(searchPlaceholder)}" autocomplete="off" aria-label="Cari pengajuan">
        </div>
        <select id="ap-sort" class="ap-sort" aria-label="Urutkan">
          ${SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="ap-meta" id="ap-meta"></div>
    <div id="ap-table" class="ap-card"><p class="muted ap-loading">Memuat…</p></div>
  `;
}

// Pasang event toolbar. Mengembalikan objek `ui` yang selalu berisi nilai
// terkini: { status, q, sort }.
//   onStatus() -> dipanggil saat tab status berganti (muat ulang dari server)
//   onView()   -> dipanggil saat kata kunci / urutan berubah (gambar ulang saja)
export function initToolbar(root, { onStatus, onView }) {
  const ui = { status: "pending", q: "", sort: "newest" };

  root.querySelectorAll(".ap-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      if (ui.status === btn.dataset.status) return;
      ui.status = btn.dataset.status;
      root.querySelectorAll(".ap-tab").forEach(b => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
      onStatus();
    });
  });

  const input = root.querySelector("#ap-search");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ui.q = input.value; onView(); }, 120);
  });

  root.querySelector("#ap-sort").addEventListener("change", e => {
    ui.sort = e.target.value;
    onView();
  });

  return ui;
}

// Huruf kecil + buang aksen, supaya "Dewi" cocok dengan "dewi" / "DEWI".
const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Cari (semua kata harus ketemu, urutan bebas) lalu urutkan.
//   name(row) -> nama karyawan (untuk urut abjad)
//   text(row) -> gabungan teks yang boleh dicari
export function filterAndSort(rows, ui, { name, text }) {
  const tokens = norm(ui.q).split(/\s+/).filter(Boolean);
  let out = tokens.length
    ? rows.filter(r => { const hay = norm(text(r)); return tokens.every(t => hay.includes(t)); })
    : rows.slice();

  const byDate = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const byName = (a, b) => String(name(a) || "").localeCompare(String(name(b) || ""), "id", { sensitivity: "base" });
  switch (ui.sort) {
    case "oldest": out.sort((a, b) => -byDate(a, b)); break;
    case "az": out.sort((a, b) => byName(a, b) || byDate(a, b)); break;
    case "za": out.sort((a, b) => -byName(a, b) || byDate(a, b)); break;
    default: out.sort(byDate);
  }
  return out;
}

export function setMeta(shown, total, ui) {
  const el = document.getElementById("ap-meta");
  if (!el) return;
  if (!total) { el.textContent = ""; return; }
  el.textContent = ui.q.trim() && shown !== total
    ? `Menampilkan ${shown} dari ${total} pengajuan`
    : `${total} pengajuan`;
}

export function emptyHTML(ui, total) {
  const searching = total > 0 && ui.q.trim();
  return `
    <div class="ap-empty">
      ${searching ? ICON_NO_RESULT : ICON_INBOX}
      <strong>${searching ? "Tidak ada hasil yang cocok" : "Tidak ada pengajuan"}</strong>
      <span>${searching
        ? `Tidak ada pengajuan yang cocok dengan “${esc(ui.q.trim())}”. Coba kata kunci lain.`
        : ui.status === "pending" ? "Semua pengajuan sudah diproses." : "Belum ada data untuk filter ini."}</span>
    </div>`;
}

export function errorHTML(message) {
  return `<div class="ap-empty"><strong>Gagal memuat data</strong><span>${esc(message)}</span></div>`;
}

// ---- potongan HTML untuk baris tabel ----------------------------------

export function employeeCell(p) {
  const name = p?.full_name || "-";
  const sub = [p?.employee_code, p?.department].filter(Boolean).join(" · ");
  return `
    <div class="ap-emp">
      <span class="ap-avatar">${avatarHTML(p, name)}</span>
      <div class="ap-emp-text">
        <div class="ap-emp-name">${esc(name)}</div>
        ${sub ? `<div class="ap-emp-sub">${esc(sub)}</div>` : ""}
      </div>
    </div>`;
}

export function statusPill(status) {
  return `<span class="ap-status ap-status-${esc(status)}">${statusLabel(status)}</span>`;
}

// <td> dengan label (dipakai tampilan kartu di HP) + pembungkus isi.
export function cell(label, html, cls = "") {
  return `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ""}><div class="ap-c">${html}</div></td>`;
}

export function actionsCell(row, allowed) {
  if (allowed) {
    return `<td class="ap-td-actions"><div class="ap-actions">
      <button type="button" class="ap-btn ap-btn-approve" data-id="${esc(row.id)}">Setujui</button>
      <button type="button" class="ap-btn ap-btn-reject" data-id="${esc(row.id)}">Tolak</button>
    </div></td>`;
  }
  return `<td class="ap-td-actions"><div class="ap-actions">${
    row.status === "pending" ? `<span class="ap-wait">Belum giliranmu</span>` : ""
  }</div></td>`;
}

export function reviewNote(row) {
  return row.review_notes && row.status !== "pending"
    ? `<div class="ap-note">Catatan: ${esc(row.review_notes)}</div>` : "";
}

export function tableHTML(headers, rowsHTML) {
  return `
    <div class="ap-scroll">
      <table class="ap-table">
        <thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
    </div>`;
}

export function bindActions(el, onApprove, onReject) {
  el.querySelectorAll(".ap-btn-approve").forEach(b => b.addEventListener("click", () => onApprove(b.dataset.id)));
  el.querySelectorAll(".ap-btn-reject").forEach(b => b.addEventListener("click", () => onReject(b.dataset.id)));
}
