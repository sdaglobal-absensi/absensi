import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, STAFF_ROLES } from "../core.js";
import { esc, loadApprovalList, canDecide, stepsHTML, askDecision, decideRequest } from "../approvalHelper.js";
import {
  pageHTML, initToolbar, filterAndSort, setMeta, emptyHTML, errorHTML,
  employeeCell, statusPill, cell, actionsCell, reviewNote, tableHTML, bindActions,
} from "../approvalUI.js";
import { fetchAttempts, historyBlockHTML, historyButton, openApproverHistory } from "../requestHistory.js";
import { fetchSpecialLeaveRules, leaveTypeLabel } from "../leaveRules.js";

// Approval Izin BERTINGKAT — daftar hanya berisi pengajuan yang melibatkan
// user ini sebagai approver (Super Admin: semua). Tombol Setujui/Tolak baru
// muncul saat GILIRAN user ini (tahap sebelumnya sudah selesai).
// Pencarian & urut abjad dikerjakan di browser atas data yang sudah dimuat.
//
// Cuti yang SUDAH DISETUJUI bisa dibatalkan lewat tombol "Batalkan" (khusus
// role HR/Super Admin) — status berubah jadi "Dibatalkan" dan, untuk Cuti
// Tahunan, saldo yang sudah terpakai dikembalikan otomatis (lihat RPC
// cancel_leave_request di supabase-cuti-khusus.sql).
let state = { data: [], steps: {}, rules: [] };
let ui;
let seq = 0; // cegah respons lama menimpa respons baru saat tab cepat berganti

export async function render(container, user) {
  container.innerHTML = pageHTML({
    title: "Approval Izin",
    subtitle: "Pengajuan yang menunggu persetujuanmu sesuai struktur organisasi. Kalau ada beberapa tingkat, tombol Setujui/Tolak baru muncul saat tiba giliranmu.",
    searchPlaceholder: "Cari nama, jenis, atau alasan…",
  });
  ui = initToolbar(container, { onStatus: () => load(user), onView: () => paint(user) });
  state.rules = await fetchSpecialLeaveRules();
  await load(user);
}

async function load(user) {
  const my = ++seq;
  const el = document.getElementById("ap-table");
  el.innerHTML = `<p class="muted ap-loading">Memuat…</p>`;
  const res = await loadApprovalList(
    "leave", user, ui.status,
    "*, profiles!leave_requests_user_id_fkey(full_name, department, employee_code, photo_url)"
  );
  if (my !== seq) return;
  if (res.error) { el.innerHTML = errorHTML(res.error.message); return; }
  state = { ...state, data: res.data, steps: res.steps };
  paint(user);
}

function paint(user) {
  const el = document.getElementById("ap-table");
  const { data, steps } = state;

  const rows = filterAndSort(data, ui, {
    name: r => r.profiles?.full_name,
    text: r => [
      r.profiles?.full_name, r.profiles?.employee_code, r.profiles?.department,
      leaveTypeLabel(r, state.rules), r.reason, r.review_notes, fmtDate(r.start_date), fmtDate(r.end_date),
    ].join(" "),
  });
  setMeta(rows.length, data.length, ui);
  if (!rows.length) { el.innerHTML = emptyHTML(ui, data.length); return; }

  el.innerHTML = tableHTML(
    ["Karyawan", "Jenis & Periode", "Alasan", "Status", "Tahap Approval", ""],
    rows.map(r => `
      <tr>
        ${cell("Karyawan", employeeCell(r.profiles), "ap-td-emp")}
        ${cell("Periode", `<span class="ap-chip">${esc(leaveTypeLabel(r, state.rules))}</span>${periodHTML(r)}`)}
        ${cell("Alasan", `<div class="ap-reason">${esc(r.reason)}</div>${reviewNote(r)}${cancelReasonHTML(r)}`)}
        ${cell("Status", `${statusPill(r.status)}<div class="ap-sub">Diajukan ${fmtDate(r.created_at)}</div>${historyButton(r)}${cancelButtonHTML(r, user)}`)}
        ${cell("Tahap", stepsHTML(r, steps[r.id]), "ap-td-steps")}
        ${actionsCell(r, canDecide(r, steps[r.id], user))}
      </tr>
    `).join("")
  );

  bindActions(el,
    id => confirmDecide(id, "approved", user),
    id => confirmDecide(id, "rejected", user));
  el.querySelectorAll(".btn-hist").forEach(b => b.addEventListener("click", () => {
    const row = state.data.find(r => r.id === b.dataset.id);
    if (row) openApproverHistory("leave", row, `Riwayat Izin — ${row.profiles?.full_name || "-"}`, describe);
  }));
  el.querySelectorAll(".btn-batalkan").forEach(b => b.addEventListener("click", () => onCancel(b.dataset.id, user)));
}

// Ringkasan satu pengajuan izin untuk daftar riwayat.
function describe(r) {
  return `<span class="ap-chip">${esc(leaveTypeLabel(r, state.rules))}</span> ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}<div class="hist-reason">${esc(r.reason)}</div>`;
}

