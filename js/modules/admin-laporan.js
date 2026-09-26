import { supabase } from "../supabaseClient.js";
import { exportCSV, exportXLSX, dateOnlyISO, jenisHubunganKerjaLabel } from "../core.js";

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

export async function render(container) {
  const now = new Date();
  container.innerHTML = `
    <div class="page-header">
      <h1>Laporan Bulanan</h1>
      <div class="filter-row">
        <input type="month" id="filter-month" value="${dateOnlyISO(now).slice(0, 7)}">
        <select id="filter-dept"><option value="">Semua Departemen</option></select>
        <select id="filter-jenis">
          <option value="">Semua Hubungan Kerja</option>
          <option value="karyawan_tetap">Karyawan Tetap</option>
          <option value="pkwt">PKWT</option>
          <option value="outsourcing">Outsourcing</option>
        </select>
        <button id="btn-print" class="btn-secondary no-print">🖨️ Cetak</button>
        <button id="btn-export-xlsx" class="btn-secondary no-print">Export Excel</button>
        <button id="btn-export-csv" class="btn-secondary no-print">Export CSV</button>
      </div>
    </div>

    <div class="report-print-head">
      <h1>Laporan Kehadiran Karyawan</h1>
      <p class="muted" id="report-print-period"></p>
    </div>

    <div class="status-grid" id="laporan-summary"><p class="muted">Memuat…</p></div>

    <p class="report-meta" id="laporan-meta"></p>

    <div id="laporan-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("filter-month").addEventListener("change", load);
  document.getElementById("filter-dept").addEventListener("change", renderTable);
  document.getElementById("filter-jenis").addEventListener("change", renderTable);
  document.getElementById("btn-export-csv").addEventListener("click", () => doExport("csv"));
  document.getElementById("btn-export-xlsx").addEventListener("click", () => doExport("xlsx"));
  document.getElementById("btn-print").addEventListener("click", () => window.print());

  load();
}

let allRows = []; // hasil hitung per karyawan sebelum difilter departemen
let currentMonthLabel = "";

async function load() {
  const month = document.getElementById("filter-month").value;
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = dateOnlyISO(new Date(y, m, 0));
  const workingDays = countWorkingDays(y, m); // perkiraan (Senin-Sabtu), belum memperhitungkan hari libur khusus

  currentMonthLabel = `${MONTH_NAMES[m - 1]} ${y}`;
  document.getElementById("report-print-period").textContent =
    `Periode: ${currentMonthLabel} — dicetak ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;

  const [{ data: profiles }, { data: attendance }, { data: leaves }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, department, jenis_hubungan_kerja, unit_pt").eq("is_active", true).order("full_name"),
    supabase.from("attendance").select("user_id, check_in, check_in_status").gte("date", start).lte("date", end),
    supabase.from("leave_requests").select("user_id").eq("status", "approved").lte("start_date", end).gte("end_date", start),
  ]);

  // Isi dropdown departemen (sekali per load, tanpa menghapus pilihan user kalau masih valid)
  const deptSelect = document.getElementById("filter-dept");
  const prevDept = deptSelect.value;
  const depts = [...new Set((profiles || []).map(p => p.department).filter(Boolean))].sort();
  deptSelect.innerHTML = `<option value="">Semua Departemen</option>` + depts.map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join("");
  deptSelect.value = depts.includes(prevDept) ? prevDept : "";

  allRows = (profiles || []).map(p => {
    const att = (attendance || []).filter(a => a.user_id === p.id);
    const hadir = att.filter(a => a.check_in).length;
    const telat = att.filter(a => a.check_in_status === "telat").length;
    const izin = (leaves || []).filter(l => l.user_id === p.id).length;
    const rate = workingDays > 0 ? Math.min(100, Math.round((hadir / workingDays) * 100)) : 0;
    return {
      Nama: p.full_name,
      Departemen: p.department || "-",
      "Hubungan Kerja": jenisHubunganKerjaLabel(p.jenis_hubungan_kerja),
      "Unit / PT": p.unit_pt || "-",
      "Hari Hadir": hadir,
      "Hari Telat": telat,
      "Izin/Cuti/Sakit": izin,
      "Tingkat Kehadiran (%)": rate,
    };
  });

  document.getElementById("laporan-meta").textContent =
    `Estimasi hari kerja periode ini: ${workingDays} hari (Senin–Sabtu, belum memperhitungkan hari libur khusus).`;

  renderSummary(workingDays);
  renderTable();
}

