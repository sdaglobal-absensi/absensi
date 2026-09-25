import { supabase } from "./supabaseClient.js";
import { fmtDate, fmtDateTime } from "./core.js";
import { esc, fetchSteps, stepsHTML } from "./approvalHelper.js";
import { statusPill } from "./approvalUI.js";

// =======================================================================
// Riwayat pengajuan izin/lembur yang diajukan ulang (revisi).
// Satu "rantai" = pengajuan awal + revisi-revisinya (dihubungkan lewat
// kolom revision_of). Tiap pengajuan tetap satu baris sendiri di database
// (tidak ditimpa), jadi siapa yang menyetujui/menolak & catatannya utuh.
//   - Karyawan : tabel riwayat hanya menampilkan pengajuan TERBARU per rantai;
//                yang lama dibuka lewat tombol "Riwayat" (popup).
//   - Approver : popup Setujui/Tolak menampilkan riwayat pengajuan sebelumnya,
//                supaya keputusan diambil dengan tahu sejarahnya.
// =======================================================================

const TABLE = { leave: "leave_requests", overtime: "overtime_requests", koreksi: "attendance_correction_requests" };

// Pengajuan-pengajuan SEBELUMNYA dari `req` (urut lama -> baru, tanpa req),
// dicari di daftar yang sudah dimuat (dipakai riwayat karyawan).
export function chainOf(all, req) {
  const byId = new Map(all.map(r => [r.id, r]));
  const out = [];
  const seen = new Set([req.id]);
  let cur = req;
  while (cur.revision_of && byId.has(cur.revision_of) && !seen.has(cur.revision_of)) {
    cur = byId.get(cur.revision_of);
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

// Sama, tapi mengambil dari database (dipakai approver, yang daftarnya belum
// tentu memuat pengajuan lama). Mengembalikan { attempts, steps }.
export async function fetchAttempts(kind, req) {
  const attempts = [];
  const seen = new Set([req.id]);
  let cur = req;
  for (let i = 0; i < 10 && cur.revision_of && !seen.has(cur.revision_of); i++) {
    const { data } = await supabase.from(TABLE[kind]).select("*").eq("id", cur.revision_of).maybeSingle();
    if (!data) break;
    attempts.unshift(data);
    seen.add(data.id);
    cur = data;
  }
  const steps = await fetchSteps(kind, attempts.map(r => r.id));
  return { attempts, steps };
}

// Daftar riwayat (timeline). `attempts` urut lama -> baru.
export function timelineHTML(attempts, steps, describe, { latestLabel = false } = {}) {
  return `<div class="hist-list">${attempts.map((r, i) => `
    <div class="hist-item hist-${esc(r.status)}">
      <div class="hist-head">
        <strong>Pengajuan ke-${i + 1}</strong>
        ${latestLabel && i === attempts.length - 1 ? `<span class="hist-latest">Terbaru</span>` : ""}
        ${statusPill(r.status)}
      </div>
      <div class="small muted">Diajukan ${fmtDateTime(r.created_at)}</div>
      <div class="hist-desc">${describe(r)}</div>
      ${stepsHTML(r, steps[r.id])}
    </div>`).join("")}</div>`;
}

// Blok untuk di dalam popup Setujui/Tolak (kosong kalau bukan pengajuan ulang).
export function historyBlockHTML(req, hist, describe) {
  if (!req.revision_of) return "";
  if (!hist.attempts.length) {
    return `<div class="hist-block"><div class="hist-block-title">Pengajuan ulang</div><p class="muted small" style="margin:0;">Ini pengajuan ulang, tapi riwayat sebelumnya tidak dapat dimuat.</p></div>`;
  }
  return `
    <div class="hist-block">
      <div class="hist-block-title">Pengajuan ulang ke-${hist.attempts.length + 1} — riwayat sebelumnya</div>
      ${timelineHTML(hist.attempts, hist.steps, describe)}
    </div>`;
}

// Tombol kecil di halaman approval untuk baris yang merupakan pengajuan ulang.
export function historyButton(req) {
  return req.revision_of
    ? `<button type="button" class="btn-link btn-hist revisi-tag" data-id="${esc(req.id)}">↻ Pengajuan ulang · Lihat riwayat</button>`
    : "";
}

// Kolom aksi di riwayat karyawan: "Riwayat" (kalau ada revisi) + "Ajukan Ulang" (kalau ditolak).
export function employeeActionsHTML(req, chainLen) {
  const btns = [];
  if (chainLen) btns.push(`<button type="button" class="btn-secondary btn-sm btn-hist" data-id="${esc(req.id)}">Riwayat</button>`);
  if (req.status === "rejected") btns.push(`<button type="button" class="btn-secondary btn-sm btn-revisi" data-id="${esc(req.id)}">Ajukan Ulang</button>`);
  return btns.length ? `<div class="row-actions">${btns.join("")}</div>` : `<span class="small muted">-</span>`;
}

export function employeeStatusTag(chainLen) {
  return chainLen ? `<div class="small muted revisi-tag">↻ Pengajuan ke-${chainLen + 1}</div>` : "";
}

// Popup baca-saja berisi riwayat.
export function openHistoryModal({ title, subtitle, bodyHTML }) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `
    <div class="modal-box ap-modal hist-modal">
      <h3>${esc(title)}</h3>
      ${subtitle ? `<p class="muted small" style="margin:4px 0 0;">${esc(subtitle)}</p>` : ""}
      <div class="hist-block" style="margin-top:14px;">${bodyHTML}</div>
      <div class="modal-actions" style="margin-top:14px;">
        <button type="button" class="btn-secondary" data-x="close">Tutup</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const onKey = e => { if (e.key === "Escape") close(); };
  const close = () => { document.removeEventListener("keydown", onKey); modal.remove(); };
  document.addEventListener("keydown", onKey);
  modal.querySelector('[data-x="close"]').addEventListener("click", close);
  modal.addEventListener("mousedown", e => { if (e.target === modal) close(); });
}

// Riwayat lengkap satu rantai (pengajuan terbaru + semua sebelumnya) untuk karyawan.
export function openChainModal(title, all, req, steps, describe) {
  const chain = [...chainOf(all, req), req];
  openHistoryModal({
    title,
    subtitle: `${chain.length} kali diajukan · riwayat lengkap, termasuk yang ditolak`,
    bodyHTML: timelineHTML(chain, steps, describe, { latestLabel: true }),
  });
}

// Untuk approver: buka popup riwayat baca-saja dari tombol "Lihat riwayat".
export async function openApproverHistory(kind, req, title, describe) {
  const hist = await fetchAttempts(kind, req);
  const chain = [...hist.attempts, req];
  const steps = { ...hist.steps, ...(await fetchSteps(kind, [req.id])) };
  openHistoryModal({
    title,
    subtitle: `Pengajuan ke-${chain.length} · riwayat pengajuan sebelumnya`,
    bodyHTML: timelineHTML(chain, steps, describe, { latestLabel: true }),
  });
}

export { fmtDate };
