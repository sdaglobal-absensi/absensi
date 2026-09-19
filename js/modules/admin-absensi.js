import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime, todayISO } from "../core.js";

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Monitor Absensi</h1>
      <div class="filter-row">
        <input type="date" id="filter-date" value="${todayISO()}">
        <input type="text" id="filter-search" placeholder="Cari nama karyawan…">
      </div>
    </div>
    <div id="absensi-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("filter-date").addEventListener("change", load);
  document.getElementById("filter-search").addEventListener("input", load);
  load();
}

async function load() {
  const date = document.getElementById("filter-date").value;
  const search = document.getElementById("filter-search").value.toLowerCase();

  const { data, error } = await supabase
    .from("attendance")
    .select("*, profiles(full_name, department, employee_code)")
    .eq("date", date)
    .order("check_in", { ascending: true });

  const el = document.getElementById("absensi-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  const filtered = search
    ? data.filter(r => r.profiles?.full_name?.toLowerCase().includes(search))
    : data;

  if (!filtered.length) { el.innerHTML = `<p class="muted">Belum ada data absensi untuk tanggal ini.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Karyawan</th><th>Departemen</th><th>Check-in</th><th>Status</th><th>Lokasi</th><th>Foto Check-in</th><th>Check-out</th><th>Foto Check-out</th></tr></thead>
      <tbody>
        ${filtered.map(r => `
          <tr>
            <td>${r.profiles?.full_name || "-"}</td>
            <td>${r.profiles?.department || "-"}</td>
            <td>${fmtTime(r.check_in)}</td>
            <td>${r.check_in_status ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : "-"}</td>
            <td>${locationCell(r)}</td>
            <td>${photoCell(r.check_in_photo_url)}</td>
            <td>${fmtTime(r.check_out)}</td>
            <td>${photoCell(r.check_out_photo_url)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function locationCell(r) {
  if (r.check_in_lat == null) return "-";
  const dist = r.check_in_distance_m != null ? `${r.check_in_distance_m}m dari kantor` : "";
  const link = `https://www.google.com/maps?q=${r.check_in_lat},${r.check_in_lng}`;
  return `<a href="${link}" target="_blank" rel="noopener" class="btn-link">Lihat peta</a><br><span class="small muted">${dist}</span>`;
}

function photoCell(url) {
  if (!url) return "-";
  return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" class="thumb"></a>`;
}
