import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime, todayISO, dayOfWeekFromDateStr, exportXLSX, toast } from "../core.js";
import { esc } from "../approvalHelper.js";
import { fetchSpecialLeaveRules, leaveTypeLabel } from "../leaveRules.js";

// Catatan: panel "Belum Absen" di bawah membaca tabel leave_requests untuk
// menampilkan keterangan Izin/Cuti/Sakit. Kalau admin yang buka halaman ini
// TIDAK punya akses menu "Approval Izin" juga, jalankan dulu migrasi
// supabase-absensi-monitor-leave-select.sql supaya RLS leave_requests
// mengizinkan menu "Monitor Absensi" ikut membaca datanya.
export async function render(container) {
  const today = todayISO();
  const firstOfMonth = today.slice(0, 8) + "01";

  container.innerHTML = `
    <div class="page-header">
      <h1>Monitor Absensi</h1>
      <div class="filter-row">
        <input type="date" id="filter-date" value="${today}">
        <input type="text" id="filter-search" placeholder="Cari nama karyawan…">
      </div>
    </div>

    <div id="belum-absen-panel"></div>

    <div id="belum-checkout-panel"></div>

    <div id="absensi-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <h2 class="section-title">Export Excel</h2>
    <div class="card" style="max-width:560px;">
      <p class="muted small" style="margin-top:0;">Export data absensi untuk rentang tanggal tertentu (bisa lebih dari satu hari).</p>
      <div class="form-row two-col">
        <label>Dari Tanggal <input type="date" id="export-start" value="${firstOfMonth}"></label>
        <label>Sampai Tanggal <input type="date" id="export-end" value="${today}"></label>
      </div>
      <button id="btn-export" class="btn-secondary">Export Excel</button>
    </div>
  `;

  document.getElementById("filter-date").addEventListener("change", onDateOrSearchChange);
  document.getElementById("filter-search").addEventListener("input", onSearchOnlyChange);
  document.getElementById("btn-export").addEventListener("click", doExport);

  load();
  loadBelumAbsen(document.getElementById("filter-date").value);
  loadBelumCheckout();
}

function onDateOrSearchChange() {
  load();
  loadBelumAbsen(document.getElementById("filter-date").value);
}

function onSearchOnlyChange() {
  load();
  renderBelumAbsen(document.getElementById("filter-search").value);
}

// =====================================================================
// PANEL "BELUM ABSEN [TANGGAL]" — daftar karyawan aktif yang seharusnya
// masuk pada tanggal yang lagi difilter tapi belum punya baris attendance
// sama sekali. Karyawan yang harinya memang libur menurut Master Jadwal
// Kerja-nya (is_working_day = false) TIDAK dimasukkan, begitu juga semua
// orang kalau tanggalnya hari libur nasional (Master Hari Libur). Kalau
// karyawan yang belum absen itu ternyata sedang ada pengajuan Izin/Cuti/
// Sakit yang mencakup tanggal ini (pending atau approved), keterangannya
// ditampilkan supaya admin langsung tahu alasannya, tidak perlu menduga-duga.
// Hasil query di-cache per tanggal (belumAbsenState) supaya mengetik di
// kotak pencarian tidak query ulang ke server tiap huruf.
// =====================================================================
let belumAbsenState = { date: null, holiday: null, rows: [], specialRules: [] };

