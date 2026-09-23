import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, confirmDialog } from "../core.js";

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Approval Izin</h1>
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
  let query = supabase
    .from("leave_requests")
    .select("*, profiles!leave_requests_user_id_fkey(full_name, department)")
    .order("created_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  const el = document.getElementById("izin-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Tidak ada pengajuan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Karyawan</th><th>Jenis</th><th>Periode</th><th>Alasan</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.profiles?.full_name || "-"}</td>
            <td class="capitalize">${r.type}</td>
            <td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
            <td>${escapeHtml(r.reason)}</td>
            <td><span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span></td>
            <td>
              ${r.status === "pending" ? `
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

async function confirmDecide(id, status, user, allData) {
  const row = allData.find(r => r.id === id);
  const detail = [
    `Karyawan: ${row.profiles?.full_name || "-"}`,
    `Jenis: ${row.type}`,
    `Periode: ${fmtDate(row.start_date)} – ${fmtDate(row.end_date)}`,
    `Alasan: ${row.reason}`,
  ].join("\n");

  const ok = await confirmDialog({
    title: status === "approved" ? "Setujui pengajuan ini?" : "Tolak pengajuan ini?",
    message: detail,
    confirmLabel: status === "approved" ? "Ya, Setujui" : "Ya, Tolak",
    confirmClass: status === "approved" ? "btn-primary" : "btn-secondary",
  });
  if (!ok) return;
  decide(id, status, user);
}

async function decide(id, status, user) {
  const { error } = await supabase.from("leave_requests").update({
    status, reviewed_by: user.id, reviewed_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) { toast("Gagal memperbarui: " + error.message, "error"); return; }
  toast(status === "approved" ? "Pengajuan disetujui" : "Pengajuan ditolak", "success");
  load(user);
}

function statusLabel(s) { return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
