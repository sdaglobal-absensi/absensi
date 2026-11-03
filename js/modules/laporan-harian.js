import { fmtTime, todayISO, exportXLSX, exportCSV, escapeHtml, jenisHubunganKerjaLabel } from "../core.js";
import { leaveTypeLabel } from "../leaveRules.js";
import { fetchDailyContext } from "../dailyAttendanceData.js";
import { summarize, matchesStatusFilter, addDaysISO, fmtDurasi, STATUS_LABEL, WORK_MODE_LABEL } from "../laporanHarian.js";

// =======================================================================
// LAPORAN HARIAN — kehadiran seluruh karyawan terjadwal pada SATU tanggal.
// Aturan status ada di js/laporanHarian.js (sama dengan Monitor Absensi &
// Analitik HR: hanya karyawan yang punya jadwal, jadwal diambil per tanggal,
// tukar shift & hari libur diperhitungkan).
// =======================================================================

const esc = escapeHtml;
const $ = id => document.getElementById(id);

let state = { rows: [], tanpaJadwal: 0, holiday: null, date: "", today: "", rules: [], scheduleName: {} };
let reqToken = 0;

const fmtLong = iso => new Date(iso + "T00:00:00Z").toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export async function renderHarian(host) {
  state = { rows: [], tanpaJadwal: 0, holiday: null, date: "", today: todayISO(), rules: [], scheduleName: {} };
  host.innerHTML = `
    <div class="pg-toolbar no-print">
      <div class="filter-row" style="flex-wrap:wrap;">
        <button type="button" id="hd-prev" class="btn-secondary" title="Hari sebelumnya" aria-label="Hari sebelumnya">◀</button>
        <input type="date" id="hd-date" max="${state.today}" value="${state.today}">
        <button type="button" id="hd-next" class="btn-secondary" title="Hari berikutnya" aria-label="Hari berikutnya">▶</button>
        <button type="button" id="hd-today" class="btn-secondary">Hari ini</button>
        <select id="hd-dept"><option value="">Semua Departemen</option></select>
        <select id="hd-jenis">
          <option value="">Semua Hubungan Kerja</option>
          <option value="karyawan_tetap">Karyawan Tetap</option>
          <option value="pkwt">PKWT</option>
          <option value="outsourcing">Outsourcing</option>
        </select>
        <select id="hd-status">
          <option value="">Semua Status</option>
          <option value="hadir">Hadir</option>
          <option value="hadir_tepat">Tepat waktu</option>
          <option value="hadir_telat">Terlambat</option>
          <option value="izin">Izin / Cuti / Sakit</option>
          <option value="absen">Tidak hadir / Belum check-in</option>
          <option value="libur">Libur</option>
          <option value="lupa_out">Lupa check-out</option>
        </select>
        <input type="search" id="hd-q" placeholder="Cari nama…" style="max-width:200px;">
        <button type="button" id="hd-print" class="btn-secondary">🖨️ Cetak</button>
        <button type="button" id="hd-xlsx" class="btn-secondary">Export Excel</button>
        <button type="button" id="hd-csv" class="btn-secondary">Export CSV</button>
      </div>
    </div>

    <div class="report-print-head">
      <h1>Laporan Kehadiran Harian</h1>
      <p class="muted" id="hd-print-period"></p>
    </div>

    <div id="hd-banner"></div>
    <div class="status-grid" id="hd-summary"><p class="muted">Memuat…</p></div>
    <p class="report-meta" id="hd-meta"></p>
    <div id="hd-table" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  const go = iso => { const d = iso > state.today ? state.today : iso; $("hd-date").value = d; load(); };
  $("hd-date").addEventListener("change", e => go(e.target.value || state.today));
  // Kolom tanggal bisa dikosongkan pengguna -> jatuh ke tanggal yang sedang ditampilkan.
  const cur = () => $("hd-date").value || state.date || state.today;
  $("hd-prev").addEventListener("click", () => go(addDaysISO(cur(), -1)));
  $("hd-next").addEventListener("click", () => go(addDaysISO(cur(), 1)));
  $("hd-today").addEventListener("click", () => go(state.today));
  ["hd-dept", "hd-jenis", "hd-status"].forEach(id => $(id).addEventListener("change", () => { renderSummary(); renderTable(); }));
  $("hd-q").addEventListener("input", renderTable);
  $("hd-print").addEventListener("click", () => window.print());
  $("hd-xlsx").addEventListener("click", () => doExport("xlsx"));
  $("hd-csv").addEventListener("click", () => doExport("csv"));
  $("hd-summary").addEventListener("click", e => {
    const card = e.target.closest("[data-filter]");
    if (!card) return;
    const sel = $("hd-status");
    sel.value = sel.value === card.dataset.filter ? "" : card.dataset.filter; // klik lagi = lepas filter
    renderSummary(); renderTable();
  });
  $("hd-summary").addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-filter]")) { e.preventDefault(); e.target.closest("[data-filter]").click(); }
  });

  load();
}

async function load() {
  const token = ++reqToken;
  const date = $("hd-date").value || state.today;
  state.date = date;
  $("hd-next").disabled = date >= state.today;
  $("hd-print-period").textContent = `${fmtLong(date)} — dicetak ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  $("hd-table").innerHTML = `<p class="muted">Memuat…</p>`;

  let ctx;
  try {
    ctx = await fetchDailyContext(date, state.today);
  } catch (e) {
    if (token !== reqToken) return;
    $("hd-table").innerHTML = `<p class="muted">Gagal memuat laporan: ${esc(e.message || e)}</p>`;
    $("hd-summary").innerHTML = "";
    return;
  }
  if (token !== reqToken) return; // tanggal sudah diganti, abaikan hasil lama

  const { holiday, emps } = ctx;
  state.rows = ctx.rows;
  state.tanpaJadwal = ctx.tanpaJadwal;
  state.holiday = holiday;
  state.rules = ctx.rules;
  state.scheduleName = ctx.scheduleName;

  const deptSel = $("hd-dept");
  const prev = deptSel.value;
  const depts = [...new Set(emps.map(e => e.department).filter(Boolean))].sort();
  deptSel.innerHTML = `<option value="">Semua Departemen</option>` + depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  deptSel.value = depts.includes(prev) ? prev : "";

  $("hd-banner").innerHTML = holiday
    ? `<div class="mon-alert" style="margin-bottom:12px;"><div class="mon-alert-head"><p class="mon-alert-title">${esc(fmtLong(date))} adalah hari libur: ${esc(holiday.name)}</p></div></div>`
    : "";
  renderSummary();
  renderTable();
}