function renderSummary(workingDays) {
  const el = document.getElementById("laporan-summary");
  const totalKaryawan = allRows.length;
  const totalHadir = allRows.reduce((s, r) => s + r["Hari Hadir"], 0);
  const totalTelat = allRows.reduce((s, r) => s + r["Hari Telat"], 0);
  const totalIzin = allRows.reduce((s, r) => s + r["Izin/Cuti/Sakit"], 0);
  const avgRate = totalKaryawan ? Math.round(allRows.reduce((s, r) => s + r["Tingkat Kehadiran (%)"], 0) / totalKaryawan) : 0;

  el.innerHTML = `
    <div class="status-card">
      <span class="status-label">Total Karyawan Aktif</span>
      <span class="status-value">${totalKaryawan}</span>
    </div>
    <div class="status-card ${avgRate >= 90 ? "done" : ""}">
      <span class="status-label">Rata-rata Kehadiran</span>
      <span class="status-value">${avgRate}%</span>
      <span class="muted small">dari estimasi ${workingDays} hari kerja</span>
    </div>
    <div class="status-card">
      <span class="status-label">Total Keterlambatan</span>
      <span class="status-value">${totalTelat}</span>
    </div>
    <div class="status-card">
      <span class="status-label">Total Izin/Cuti/Sakit</span>
      <span class="status-value">${totalIzin}</span>
    </div>
  `;
}

function filteredRows() {
  const dept = document.getElementById("filter-dept").value;
  const jenis = document.getElementById("filter-jenis").value;
  return allRows
    .filter(r => !dept || r.Departemen === dept)
    .filter(r => !jenis || r["Hubungan Kerja"] === jenisHubunganKerjaLabel(jenis));
}

function renderTable() {
  const rows = filteredRows();
  const el = document.getElementById("laporan-table");
  if (!rows.length) { el.innerHTML = `<p class="muted">Tidak ada data.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead>
        <tr><th>Nama</th><th>Departemen</th><th>Hubungan Kerja</th><th>Hari Hadir</th><th>Hari Telat</th><th>Izin/Cuti/Sakit</th><th>Tingkat Kehadiran</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(r.Nama)}</td>
            <td>${escapeHtml(r.Departemen)}</td>
            <td>
              <span class="badge ${r["Hubungan Kerja"] === "Outsourcing" ? "badge-warn" : "badge-ok"}">${escapeHtml(r["Hubungan Kerja"])}</span>
              ${r["Hubungan Kerja"] === "Outsourcing" ? `<br><span class="muted small">${escapeHtml(r["Unit / PT"])}</span>` : ""}
            </td>
            <td>${r["Hari Hadir"]}</td>
            <td>${r["Hari Telat"] > 0 ? `<span class="badge badge-warn">${r["Hari Telat"]}</span>` : "0"}</td>
            <td>${r["Izin/Cuti/Sakit"]}</td>
            <td><span class="badge badge-${rateTone(r["Tingkat Kehadiran (%)"])}">${r["Tingkat Kehadiran (%)"]}%</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function rateTone(rate) {
  if (rate >= 90) return "ok";
  if (rate >= 75) return "warn";
  return "danger";
}

// Senin-Sabtu dianggap hari kerja (perkiraan kasar; tidak menyaring hari
// libur nasional/Master Hari Libur supaya laporan ini tetap ringan & cepat).
function countWorkingDays(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay(); // 0 = Minggu
    if (dow !== 0) count++;
  }
  return count;
}

function doExport(kind) {
  const dept = document.getElementById("filter-dept").value;
  const jenis = document.getElementById("filter-jenis").value;
  const rows = filteredRows();
  const month = document.getElementById("filter-month").value;
  const suffix = (dept ? `-${dept}` : "") + (jenis ? `-${jenis}` : "");
  if (kind === "xlsx") {
    exportXLSX(`laporan-absensi-${month}${suffix}.xlsx`, rows, "Laporan");
  } else {
    exportCSV(`laporan-absensi-${month}${suffix}.csv`, rows);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
