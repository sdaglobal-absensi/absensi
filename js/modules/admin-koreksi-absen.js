import { toast, fmtDate, fmtTime } from "../core.js";
import { esc, loadApprovalList, canDecide, stepsHTML, askDecision, decideRequest } from "../approvalHelper.js";
import {
  pageHTML, initToolbar, filterAndSort, setMeta, emptyHTML, errorHTML,
  employeeCell, statusPill, cell, actionsCell, reviewNote, tableHTML, bindActions,
} from "../approvalUI.js";
import { fetchAttempts, historyBlockHTML, historyButton, openApproverHistory } from "../requestHistory.js";

// Approval Koreksi Absen BERTINGKAT — sama persis alurnya dengan Approval
// Izin/Lembur (daftar hanya berisi pengajuan yang melibatkan user ini
// sebagai approver; Super Admin: semua). Begitu disetujui sampai tahap
// terakhir, jam yang diajukan otomatis diterapkan ke tabel attendance oleh
// database (lihat supabase-koreksi-absen.sql) — tidak ada langkah manual
// tambahan di sini.
let state = { data: [], steps: {} };
let ui;
let seq = 0; // cegah respons lama menimpa respons baru saat tab cepat berganti

export async function render(container, user) {
  container.innerHTML = pageHTML({
    title: "Approval Koreksi Absen",
    subtitle: "Pengajuan koreksi absen (lupa absen masuk/pulang) yang menunggu persetujuanmu sesuai struktur organisasi. Disetujui -> jam yang diajukan otomatis diterapkan ke data absensi.",
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
    "koreksi", user, ui.status,
    "*, profiles!attendance_correction_requests_user_id_fkey(full_name, department, employee_code, photo_url)"
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
      typeLabel(r.correction_type), r.reason, r.review_notes, fmtDate(r.attendance_date),
    ].join(" "),
  });
  setMeta(rows.length, data.length, ui);
  if (!rows.length) { el.innerHTML = emptyHTML(ui, data.length); return; }

  el.innerHTML = tableHTML(
    ["Karyawan", "Tanggal & Jenis", "Jam Seharusnya", "Alasan", "Status", "Tahap Approval", ""],
    rows.map(r => `
      <tr>
        ${cell("Karyawan", employeeCell(r.profiles), "ap-td-emp")}
        ${cell("Tanggal", `<span class="ap-chip">${esc(typeLabel(r.correction_type))}</span><div class="ap-main">${fmtDate(r.attendance_date)}</div>`)}
        ${cell("Jam", fmtTime(r.corrected_time))}
        ${cell("Alasan", `<div class="ap-reason">${esc(r.reason)}</div>${reviewNote(r)}`)}
        ${cell("Status", `${statusPill(r.status)}<div class="ap-sub">Diajukan ${fmtDate(r.created_at)}</div>${historyButton(r)}`)}
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
    if (row) openApproverHistory("koreksi", row, `Riwayat Koreksi Absen — ${row.profiles?.full_name || "-"}`, describe);
  }));
}

// Ringkasan satu pengajuan koreksi untuk daftar riwayat.
function describe(r) {
  return `<span class="ap-chip">${esc(typeLabel(r.correction_type))}</span> ${fmtDate(r.attendance_date)} · ${fmtTime(r.corrected_time)}<div class="hist-reason">${esc(r.reason)}</div>`;
}

function typeLabel(t) {
  return t === "masuk" ? "Lupa Absen Masuk" : "Lupa Absen Pulang";
}

async function confirmDecide(id, decision, user) {
  const row = state.data.find(r => r.id === id);
  if (!row) return;
  const detail = [
    ["Karyawan", row.profiles?.full_name || "-"],
    ["Jenis", typeLabel(row.correction_type)],
    ["Tanggal", fmtDate(row.attendance_date)],
    ["Jam Seharusnya", fmtTime(row.corrected_time)],
    ["Alasan", row.reason],
  ];

  // Pengajuan ulang: tampilkan riwayat pengajuan sebelumnya (setuju/tolak) di popup.
  const hist = row.revision_of ? await fetchAttempts("koreksi", row) : null;
  const res = await askDecision({
    title: decision === "approved" ? "Setujui koreksi absen ini?" : "Tolak koreksi absen ini?",
    detail, decision,
    extraHTML: hist ? historyBlockHTML(row, hist, describe) : "",
  });
  if (!res) return;

  const { status, error } = await decideRequest("koreksi", id, decision, res.notes);
  if (error) { toast("Gagal memperbarui: " + error.message, "error"); load(user); return; }
  toast(
    decision === "rejected" ? "Pengajuan ditolak"
      : status === "approved" ? "Pengajuan disetujui — jam absensi sudah diperbarui otomatis"
      : "Disetujui — diteruskan ke tahap berikutnya",
    "success"
  );
  load(user);
}