// Baris setelah filter Departemen / Hubungan Kerja saja (dipakai ringkasan agar
// kartu tetap menunjukkan total walau filter status sedang aktif).
function scopeRows() {
  const dept = $("hd-dept").value, jenis = $("hd-jenis").value;
  return state.rows
    .filter(r => !dept || r.emp.department === dept)
    .filter(r => !jenis || r.emp.jenis_hubungan_kerja === jenis);
}

function visibleRows() {
  const status = $("hd-status").value;
  const q = $("hd-q").value.trim().toLowerCase();
  return scopeRows()
    .filter(r => matchesStatusFilter(r, status))
    .filter(r => !q || (r.emp.full_name || "").toLowerCase().includes(q));
}

function renderSummary() {
  const s = summarize(scopeRows());
  const active = $("hd-status").value;
  const past = state.date < state.today;
  const card = (label, value, filter, sub = "", cls = "") =>
    `<div class="status-card ${filter ? "clickable" : ""} ${cls} ${active === filter && filter ? "active" : ""}" ${filter ? `data-filter="${filter}" role="button" tabindex="0" title="Klik untuk menyaring tabel"` : ""}>
       <span class="status-label">${label}</span><span class="status-value">${value}</span>${sub ? `<span class="muted small">${sub}</span>` : ""}</div>`;
  $("hd-summary").innerHTML =
    card("Karyawan Terjadwal", s.terjadwal, "", s.libur ? `${s.libur} libur` : "") +
    card("Hadir", s.hadir, "hadir", s.rate != null ? `${s.rate}% dari yang diharapkan hadir` : "belum ada yang diharapkan hadir", s.rate != null && s.rate >= 90 ? "done" : "") +
    card("Tepat Waktu", s.tepat, "hadir_tepat") +
    card("Terlambat", s.telat, "hadir_telat") +
    card("Izin / Cuti / Sakit", s.izin, "izin") +
    card(past ? "Tidak Hadir" : "Belum Check-in", s.tidakHadir + s.belum, "absen", past ? "tanpa izin yang disetujui" : "") +
    (past ? card("Lupa Check-out", s.lupaCheckout, "lupa_out") : "");
  $("hd-meta").textContent = state.tanpaJadwal
    ? `${state.tanpaJadwal} karyawan aktif belum punya jadwal kerja pada tanggal ini, jadi tidak dimasukkan ke laporan.`
    : "";
}

