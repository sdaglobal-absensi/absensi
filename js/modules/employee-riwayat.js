import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime, dateOnlyISO } from "../core.js";

export async function render(container, user) {
  const now = new Date();
  container.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>Riwayat Absensi Saya</h1>
        <p class="pg-head-sub">Rekap check-in dan check-out kamu per bulan.</p>
      </div>
      <label class="inline-field">Bulan
        <input type="month" id="filter-month" value="${dateOnlyISO(now).slice(0, 7)}">
      </label>
    </div>
    <div id="summary-cards" class="dash-stats"></div>
    <div id="riwayat-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("filter-month").addEventListener("change", () => load(user));
  load(user);
}

async function load(user) {
  const month = document.getElementById("filter-month").value; // "2026-09"
  const start = `${month}-01`;
  const end = dateOnlyISO(new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0));

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

  const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  summary.innerHTML = `
    <div class="dash-stat ${hadir ? "ok" : ""}">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>')}</span><span class="dash-stat-label">Hadir</span></div>
      <div class="dash-stat-value ${hadir ? "" : "empty"}">${hadir}<span class="dash-stat-unit">hari</span></div>
    </div>
    <div class="dash-stat ${telat ? "warn" : ""}">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>')}</span><span class="dash-stat-label">Telat</span></div>
      <div class="dash-stat-value ${telat ? "" : "empty"}">${telat}<span class="dash-stat-unit">hari</span></div>
    </div>
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
            <td>${r.check_out ? fmtTime(r.check_out) : `<span class="muted">Belum</span>`}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}
