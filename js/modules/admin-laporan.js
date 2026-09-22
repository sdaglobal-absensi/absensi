import { supabase } from "../supabaseClient.js";
import { exportCSV, fmtDate, dateOnlyISO } from "../core.js";

export async function render(container) {
  const now = new Date();
  container.innerHTML = `
    <div class="page-header">
      <h1>Laporan Bulanan</h1>
      <div class="filter-row">
        <input type="month" id="filter-month" value="${dateOnlyISO(now).slice(0, 7)}">
        <button id="btn-export" class="btn-secondary">Export CSV</button>
      </div>
    </div>
    <div id="laporan-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("filter-month").addEventListener("change", load);
  document.getElementById("btn-export").addEventListener("click", doExport);
  load();
}

let lastRows = [];

async function load() {
  const month = document.getElementById("filter-month").value;
  const start = `${month}-01`;
  const end = dateOnlyISO(new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0));

  const [{ data: profiles }, { data: attendance }, { data: leaves }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, department").eq("is_active", true),
    supabase.from("attendance").select("*").gte("date", start).lte("date", end),
    supabase.from("leave_requests").select("*").eq("status", "approved")
      .lte("start_date", end).gte("end_date", start),
  ]);

  const rows = profiles.map(p => {
    const att = attendance.filter(a => a.user_id === p.id);
    const hadir = att.filter(a => a.check_in).length;
    const telat = att.filter(a => a.check_in_status === "telat").length;
    const izin = leaves.filter(l => l.user_id === p.id).length;
    return {
      Nama: p.full_name,
      Departemen: p.department || "-",
      "Hari Hadir": hadir,
      "Hari Telat": telat,
      "Izin/Cuti/Sakit": izin,
    };
  });

  lastRows = rows;
  const el = document.getElementById("laporan-table");
  if (!rows.length) { el.innerHTML = `<p class="muted">Tidak ada data.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Departemen</th><th>Hari Hadir</th><th>Hari Telat</th><th>Izin/Cuti/Sakit</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${r.Nama}</td><td>${r.Departemen}</td>
            <td>${r["Hari Hadir"]}</td><td>${r["Hari Telat"]}</td><td>${r["Izin/Cuti/Sakit"]}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function doExport() {
  const month = document.getElementById("filter-month").value;
  exportCSV(`laporan-absensi-${month}.csv`, lastRows);
}