async function loadBelumAbsen(date) {
  const el = document.getElementById("belum-absen-panel");
  if (!el) return;
  el.innerHTML = `<p class="muted small">Memeriksa siapa yang belum absen…</p>`;

  const today = todayISO();
  if (date > today) {
    belumAbsenState = { date, holiday: null, rows: [], specialRules: [] };
    el.innerHTML = "";
    return;
  }

  const { data: holiday } = await supabase
    .from("holidays").select("name").eq("date", date).eq("is_active", true).maybeSingle();

  if (holiday) {
    belumAbsenState = { date, holiday, rows: [], specialRules: [] };
    el.innerHTML = `
      <div class="card" style="margin-bottom:20px;">
        <p class="small muted" style="margin:0;">📅 ${fmtDate(date)} adalah hari libur (<strong>${esc(holiday.name)}</strong>), jadi tidak ditandai sebagai "belum absen".</p>
      </div>
    `;
    return;
  }

  const dow = dayOfWeekFromDateStr(date);

  const [{ data: employees }, { data: attendanceRows }, { data: scheduleDays }, { data: leaves }, specialRules] = await Promise.all([
    supabase.from("profiles").select("id, full_name, department, employee_code, schedule_id").eq("is_active", true).order("full_name"),
    supabase.from("attendance").select("user_id").eq("date", date),
    supabase.from("work_schedule_days").select("schedule_id, is_working_day").eq("day_of_week", dow),
    supabase.from("leave_requests")
      .select("user_id, type, leave_category, special_leave_code, status")
      .in("status", ["pending", "approved"])
      .lte("start_date", date)
      .gte("end_date", date),
    fetchSpecialLeaveRules(),
  ]);

  const attendedIds = new Set((attendanceRows || []).map(r => r.user_id));
  const workingDayBySchedule = {};
  (scheduleDays || []).forEach(d => { workingDayBySchedule[d.schedule_id] = d.is_working_day; });

  // Approved menang atas pending kalau (jarang terjadi) ada dua pengajuan
  // yang sama-sama mencakup tanggal ini.
  const leaveByUser = {};
  (leaves || []).forEach(l => {
    const existing = leaveByUser[l.user_id];
    if (!existing || (existing.status !== "approved" && l.status === "approved")) leaveByUser[l.user_id] = l;
  });

  const rows = (employees || [])
    .filter(emp => {
      if (attendedIds.has(emp.id)) return false; // sudah absen
      if (emp.schedule_id && workingDayBySchedule[emp.schedule_id] === false) return false; // libur sesuai jadwalnya sendiri
      return true;
    })
    .map(emp => ({ emp, leave: leaveByUser[emp.id] || null }));

  belumAbsenState = { date, holiday: null, rows, specialRules: specialRules || [] };
  renderBelumAbsen(document.getElementById("filter-search")?.value || "");
}

