import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime, todayISO, dayOfWeekFromDateStr, exportXLSX, toast, avatarHTML, ICONS } from "../core.js";
import { esc } from "../approvalHelper.js";
import { ICON_SEARCH } from "../approvalUI.js";
import { fetchSpecialLeaveRules, leaveTypeLabel } from "../leaveRules.js";

const ICON_WARN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const ICON_CALENDAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

// Catatan: panel "Belum Absen" di bawah membaca tabel leave_requests untuk
// menampilkan keterangan Izin/Cuti/Sakit. Kalau admin yang buka halaman ini
// TIDAK punya akses menu "Approval Izin" juga, jalankan dulu migrasi
// supabase-absensi-monitor-leave-select.sql supaya RLS leave_requests
// mengizinkan menu "Monitor Absensi" ikut membaca datanya.
export async function render(container) {
  const today = todayISO();
  const firstOfMonth = today.slice(0, 8) + "01";

  container.innerHTML = `
    <div class="page-header mon-header">
      <div>
        <h1>Monitor Absensi</h1>
        <p class="mon-subtitle">Pantau kehadiran karyawan per tanggal, tindak lanjuti yang belum absen, lupa check-in, atau lupa check-out, lalu export rekapnya ke Excel.</p>
      </div>
      <button id="btn-open-export" class="btn-secondary">Export Excel</button>
    </div>

    <div class="mon-toolbar">
      <label class="mon-date-field">
        <input type="date" id="filter-date" value="${today}">
      </label>
      <div class="mon-search">
        ${ICON_SEARCH}
        <input type="text" id="filter-search" placeholder="Cari nama karyawan…">
      </div>
    </div>

    <div id="mon-stats" class="mon-stats"></div>

    <div id="belum-absen-panel"></div>

    <div id="lupa-checkin-panel"></div>

    <div id="belum-checkout-panel"></div>

    <div id="absensi-table" class="table-wrap mon-table-wrap"><p class="muted" style="padding:18px 20px;">Memuat…</p></div>

    <div id="modal-export" class="modal hidden">
      <div class="modal-box">
        <div class="mon-export-head">
          <div class="mon-export-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS.file}"/></svg>
          </div>
          <div>
            <div class="mon-export-title">Export data absensi</div>
            <p class="muted small" style="margin:2px 0 0;">Untuk rentang tanggal tertentu (bisa lebih dari satu hari). Kolom pencarian nama di halaman ikut dipakai sebagai filter.</p>
          </div>
        </div>
        <div class="form-row two-col" style="margin-top:18px;">
          <label>Dari Tanggal <input type="date" id="export-start" value="${firstOfMonth}"></label>
          <label>Sampai Tanggal <input type="date" id="export-end" value="${today}"></label>
        </div>
        <div class="modal-actions">
          <button type="button" id="btn-cancel-export" class="btn-secondary">Batal</button>
          <button type="button" id="btn-export" class="btn-primary">Export Excel</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("filter-date").addEventListener("change", onDateOrSearchChange);
  document.getElementById("filter-search").addEventListener("input", onSearchOnlyChange);
  document.getElementById("btn-open-export").addEventListener("click", () => document.getElementById("modal-export").classList.remove("hidden"));
  document.getElementById("btn-cancel-export").addEventListener("click", () => document.getElementById("modal-export").classList.add("hidden"));
  document.getElementById("btn-export").addEventListener("click", doExport);

  load();
  loadBelumAbsen(document.getElementById("filter-date").value);
  loadBelumCheckout();
  loadLupaCheckin();
}

function onDateOrSearchChange() {
  load();
  loadBelumAbsen(document.getElementById("filter-date").value);
}

function onSearchOnlyChange() {
  load();
  renderBelumAbsen(document.getElementById("filter-search").value);
}

// Sel "Karyawan" (avatar + nama) dipakai di semua tabel di halaman ini,
// supaya konsisten dengan pola ap-emp di halaman Approval.
function empCell(person) {
  const name = person?.full_name || "-";
  return `
    <div class="mon-emp">
      <span class="mon-avatar">${avatarHTML(person, name)}</span>
      <span class="mon-emp-name">${esc(name)}</span>
    </div>
  `;
}

// =====================================================================
// KARTU RINGKASAN HARIAN — dihitung dari data absensi tanggal yang lagi
// difilter (tidak ikut terpotong oleh kotak pencarian) plus jumlah "belum
// absen" dari panel di bawahnya. attendance = null berarti belum selesai
// dimuat; belumAbsen = null berarti panel belum-absen belum selesai
// dimuat. Kartu baru dirender begitu attendance sudah ada.
// =====================================================================
let statsState = { attendance: null, belumAbsen: null };

function computeAttendanceStats(rows, isPastDate) {
  const total = rows.length;
  const telat = rows.filter(r => r.check_in_status === "telat").length;
  const tepatWaktu = rows.filter(r => r.check_in_status === "tepat_waktu").length;
  const belumCheckout = isPastDate ? rows.filter(r => !r.check_out).length : 0;
  return { total, telat, tepatWaktu, belumCheckout };
}

function renderStats() {
  const el = document.getElementById("mon-stats");
  if (!el) return;
  if (!statsState.attendance) { el.innerHTML = ""; return; }

  const { total, telat, tepatWaktu, belumCheckout } = statsState.attendance;
  const belumAbsen = statsState.belumAbsen ?? 0;

  el.innerHTML = `
    <div class="mon-stat mon-stat-hadir">
      <span class="mon-stat-label">Hadir</span>
      <span class="mon-stat-value">${total}</span>
    </div>
    <div class="mon-stat mon-stat-tepat">
      <span class="mon-stat-label">Tepat Waktu</span>
      <span class="mon-stat-value">${tepatWaktu}</span>
    </div>
    <div class="mon-stat mon-stat-telat">
      <span class="mon-stat-label">Telat</span>
      <span class="mon-stat-value">${telat}</span>
    </div>
    <div class="mon-stat mon-stat-belum">
      <span class="mon-stat-label">Belum Absen</span>
      <span class="mon-stat-value">${belumAbsen}</span>
    </div>
    <div class="mon-stat mon-stat-checkout">
      <span class="mon-stat-label">Lupa Check-out</span>
      <span class="mon-stat-value">${belumCheckout}</span>
    </div>
  `;
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
    statsState.belumAbsen = 0;
    renderStats();
    el.innerHTML = "";
    return;
  }

  const { data: holiday } = await supabase
    .from("holidays").select("name").eq("date", date).eq("is_active", true).maybeSingle();

  if (holiday) {
    belumAbsenState = { date, holiday, rows: [], specialRules: [] };
    statsState.belumAbsen = 0;
    renderStats();
    el.innerHTML = `
      <div class="mon-alert mon-alert-info">
        <div class="mon-alert-head">
          <span class="mon-alert-icon">${ICON_CALENDAR}</span>
          <p class="mon-alert-title">${fmtDate(date)} adalah hari libur (${esc(holiday.name)}), jadi tidak ditandai sebagai "belum absen".</p>
        </div>
      </div>
    `;
    return;
  }

  const dow = dayOfWeekFromDateStr(date);

  const [{ data: employees }, { data: attendanceRows }, { data: scheduleDays }, { data: leaves }, specialRules] = await Promise.all([
    supabase.from("profiles").select("id, full_name, department, employee_code, photo_url, schedule_id").eq("is_active", true).order("full_name"),
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
  statsState.belumAbsen = rows.length;
  renderStats();
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
    <div class="mon-alert ${tanpaKeterangan ? "mon-alert-danger" : ""}">
      <div class="mon-alert-head">
        <span class="mon-alert-icon">${ICON_WARN}</span>
        <p class="mon-alert-title">${filtered.length} karyawan belum absen di ${fmtDate(belumAbsenState.date)}${tanpaKeterangan ? ` — ${tanpaKeterangan} di antaranya tanpa keterangan` : ""}</p>
      </div>
      <div class="mon-alert-body mon-scroll">
        <table class="table">
          <thead><tr><th>Karyawan</th><th>Departemen</th><th>Kode Karyawan</th><th>Keterangan</th></tr></thead>
          <tbody>
            ${filtered.map(r => `
              <tr>
                <td>${empCell(r.emp)}</td>
                <td>${esc(r.emp.department || "-")}</td>
                <td>${esc(r.emp.employee_code || "-")}</td>
                <td>${keteranganCell(r.leave)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="mon-alert-note">Keterangan diambil dari pengajuan Izin/Cuti/Sakit yang mencakup tanggal ini. Baris tanpa keterangan berarti belum ada pengajuan apa pun untuk karyawan itu di tanggal ini.</p>
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
// PANEL "LUPA CHECK-IN" — padanan panel lupa check-out untuk sisi masuk.
// Menampilkan HARI KERJA LAMPAU (maks. 7 hari terakhir, tidak termasuk hari
// ini karena karyawan masih bisa datang) di mana karyawan aktif tidak punya
// check-in sama sekali: entah tidak ada baris attendance, atau ada baris
// tapi hanya berisi check-out (mis. hasil koreksi pulang tanpa jam masuk).
// TIDAK dihitung: hari libur nasional, hari libur menurut Master Jadwal
// Kerja, tanggal sebelum join_date / sesudah resign_date, tanggal yang
// tercakup pengajuan Izin/Cuti/Sakit (pending/approved), dan karyawan yang
// belum punya jadwal kerja (hari kerjanya tidak bisa dipastikan).
// Kalau sudah ada Koreksi Absen "masuk" berstatus pending, ditandai supaya
// admin tidak perlu menagih lagi; yang approved otomatis hilang dari daftar
// karena koreksi yang disetujui menulis check_in ke tabel attendance.
// =====================================================================
const LUPA_CHECKIN_DAYS = 7;

function addDaysISO(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function loadLupaCheckin() {
  const el = document.getElementById("lupa-checkin-panel");
  if (!el) return;

  const today = todayISO();
  const start = addDaysISO(today, -LUPA_CHECKIN_DAYS);
  const end = addDaysISO(today, -1);

  const [emps, att, sched, hol, leaves, koreksi] = await Promise.all([
    supabase.from("profiles")
      .select("id, full_name, department, employee_code, photo_url, schedule_id, join_date, resign_date")
      .eq("is_active", true).not("schedule_id", "is", null),
    supabase.from("attendance").select("user_id, date, check_in").gte("date", start).lte("date", end),
    supabase.from("work_schedule_days").select("schedule_id, day_of_week, is_working_day"),
    supabase.from("holidays").select("date").eq("is_active", true).gte("date", start).lte("date", end),
    supabase.from("leave_requests").select("user_id, start_date, end_date")
      .in("status", ["pending", "approved"]).lte("start_date", end).gte("end_date", start),
    supabase.from("attendance_correction_requests").select("user_id, attendance_date")
      .eq("correction_type", "masuk").eq("status", "pending").gte("attendance_date", start).lte("attendance_date", end),
  ]);

  // Data inti gagal dimuat -> jangan tampilkan apa pun (lebih baik kosong daripada menyesatkan).
  if (emps.error || att.error || sched.error || hol.error) { el.innerHTML = ""; return; }
  // leaves / koreksi bersifat pelengkap (bisa ditolak RLS untuk sebagian role).
  const leaveRows = leaves.error ? [] : (leaves.data || []);
  const koreksiRows = koreksi.error ? [] : (koreksi.data || []);

  const holidays = new Set((hol.data || []).map(h => h.date));
  const checkedIn = new Set((att.data || []).filter(a => a.check_in).map(a => `${a.user_id}|${a.date}`));
  const working = {};
  (sched.data || []).forEach(d => { working[`${d.schedule_id}|${d.day_of_week}`] = d.is_working_day; });
  const pendingKoreksi = new Set(koreksiRows.map(k => `${k.user_id}|${k.attendance_date}`));

  const rows = [];
  for (let i = LUPA_CHECKIN_DAYS; i >= 1; i--) {
    const date = addDaysISO(today, -i);
    if (holidays.has(date)) continue;
    const dow = dayOfWeekFromDateStr(date);
    for (const emp of emps.data || []) {
      if (working[`${emp.schedule_id}|${dow}`] !== true) continue; // libur / jadwal hari itu tidak terdaftar
      if (emp.join_date && date < emp.join_date) continue;
      if (emp.resign_date && date > emp.resign_date) continue;
      if (checkedIn.has(`${emp.id}|${date}`)) continue;
      if (leaveRows.some(l => l.user_id === emp.id && l.start_date <= date && l.end_date >= date)) continue;
      rows.push({ emp, date, koreksiPending: pendingKoreksi.has(`${emp.id}|${date}`) });
    }
  }

  if (!rows.length) { el.innerHTML = ""; return; }
  const tanpaKoreksi = rows.filter(r => !r.koreksiPending).length;

  el.innerHTML = `
    <div class="mon-alert">
      <div class="mon-alert-head">
        <span class="mon-alert-icon">${ICON_WARN}</span>
        <p class="mon-alert-title">${rows.length} hari lupa check-in dalam ${LUPA_CHECKIN_DAYS} hari terakhir${tanpaKoreksi !== rows.length ? ` — ${tanpaKoreksi} belum ada pengajuan koreksi` : ""}</p>
      </div>
      <div class="mon-alert-body mon-scroll">
        <table class="table">
          <thead><tr><th>Karyawan</th><th>Departemen</th><th>Tanggal</th><th>Keterangan</th><th></th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${empCell(r.emp)}</td>
                <td>${esc(r.emp.department || "-")}</td>
                <td>${fmtDate(r.date)}</td>
                <td>${r.koreksiPending
                  ? `<span class="badge badge-warn">Koreksi masuk diajukan (pending)</span>`
                  : `<span class="badge badge-danger">Belum ada keterangan</span>`}</td>
                <td><button type="button" class="btn-link btn-lihat-tanggal" data-date="${r.date}">Lihat tanggal ini</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="mon-alert-note">Minta karyawan mengajukan lewat menu <strong>Koreksi Absen</strong> (jenis "Lupa Absen Masuk"). Hari libur, izin/cuti, dan karyawan tanpa jadwal kerja tidak dihitung.</p>
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
    .select("id, date, check_in, user_id, profiles(full_name, department, employee_code, photo_url)")
    .is("check_out", null)
    .lt("date", today)
    .order("date", { ascending: true });

  if (error || !data || !data.length) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <div class="mon-alert">
      <div class="mon-alert-head">
        <span class="mon-alert-icon">${ICON_WARN}</span>
        <p class="mon-alert-title">${data.length} sesi lupa check-out (perlu ditindaklanjuti)</p>
      </div>
      <div class="mon-alert-body mon-scroll">
        <table class="table">
          <thead><tr><th>Karyawan</th><th>Departemen</th><th>Tanggal</th><th>Check-in</th><th></th></tr></thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td>${empCell(r.profiles)}</td>
                <td>${r.profiles?.department || "-"}</td>
                <td>${fmtDate(r.date)}</td>
                <td>${fmtTime(r.check_in)}</td>
                <td><button type="button" class="btn-link btn-lihat-tanggal" data-date="${r.date}">Lihat tanggal ini</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="mon-alert-note">Minta karyawan mengajukan lewat menu <strong>Koreksi Absen</strong> supaya jam pulangnya bisa diperbaiki dan disetujui.</p>
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
    .select("*, profiles(full_name, department, employee_code, photo_url)")
    .eq("date", date)
    .order("check_in", { ascending: true });

  const el = document.getElementById("absensi-table");
  if (error) { el.innerHTML = `<p class="muted" style="padding:18px 20px;">Gagal memuat data: ${error.message}</p>`; return; }

  statsState.attendance = computeAttendanceStats(data || [], isPastDate);
  renderStats();

  const filtered = search
    ? data.filter(r => r.profiles?.full_name?.toLowerCase().includes(search))
    : data;

  if (!filtered.length) { el.innerHTML = `<p class="muted" style="padding:18px 20px;">Belum ada data absensi untuk tanggal ini.</p>`; return; }

  el.innerHTML = `
    <table class="table mon-table">
      <thead><tr><th>Karyawan</th><th>Departemen</th><th>Check-in</th><th>Status</th><th>Lokasi</th><th>Foto Check-in</th><th>Check-out</th><th>Foto Check-out</th></tr></thead>
      <tbody>
        ${filtered.map(r => `
          <tr ${!r.check_out && isPastDate ? `style="background:color-mix(in srgb, var(--warn) 8%, transparent);"` : ""}>
            <td class="mon-td-emp">${empCell(r.profiles)}</td>
            <td data-label="Departemen">${r.profiles?.department || "-"}</td>
            <td data-label="Check-in">${fmtTime(r.check_in)}</td>
            <td data-label="Status">${r.check_in_status ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : "-"}</td>
            <td data-label="Lokasi">${locationCell(r)}</td>
            <td data-label="Foto Check-in">${photoCell(r.check_in_photo_url)}</td>
            <td data-label="Check-out">${r.check_out ? fmtTime(r.check_out) : (isPastDate ? `<span class="mon-checkout-warn badge badge-danger">${ICON_WARN} Belum</span>` : `<span class="muted">Belum</span>`)}</td>
            <td data-label="Foto Check-out">${photoCell(r.check_out_photo_url)}</td>
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

  if (error) { toast("Gagal mengambil data: " + error.message, "error"); return; }

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
  document.getElementById("modal-export").classList.add("hidden");
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
