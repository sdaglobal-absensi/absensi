import { supabase } from "../supabaseClient.js";
import { toast, fmtDate } from "../core.js";

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Izin</h1>
      <p class="muted">Ajukan izin, sakit, atau cuti</p>
    </div>

    <form id="form-izin" class="card form-card">
      <div class="form-row">
        <label>Jenis
          <select name="type" required>
            <option value="izin">Izin</option>
            <option value="sakit">Sakit</option>
            <option value="cuti">Cuti</option>
          </select>
        </label>
      </div>
      <div class="form-row two-col">
        <label>Tanggal mulai <input type="date" name="start_date" required></label>
        <label>Tanggal selesai <input type="date" name="end_date" required></label>
      </div>
      <div class="form-row">
        <label>Alasan <textarea name="reason" rows="3" required placeholder="Jelaskan alasan pengajuan"></textarea></label>
      </div>
      <button type="submit" class="btn-primary">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan</h2>
    <div id="izin-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("form-izin").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      user_id: user.id,
      type: fd.get("type"),
      start_date: fd.get("start_date"),
      end_date: fd.get("end_date"),
      reason: fd.get("reason"),
    };
    const { error } = await supabase.from("leave_requests").insert(payload);
    if (error) { toast("Gagal mengirim: " + error.message, "error"); return; }
    toast("Pengajuan terkirim, menunggu approval", "success");
    e.target.reset();
    loadList(user);
  });

  loadList(user);
}

async function loadList(user) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("izin-list");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Jenis</th><th>Periode</th><th>Alasan</th><th>Status</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td class="capitalize">${r.type}</td>
            <td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
            <td>${escapeHtml(r.reason)}</td>
            <td><span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