function periodHTML(r) {
  const same = r.start_date === r.end_date;
  const days = Math.round((new Date(r.end_date) - new Date(r.start_date)) / 86400000) + 1;
  return `
    <div class="ap-main ap-main-gap">${same
      ? `<span class="nw">${fmtDate(r.start_date)}</span>`
      : `<span class="nw">${fmtDate(r.start_date)}</span> – <span class="nw">${fmtDate(r.end_date)}</span>`}</div>
    ${Number.isFinite(days) && days > 0 ? `<div class="ap-sub">${days} hari</div>` : ""}`;
}

function cancelReasonHTML(r) {
  return r.status === "dibatalkan" && r.cancel_reason
    ? `<div class="ap-note">Alasan pembatalan: ${esc(r.cancel_reason)}</div>` : "";
}

// Tombol "Batalkan" hanya untuk cuti yang sudah disetujui, dan hanya untuk
// role HR/Super Admin (STAFF_ROLES) — sama seperti pengecekan is_staff() di
// server (RPC cancel_leave_request menolak role lain walau tombolnya di-klik).
function cancelButtonHTML(r, user) {
  if (r.status !== "approved" || r.type !== "cuti" || !STAFF_ROLES.includes(user.role)) return "";
  return `<button type="button" class="btn-link btn-batalkan" data-id="${esc(r.id)}">Batalkan</button>`;
}

async function confirmDecide(id, decision, user) {
  const row = state.data.find(r => r.id === id);
  if (!row) return;
  const detail = [
    ["Karyawan", row.profiles?.full_name || "-"],
    ["Jenis", leaveTypeLabel(row, state.rules)],
    ["Periode", `${fmtDate(row.start_date)} – ${fmtDate(row.end_date)}`],
    ["Alasan", row.reason],
  ];

  // Pengajuan ulang: tampilkan riwayat pengajuan sebelumnya (setuju/tolak) di popup.
  const hist = row.revision_of ? await fetchAttempts("leave", row) : null;
  const res = await askDecision({
    title: decision === "approved" ? "Setujui pengajuan ini?" : "Tolak pengajuan ini?",
    detail, decision,
    extraHTML: hist ? historyBlockHTML(row, hist, describe) : "",
  });
  if (!res) return;

  const { status, error } = await decideRequest("leave", id, decision, res.notes);
  if (error) { toast("Gagal memperbarui: " + error.message, "error"); load(user); return; }
  toast(
    decision === "rejected" ? "Pengajuan ditolak"
      : status === "approved" ? "Pengajuan disetujui (semua tahap selesai)"
      : "Disetujui — diteruskan ke tahap berikutnya",
    "success"
  );
  load(user);
}

function askCancelReason(row) {
  return new Promise(resolve => {
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="modal-box ap-modal">
        <h3>Batalkan pengajuan cuti ini?</h3>
        <dl class="ap-detail">
          <dt>Karyawan</dt><dd>${esc(row.profiles?.full_name || "-")}</dd>
          <dt>Jenis</dt><dd>${esc(leaveTypeLabel(row, state.rules))}</dd>
          <dt>Periode</dt><dd>${fmtDate(row.start_date)} – ${fmtDate(row.end_date)}</dd>
        </dl>
        <p class="muted small" style="margin:10px 0 0;">Status akan berubah menjadi "Dibatalkan"${row.leave_category === "tahunan" ? ", dan saldo Cuti Tahunan yang sudah terpakai akan dikembalikan." : "."}</p>
        <div class="form-row" style="margin-top:14px;">
          <label>Alasan pembatalan (wajib)
            <textarea id="cancel-reason" rows="2" required placeholder="Jelaskan alasan pembatalan…"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
          <button type="button" class="btn-danger" data-x="ok">Ya, Batalkan</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const onKey = e => { if (e.key === "Escape") done(null); };
    const done = v => { document.removeEventListener("keydown", onKey); modal.remove(); resolve(v); };
    document.addEventListener("keydown", onKey);
    modal.querySelector('[data-x="cancel"]').addEventListener("click", () => done(null));
    modal.querySelector('[data-x="ok"]').addEventListener("click", () => {
      const val = modal.querySelector("#cancel-reason").value.trim();
      if (!val) { toast("Alasan pembatalan wajib diisi", "error"); return; }
      done(val);
    });
    modal.addEventListener("mousedown", e => { if (e.target === modal) done(null); });
  });
}

async function onCancel(id, user) {
  const row = state.data.find(r => r.id === id);
  if (!row) return;
  const reason = await askCancelReason(row);
  if (!reason) return;
  const { error } = await supabase.rpc("cancel_leave_request", { p_request_id: id, p_reason: reason });
  if (error) { toast("Gagal membatalkan: " + error.message, "error"); return; }
  toast("Pengajuan dibatalkan" + (row.leave_category === "tahunan" ? ", saldo cuti dikembalikan" : ""), "success");
  load(user);
}