function renderBelumAbsen(search) {
  const el = document.getElementById("belum-absen-panel");
  if (!el) return;
  if (belumAbsenState.holiday) return; // sudah dirender di loadBelumAbsen, tidak perlu diulang
  if (!belumAbsenState.rows.length) { el.innerHTML = ""; return; }

  const q = (search || "").toLowerCase();
  const filtered = q
    ? belumAbsenState.rows.filter(r => r.emp.full_name.toLowerCase().includes(q))
    : belumAbsenState.rows;

  if (!filtered.length) { el.innerHTML = ""; return; }

  const tanpaKeterangan = filtered.filter(r => !r.leave).length;

  el.innerHTML = `
    <div class="card" style="border-left:4px solid ${tanpaKeterangan ? "var(--danger)" : "var(--warn)"}; margin-bottom:20px;">
      <p class="small" style="margin:0 0 10px 0; color:${tanpaKeterangan ? "var(--danger)" : "var(--warn)"}; font-weight:600;">
        ⚠️ ${filtered.length} karyawan belum absen di ${fmtDate(belumAbsenState.date)}${tanpaKeterangan ? ` — ${tanpaKeterangan} di antaranya tanpa keterangan` : ""}
      </p>
      <table class="table">
        <thead><tr><th>Karyawan</th><th>Departemen</th><th>Kode Karyawan</th><th>Keterangan</th></tr></thead>
        <tbody>
          ${filtered.map(r => `
            <tr>
              <td>${esc(r.emp.full_name)}</td>
              <td>${esc(r.emp.department || "-")}</td>
              <td>${esc(r.emp.employee_code || "-")}</td>
              <td>${keteranganCell(r.leave)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <p class="muted small" style="margin:10px 0 0 0;">
        Keterangan diambil dari pengajuan Izin/Cuti/Sakit yang mencakup tanggal ini. Baris tanpa keterangan berarti belum ada pengajuan apa pun untuk karyawan itu di tanggal ini.
      </p>
    </div>
  `;
}

function keteranganCell(leave) {
  if (!leave) return `<span class="badge badge-danger">Belum ada keterangan</span>`;
  const rules = belumAbsenState.specialRules || [];
  const label = leaveTypeLabel(leave, rules);
  const pendingSuffix = leave.status === "pending" ? " (pending)" : "";
  return `<span class="badge badge-${leave.status === "approved" ? "ok" : "warn"}">${esc(label)}${pendingSuffix}</span>`;
}

// =====================================================================
// PANEL "BELUM CHECK-OUT" — daftar SEMUA sesi lama (bukan cuma tanggal yang
// lagi difilter) yang sudah check-in tapi belum check-out sampai sekarang.
// Supaya admin tidak harus klik tanggal satu-satu untuk sadar ada yang
// kelupaan. Sesi hari ini yang memang masih berjalan (belum waktunya
// pulang) TIDAK dianggap masalah, jadi tidak dimasukkan di sini — lihat
// employee-absensi.js (loadAttendanceState) untuk logika "staleOpen" yang
// serupa di sisi karyawan.
// =====================================================================
async function loadBelumCheckout() {
  const el = document.getElementById("belum-checkout-panel");
  if (!el) return;
  const today = todayISO();

  const { data, error } = await supabase
    .from("attendance")
    .select("id, date, check_in, user_id, profiles(full_name, department, employee_code)")
    .is("check_out", null)
    .lt("date", today)
    .order("date", { ascending: true });

  if (error || !data || !data.length) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <div class="card" style="border-left:4px solid var(--warn); margin-bottom:20px;">
      <p class="small" style="margin:0 0 10px 0; color:var(--warn); font-weight:600;">
        ⚠️ ${data.length} sesi lupa check-out (perlu ditindaklanjuti)
      </p>
      <table class="table">
        <thead><tr><th>Karyawan</th><th>Departemen</th><th>Tanggal</th><th>Check-in</th><th></th></tr></thead>
        <tbody>
          ${data.map(r => `
            <tr>
              <td>${r.profiles?.full_name || "-"}</td>
              <td>${r.profiles?.department || "-"}</td>
              <td>${fmtDate(r.date)}</td>
              <td>${fmtTime(r.check_in)}</td>
              <td><button type="button" class="btn-link btn-lihat-tanggal" data-date="${r.date}">Lihat tanggal ini</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <p class="muted small" style="margin:10px 0 0 0;">
        Minta karyawan mengajukan lewat menu <strong>Koreksi Absen</strong> supaya jam pulangnya bisa diperbaiki dan disetujui.
      </p>
    </div>
  `;

  el.querySelectorAll(".btn-lihat-tanggal").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("filter-date").value = btn.dataset.date;
      onDateOrSearchChange();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

async function load() {
  const date = document.getElementById("filter-date").value;
  const search = document.getElementById("filter-search").value.toLowerCase();
  const isPastDate = date < todayISO();

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
          <tr ${!r.check_out && isPastDate ? `style="background:color-mix(in srgb, var(--warn) 10%, transparent);"` : ""}>
            <td>${r.profiles?.full_name || "-"}</td>
            <td>${r.profiles?.department || "-"}</td>
            <td>${fmtTime(r.check_in)}</td>
            <td>${r.check_in_status ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : "-"}</td>
            <td>${locationCell(r)}</td>
            <td>${photoCell(r.check_in_photo_url)}</td>
            <td>${r.check_out ? fmtTime(r.check_out) : (isPastDate ? `<span style="color:var(--warn);">⚠️ Belum</span>` : `<span class="muted">Belum</span>`)}</td>
            <td>${photoCell(r.check_out_photo_url)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function doExport() {
  const start = document.getElementById("export-start").value;
  const end = document.getElementById("export-end").value;
  const search = document.getElementById("filter-search").value.toLowerCase();
  const btn = document.getElementById("btn-export");

  if (!start || !end) { return; }
  if (start > end) {
    toast("Tanggal 'Dari' harus sebelum atau sama dengan tanggal 'Sampai'", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Menyiapkan data…";

  const { data, error } = await supabase
    .from("attendance")
    .select("*, profiles(full_name, department, employee_code)")
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true })
    .order("check_in", { ascending: true });

  btn.disabled = false;
  btn.textContent = "Export Excel";

  if (error) { return; }

  const filtered = search
    ? (data || []).filter(r => r.profiles?.full_name?.toLowerCase().includes(search))
    : (data || []);

  const rows = filtered.map(r => ({
    Tanggal: fmtDate(r.date),
    "Kode Karyawan": r.profiles?.employee_code || "-",
    Nama: r.profiles?.full_name || "-",
    Departemen: r.profiles?.department || "-",
    "Jam Check-in": fmtTime(r.check_in),
    Status: r.check_in_status === "telat" ? "Telat" : r.check_in_status === "tepat_waktu" ? "Tepat waktu" : "-",
    "Jarak Check-in (m)": r.check_in_distance_m ?? "-",
    "Jam Check-out": fmtTime(r.check_out),
    "Jarak Check-out (m)": r.check_out_distance_m ?? "-",
    "Foto Check-in": r.check_in_photo_url || "-",
    "Foto Check-out": r.check_out_photo_url || "-",
  }));

  exportXLSX(`absensi-${start}_sampai_${end}.xlsx`, rows, "Absensi");
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
