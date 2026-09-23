import { supabase } from "../supabaseClient.js";
import { toast, fmtDateTime, confirmDialog } from "../core.js";

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Approval Perubahan Data</h1>
      <select id="filter-status">
        <option value="pending">Menunggu</option>
        <option value="approved">Disetujui</option>
        <option value="rejected">Ditolak</option>
        <option value="all">Semua</option>
      </select>
    </div>
    <p class="muted small" style="margin-top:-14px;">Pengajuan koreksi data dari menu "Profil Saya" karyawan — menyetujui akan langsung menimpa data lama di Data Karyawan.</p>
    <div id="pcr-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("filter-status").addEventListener("change", () => load(user));
  load(user);
}

async function load(user) {
  const status = document.getElementById("filter-status").value;
  let query = supabase
    .from("profile_change_requests")
    .select("*, profiles!profile_change_requests_user_id_fkey(full_name, department, employee_code)")
    .order("created_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  const el = document.getElementById("pcr-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Tidak ada pengajuan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Karyawan</th><th>Field</th><th>Dari</th><th>Menjadi</th><th>Alasan</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${escapeHtml(r.profiles?.full_name || "-")}<br><span class="muted small">${escapeHtml(r.profiles?.employee_code || "-")}</span></td>
            <td>${escapeHtml(r.field_label)}</td>
            <td class="muted">${escapeHtml(r.old_value || "-")}</td>
            <td>${escapeHtml(r.new_value)}</td>
            <td>${escapeHtml(r.reason)}</td>
            <td>
              <span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span>
              ${r.status !== "pending" ? `<br><span class="muted small">${fmtDateTime(r.reviewed_at)}</span>` : ""}
            </td>
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
    `Field: ${row.field_label}`,
    `Dari: ${row.old_value || "-"}`,
    `Menjadi: ${row.new_value}`,
    `Alasan: ${row.reason}`,
    status === "approved" ? "\nData di profil karyawan ini akan langsung diperbarui." : "",
  ].join("\n");

  const ok = await confirmDialog({
    title: status === "approved" ? "Setujui perubahan data ini?" : "Tolak pengajuan ini?",
    message: detail,
    confirmLabel: status === "approved" ? "Ya, Setujui & Terapkan" : "Ya, Tolak",
    confirmClass: status === "approved" ? "btn-primary" : "btn-secondary",
  });
  if (!ok) return;
  decide(row, status, user);
}

async function decide(row, status, user) {
  if (status === "approved") {
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({ [row.field_key]: row.new_value })
      .eq("id", row.user_id);
    if (profileErr) { toast("Gagal menerapkan perubahan ke profil: " + profileErr.message, "error"); return; }
  }
  const { error } = await supabase.from("profile_change_requests").update({
    status, reviewed_by: user.id, reviewed_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (error) { toast("Gagal memperbarui status pengajuan: " + error.message, "error"); return; }
  toast(status === "approved" ? "Perubahan data disetujui & diterapkan" : "Pengajuan ditolak", "success");
  load(user);
}

function statusLabel(s) { return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s; }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
