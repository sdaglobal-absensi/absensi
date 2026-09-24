import { toast, fmtDate, fmtJam, roundOvertimeHours } from "../core.js";
import { esc, loadApprovalList, canDecide, stepsHTML, askDecision, decideRequest } from "../approvalHelper.js";

// Approval Lembur BERTINGKAT — sama polanya dengan Approval Izin: hanya
// pengajuan yang melibatkan user ini sebagai approver (Super Admin: semua),
// tombol baru muncul saat gilirannya.
export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Approval Lembur</h1>
        <p class="muted">Pengajuan lembur yang menunggu persetujuanmu sesuai struktur organisasi.</p>
      </div>
      <select id="filter-status">
        <option value="pending">Menunggu</option>
        <option value="approved">Disetujui</option>
        <option value="rejected">Ditolak</option>
        <option value="all">Semua</option>
      </select>
    </div>
    <div id="lembur-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("filter-status").addEventListener("change", () => load(user));
  load(user);
}

async function load(user) {
  const status = document.getElementById("filter-status").value;
  const el = document.getElementById("lembur-table");
  const { data, steps, error } = await loadApprovalList(
    "overtime", user, status, "*, profiles!overtime_requests_user_id_fkey(full_name, department)"
  );
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Tidak ada pengajuan.</p>`; return; }

  const jam = r => fmtJam(r.total_jam ?? roundOvertimeHours(r.start_time, r.end_time));
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Karyawan</th><th>Tanggal</th><th>Jam</th><th>Total Jam</th><th>Jenis Hari</th><th>Keterangan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${esc(r.profiles?.full_name || "-")}${r.profiles?.department ? `<div class="small muted">${esc(r.profiles.department)}</div>` : ""}</td>
            <td>${fmtDate(r.date)}</td>
            <td>${r.start_time?.slice(0, 5)} – ${r.end_time?.slice(0, 5)}</td>
            <td>${jam(r)}</td>
            <td>${r.is_hari_libur ? "Hari Libur" : "Hari Biasa"}</td>
            <td>${esc(r.reason)}${r.review_notes && r.status !== "pending" ? `<div class="small muted">Catatan: ${esc(r.review_notes)}</div>` : ""}</td>
            <td><span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span></td>
            <td>${stepsHTML(r, steps[r.id])}</td>
            <td>
              ${canDecide(r, steps[r.id], user) ? `
                <button class="btn-link btn-approve" data-id="${r.id}">Setujui</button>
                <button class="btn-link btn-reject" data-id="${r.id}">Tolak</button>
              ` : ""}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-approve").forEach(b => b.addEventListener("click", () => confirmDecide(b.dataset.id, "approved", user, data)));
  el.querySelectorAll(".btn-reject").forEach(b => b.addEventListener("click", () => confirmDecide(b.dataset.id, "rejected", user, data)));
}

async function confirmDecide(id, decision, user, allData) {
  const row = allData.find(r => r.id === id);
  const detail = [
    `Karyawan: ${row.profiles?.full_name || "-"}`,
    `Tanggal: ${fmtDate(row.date)}`,
    `Jam: ${row.start_time?.slice(0, 5)} – ${row.end_time?.slice(0, 5)} (${fmtJam(row.total_jam ?? roundOvertimeHours(row.start_time, row.end_time))})`,
    `Jenis Hari: ${row.is_hari_libur ? "Hari Libur" : "Hari Biasa"}`,
    `Keterangan: ${row.reason}`,
  ].join("\n");

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

function statusLabel(s) { return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s; }
