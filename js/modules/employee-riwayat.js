import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime } from "../core.js";

export async function render(container, user) {
  const now = new Date();
  container.innerHTML = `
    <div class="page-header">
      <h1>Riwayat Absensi Saya</h1>
      <label class="inline-field">Bulan
        <input type="month" id="filter-month" value="${now.toISOString().slice(0, 7)}">
      </label>
    </div>
    <div id="summary-cards" class="status-grid"></div>
    <div id="riwayat-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("filter-month").addEventListener("change", () => load(user));
  load(user);
}

async function load(user) {
  const month = document.getElementById("filter-month").value; // "2026-09"
  const start = `${month}-01`;
  const end = new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", user.id)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: false });

  const table = document.getElementById("riwayat-table");
  const summary = document.getElementById("summary-cards");

  if (error) { table.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }

  const hadir = data.filter(r => r.check_in).length;
  const telat = data.filter(r => r.check_in_status === "telat").length;

  summary.innerHTML = `
    <div class="status-card"><span class="status-label">Hadir</span><span class="status-value">${hadir} hari</span></div>
    <div class="status-card"><span class="status-label">Telat</span><span class="status-value">${telat} hari</span></div>
  `;

  if (!data.length) { table.innerHTML = `<p class="muted">Tidak ada data untuk bulan ini.</p>`; return; }

  table.innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal</th><th>Check-in</th><th>Status</th><th>Check-out</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${fmtTime(r.check_in)}</td>
            <td>${r.check_in_status ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : "-"}</td>
            <td>${fmtTime(r.check_out)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}
