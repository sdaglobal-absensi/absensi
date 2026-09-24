import { toast, fmtDate } from "../core.js";
import { esc, loadApprovalList, canDecide, stepsHTML, askDecision, decideRequest } from "../approvalHelper.js";
import {
  pageHTML, initToolbar, filterAndSort, setMeta, emptyHTML, errorHTML,
  employeeCell, statusPill, cell, actionsCell, reviewNote, tableHTML, bindActions,
} from "../approvalUI.js";

// Approval Izin BERTINGKAT — daftar hanya berisi pengajuan yang melibatkan
// user ini sebagai approver (Super Admin: semua). Tombol Setujui/Tolak baru
// muncul saat GILIRAN user ini (tahap sebelumnya sudah selesai).
// Pencarian & urut abjad dikerjakan di browser atas data yang sudah dimuat.
let state = { data: [], steps: {} };
let ui;
let seq = 0; // cegah respons lama menimpa respons baru saat tab cepat berganti

export async function render(container, user) {
  container.innerHTML = pageHTML({
    title: "Approval Izin",
    subtitle: "Pengajuan yang menunggu persetujuanmu sesuai struktur organisasi. Kalau ada beberapa tingkat, tombol Setujui/Tolak baru muncul saat tiba giliranmu.",
    searchPlaceholder: "Cari nama, jenis, atau alasan…",
  });
  ui = initToolbar(container, { onStatus: () => load(user), onView: () => paint(user) });
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
  state = { data: res.data, steps: res.steps };
  paint(user);
}

function paint(user) {
  const el = document.getElementById("ap-table");
  const { data, steps } = state;

  const rows = filterAndSort(data, ui, {
    name: r => r.profiles?.full_name,
    text: r => [
      r.profiles?.full_name, r.profiles?.employee_code, r.profiles?.department,
      r.type, r.reason, r.review_notes, fmtDate(r.start_date), fmtDate(r.end_date),
    ].join(" "),
  });
  setMeta(rows.length, data.length, ui);
  if (!rows.length) { el.innerHTML = emptyHTML(ui, data.length); return; }

  el.innerHTML = tableHTML(
    ["Karyawan", "Jenis & Periode", "Alasan", "Status", "Tahap Approval", ""],
    rows.map(r => `
      <tr>
        ${cell("Karyawan", employeeCell(r.profiles), "ap-td-emp")}
        ${cell("Periode", `<span class="ap-chip">${esc(r.type)}</span>${periodHTML(r)}`)}
        ${cell("Alasan", `<div class="ap-reason">${esc(r.reason)}</div>${reviewNote(r)}`)}
        ${cell("Status", `${statusPill(r.status)}<div class="ap-sub">Diajukan ${fmtDate(r.created_at)}</div>`)}
        ${cell("Tahap", stepsHTML(r, steps[r.id]), "ap-td-steps")}
        ${actionsCell(r, canDecide(r, steps[r.id], user))}
      </tr>
    `).join("")
  );

  bindActions(el,
    id => confirmDecide(id, "approved", user),
    id => confirmDecide(id, "rejected", user));
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

async function confirmDecide(id, decision, user) {
  const row = state.data.find(r => r.id === id);
  if (!row) return;
  const detail = [
    ["Karyawan", row.profiles?.full_name || "-"],
    ["Jenis", row.type],
    ["Periode", `${fmtDate(row.start_date)} – ${fmtDate(row.end_date)}`],
    ["Alasan", row.reason],
  ];

  const res = await askDecision({
    title: decision === "approved" ? "Setujui pengajuan ini?" : "Tolak pengajuan ini?",
    detail, decision,
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
