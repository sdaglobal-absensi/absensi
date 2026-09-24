import { toast, fmtDate } from "../core.js";
import { esc, loadApprovalList, canDecide, stepsHTML, askDecision, decideRequest } from "../approvalHelper.js";

// Approval Izin BERTINGKAT — daftar hanya berisi pengajuan yang melibatkan
// user ini sebagai approver (Super Admin: semua). Tombol Setujui/Tolak baru
// muncul saat GILIRAN user ini (tahap sebelumnya sudah selesai).
export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Approval Izin</h1>
        <p class="muted">Pengajuan yang menunggu persetujuanmu sesuai struktur organisasi. Kalau ada beberapa tingkat, tombol Setujui/Tolak baru muncul saat tiba giliranmu.</p>
      </div>
      <select id="filter-status">
        <option value="pending">Menunggu</option>
        <option value="approved">Disetujui</option>
        <option value="rejected">Ditolak</option>
        <option value="all">Semua</option>
      </select>
    </div>
    <div id="izin-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("filter-status").addEventListener("change", () => load(user));
  load(user);
}

async function load(user) {
  const status = document.getElementById("filter-status").value;
  const el = document.getElementById("izin-table");
  const { data, steps, error } = await loadApprovalList(
    "leave", user, status, "*, profiles!leave_requests_user_id_fkey(full_name, department)"
  );
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Tidak ada pengajuan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Karyawan</th><th>Jenis</th><th>Periode</th><th>Alasan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${esc(r.profiles?.full_name || "-")}${r.profiles?.department ? `<div class="small muted">${esc(r.profiles.department)}</div>` : ""}</td>
            <td class="capitalize">${esc(r.type)}</td>
            <td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
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
    `Jenis: ${row.type}`,
    `Periode: ${fmtDate(row.start_date)} – ${fmtDate(row.end_date)}`,
    `Alasan: ${row.reason}`,
  ].join("\n");

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

function statusLabel(s) { return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s; }