function statusBadge(r) {
  switch (r.status) {
    case "hadir_tepat": return `<span class="badge badge-ok">${STATUS_LABEL.hadir_tepat}</span>`;
    case "hadir_telat": return `<span class="badge badge-warn">${STATUS_LABEL.hadir_telat}</span>`;
    case "izin": return `<span class="badge badge-muted">${esc(r.leave ? leaveTypeLabel(r.leave, state.rules) : STATUS_LABEL.izin)}</span>`;
    case "libur": return `<span class="badge badge-muted">${STATUS_LABEL.libur}</span>`;
    case "belum": return `<span class="badge badge-warn">${STATUS_LABEL.belum}</span>`;
    default: return `<span class="badge badge-danger">${STATUS_LABEL.tidak_hadir}</span>`;
  }
}

function jadwalText(r) {
  if (!r.sid) return "-";
  const name = state.scheduleName[r.sid] || "";
  const jam = r.jam ? `${r.jam.start}–${r.jam.end}${r.jam.lintasHari ? " (+1)" : ""}` : "";
  return [name, jam].filter(Boolean).join(" • ") || "-";
}

function keteranganText(r) {
  const parts = [];
  if (r.keterangan) parts.push(r.keterangan);
  if (r.status === "izin" && r.leave?.status === "approved") parts.push("Disetujui");
  if (r.notes) parts.push(`Catatan: ${r.notes}`);
  return parts.join(" • ");
}

function renderTable() {
  const rows = visibleRows();
  const el = $("hd-table");
  if (!state.rows.length) { el.innerHTML = `<p class="muted">Tidak ada karyawan terjadwal pada tanggal ini.</p>`; return; }
  if (!rows.length) { el.innerHTML = `<p class="muted">Tidak ada data yang cocok dengan filter.</p>`; return; }
  const past = state.date < state.today;
  el.innerHTML = `
    <table class="table" style="min-width:860px;">
      <thead><tr><th>Karyawan</th><th>Departemen</th><th>Jadwal</th><th>Status</th><th>Check-in</th><th>Check-out</th><th>Durasi</th><th>Keterangan</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td>${esc(r.emp.full_name)}<div class="muted small">${esc(r.emp.employee_code || "")}${r.emp.jenis_hubungan_kerja ? (r.emp.employee_code ? " • " : "") + esc(jenisHubunganKerjaLabel(r.emp.jenis_hubungan_kerja)) : ""}</div></td>
          <td>${esc(r.emp.department || "-")}${r.emp.jenis_hubungan_kerja === "outsourcing" && r.emp.unit_pt ? `<div class="muted small">${esc(r.emp.unit_pt)}</div>` : ""}</td>
          <td class="small">${esc(jadwalText(r))}</td>
          <td>${statusBadge(r)}</td>
          <td>${r.checkIn ? fmtTime(r.checkIn) : "-"}${r.workMode ? `<div class="small"><span class="badge badge-muted">${esc(WORK_MODE_LABEL[r.workMode] || r.workMode)}</span></div>` : ""}</td>
          <td>${r.checkOut ? fmtTime(r.checkOut) : r.lupaCheckout ? `<span class="badge badge-danger">Belum check-out</span>` : r.checkIn && !past ? `<span class="muted">Belum</span>` : "-"}</td>
          <td>${fmtDurasi(r.durasiMenit)}</td>
          <td class="small" style="white-space:normal; min-width:160px;">${esc(keteranganText(r)) || "-"}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function exportRows() {
  return visibleRows().map(r => ({
    Tanggal: state.date,
    Nama: r.emp.full_name,
    "Kode Karyawan": r.emp.employee_code || "",
    Departemen: r.emp.department || "-",
    "Hubungan Kerja": jenisHubunganKerjaLabel(r.emp.jenis_hubungan_kerja),
    "Unit / PT": r.emp.unit_pt || "-",
    Jadwal: jadwalText(r),
    Status: r.status === "izin" && r.leave ? leaveTypeLabel(r.leave, state.rules) : STATUS_LABEL[r.status],
    "Check-in": r.checkIn ? fmtTime(r.checkIn) : "",
    "Check-out": r.checkOut ? fmtTime(r.checkOut) : (r.lupaCheckout ? "Belum check-out" : ""),
    Durasi: r.durasiMenit != null ? fmtDurasi(r.durasiMenit) : "",
    "Mode Kerja": r.workMode ? (WORK_MODE_LABEL[r.workMode] || r.workMode) : "",
    Keterangan: keteranganText(r),
  }));
}

function doExport(kind) {
  const dept = $("hd-dept").value, jenis = $("hd-jenis").value, st = $("hd-status").value;
  const suffix = (dept ? `-${dept}` : "") + (jenis ? `-${jenis}` : "") + (st ? `-${st}` : "");
  const rows = exportRows();
  if (kind === "xlsx") exportXLSX(`laporan-harian-${state.date}${suffix}.xlsx`, rows, "Harian");
  else exportCSV(`laporan-harian-${state.date}${suffix}.csv`, rows);
}
