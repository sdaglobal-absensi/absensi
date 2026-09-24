import { toast, fmtDate, fmtJam, roundOvertimeHours } from "../core.js";
import { esc, loadApprovalList, canDecide, stepsHTML, askDecision, decideRequest } from "../approvalHelper.js";
import {
  pageHTML, initToolbar, filterAndSort, setMeta, emptyHTML, errorHTML,
  employeeCell, statusPill, cell, actionsCell, reviewNote, tableHTML, bindActions,
} from "../approvalUI.js";

// Approval Lembur BERTINGKAT — sama polanya dengan Approval Izin: hanya
// pengajuan yang melibatkan user ini sebagai approver (Super Admin: semua),
// tombol baru muncul saat gilirannya. Pencarian & urut abjad di browser.
let state = { data: [], steps: {} };
let ui;
let seq = 0;

const jam = r => fmtJam(r.total_jam ?? roundOvertimeHours(r.start_time, r.end_time));
const hari = r => (r.is_hari_libur ? "Hari Libur" : "Hari Biasa");

export async function render(container, user) {
  container.innerHTML = pageHTML({
    title: "Approval Lembur",
    subtitle: "Pengajuan lembur yang menunggu persetujuanmu sesuai struktur organisasi.",
    searchPlaceholder: "Cari nama, tanggal, keterangan…",
  });
  ui = initToolbar(container, { onStatus: () => load(user), onView: () => paint(user) });
  await load(user);
}

async function load(user) {
  const my = ++seq;
  const el = document.getElementById("ap-table");
  el.innerHTML = `<p class="muted ap-loading">Memuat…</p>`;
  const res = await loadApprovalList(
    "overtime", user, ui.status,
    "*, profiles!overtime_requests_user_id_fkey(full_name, department, employee_code, photo_url)"
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
      r.reason, r.review_notes, fmtDate(r.date), hari(r),
    ].join(" "),
  });
  setMeta(rows.length, data.length, ui);
  if (!rows.length) { el.innerHTML = emptyHTML(ui, data.length); return; }

  el.innerHTML = tableHTML(
    ["Karyawan", "Waktu Lembur", "Keterangan", "Status", "Tahap Approval", ""],
    rows.map(r => `
      <tr>
        ${cell("Karyawan", employeeCell(r.profiles), "ap-td-emp")}
        ${cell("Waktu", `
          <span class="ap-chip ${r.is_hari_libur ? "ap-chip-accent" : ""}">${hari(r)}</span>
          <div class="ap-main ap-main-gap"><span class="nw">${fmtDate(r.date)}</span></div>
          <div class="ap-sub"><span class="nw">${esc(r.start_time?.slice(0, 5))} – ${esc(r.end_time?.slice(0, 5))}</span> · <span class="nw">${jam(r)}</span></div>`)}
        ${cell("Keterangan", `<div class="ap-reason">${esc(r.reason)}</div>${reviewNote(r)}`)}
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

async function confirmDecide(id, decision, user) {
  const row = state.data.find(r => r.id === id);
  if (!row) return;
  const detail = [
    ["Karyawan", row.profiles?.full_name || "-"],
    ["Tanggal", fmtDate(row.date)],
    ["Jam", `${row.start_time?.slice(0, 5)} – ${row.end_time?.slice(0, 5)} (${jam(row)})`],
    ["Jenis Hari", hari(row)],
    ["Keterangan", row.reason],
  ];

  const res = await askDecision({
    title: decision === "approved" ? "Setujui lembur ini?" : "Tolak lembur ini?",
    detail, decision,
  });
  if (!res) return;

  const { status, error } = await decideRequest("overtime", id, decision, res.notes);
  if (error) { toast("Gagal memperbarui: " + error.message, "error"); load(user); return; }
  toast(
    decision === "rejected" ? "Lembur ditolak"
      : status === "approved" ? "Lembur disetujui (semua tahap selesai)"
      : "Disetujui — diteruskan ke tahap berikutnya",
    "success"
  );
  load(user);
}
