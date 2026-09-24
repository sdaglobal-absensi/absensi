import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtJam, fmtDate, dateOnlyISO, roundOvertimeHours, exportXLSX, dayOfWeekFromDateStr, zonedMinutesOfDay, hmToMinutes, getPayrollCutoffDay, payrollPeriodRange, STAFF_ROLES } from "../core.js";

// =======================================================================
// SLIP GAJI — dihitung otomatis dari data yang sudah ada di sistem:
//   - Gaji pokok: Riwayat Upah Harian (x hari hadir) / Riwayat Gaji Bulanan
//   - Uang lembur: Pengajuan Lembur yang disetujui x tarif di Master Level
//   - Tunjangan (Jabatan, Loyalitas, dst): nominal per karyawan yang diatur
//     di menu "Master Tunjangan" (beda-beda tiap orang, bukan per level),
//     otomatis ditambahkan tiap slip selama statusnya aktif.
//   - Denda keterlambatan & pulang cepat: tabel bertingkat berdasarkan
//     menit telat/cepat RELATIF terhadap jadwal kerja masing-masing
//     karyawan (bukan jam dinding tetap), diatur manual di menu "Master
//     Denda Telat" (tabel late_penalty_rules). Tier bertipe % dikalikan
//     "Denda Terlambat & Pulang Cepat" (Rp) di Master Level masing-masing
//     grade/level; tier bertipe nominal tetap tidak tergantung denda
//     level. Rincian per-hari tidak ditampilkan di slip gaji karyawan,
//     hanya totalnya.
//   - BPJS, PPh21, uang dinas: tarif di Master Level
// Komponen yang tidak tercatat otomatis (dinas, tunjangan/potongan lain)
// diisi manual per periode lewat "Edit Tunjangan/Potongan" dan disimpan
// ke tabel payroll_adjustments supaya tidak hilang saat dibuka ulang.
// =======================================================================

// ---------------------------------------------------------------------
// POTONGAN KETERLAMBATAN & PULANG CEPAT
// Aturan (menit_offset & persen/nominal) diambil dari tabel
// late_penalty_rules (di-load ke penaltyRules saat loadData). Sejak
// jadwal kerja karyawan bisa beda-beda (shift pagi/sore/malam), tier-nya
// disimpan RELATIF terhadap jam masuk/pulang sesuai JADWAL MASING-MASING
// KARYAWAN (bukan jam dinding tetap) -- lihat resolveShiftWindow() di
// bawah utk cara mengambil jam masuk/pulang jadwalnya utk satu baris
// absensi tertentu.
// ---------------------------------------------------------------------

// Ambil jam masuk & jam pulang (menit sejak 00:00, sesuai jadwal kerja
// karyawan) yang berlaku untuk SATU baris absensi (ditentukan dari tanggal
// baris itu, bukan tanggal hari ini). Karyawan tanpa jadwal (schedule_id
// kosong, atau harinya libur/tidak ketemu di Master Jadwal Kerja) pakai
// acuan default 08:00-17:00, sama seperti dulu.
function resolveShiftWindow(emp, dow) {
  const day = emp.schedule_id ? scheduleDaysByKey[`${emp.schedule_id}_${dow}`] : null;
  if (day && day.is_working_day && day.start_time && day.end_time) {
    return {
      startMin: hmToMinutes(day.start_time.slice(0, 5)),
      endMin: hmToMinutes(day.end_time.slice(0, 5)),
      crossesMidnight: !!day.crosses_midnight,
    };
  }
  return { startMin: hmToMinutes("08:00"), endMin: hmToMinutes("17:00"), crossesMidnight: false };
}

// Keterlambatan: tier diurutkan naik. Yang dipakai adalah tier PALING
// TERAKHIR yang menit-telatnya sudah terlampaui (makin lama telatnya,
// makin besar potongannya).
function hitungDendaTelat(checkInAt, dayOfWeek, dendaDasar, tz, shift) {
  if (!checkInAt || dayOfWeek < 1 || dayOfWeek > 6) return null; // Minggu/tidak absen: tidak ada aturan
  const dayType = dayOfWeek === 6 ? "saturday" : "weekday";
  const rules = penaltyRules.telat[dayType] || [];
  let mins = zonedMinutesOfDay(checkInAt, tz);
  // Check-in dini hari utk shift lintas tengah malam (mis. shift 22:00,
  // check-in tercatat 00:xx) -- geser +24 jam supaya selisihnya dari jam
  // masuk terhitung benar (bukan malah jadi "lebih awal").
  if (shift.crossesMidnight && mins < shift.endMin) mins += 24 * 60;
  const lateMinutes = mins - shift.startMin;
  let picked = null;
  for (const r of rules) {
    if (lateMinutes > r.menit_offset) picked = r;
  }
  if (!picked) return null;
  const amount = picked.tipe === "flat" ? picked.nominal : dendaDasar * picked.persen / 100;
  return { amount, label: picked.label };
}

// Pulang cepat: tier diurutkan naik. Yang dipakai adalah tier PERTAMA
// yang menit-lebih-cepatnya masih terlampaui (makin cepat pulangnya,
// makin besar potongannya).
function hitungDendaPulangCepat(checkOutAt, dayOfWeek, dendaDasar, tz, shift) {
  if (!checkOutAt || dayOfWeek < 1 || dayOfWeek > 6) return null;
  const dayType = dayOfWeek === 6 ? "saturday" : "weekday";
  const rules = penaltyRules.pulang_cepat[dayType] || [];
  const mins = zonedMinutesOfDay(checkOutAt, tz);
  const earlyMinutes = shift.endMin - mins;
  for (const r of rules) {
    if (earlyMinutes > r.menit_offset) {
      const amount = r.tipe === "flat" ? r.nominal : dendaDasar * r.persen / 100;
      return { amount, label: r.label };
    }
  }
  return null;
}

let period = "";
let employees = [];
let jobLevels = [];
let wageByUser = {};
let salaryByUser = {};
let attendanceByUser = {};
let overtimeByUser = {};
let adjByUser = {};
let allowancesByUser = {}; // { [userId]: [{ nama, nominal }] } — dari Master Tunjangan (aktif saja)
let penaltyRules = { telat: { weekday: [], saturday: [] }, pulang_cepat: { weekday: [], saturday: [] } };
let scheduleDaysByKey = {}; // { "${schedule_id}_${day_of_week}": work_schedule_days row } — lihat resolveShiftWindow()
let tzByLokasi = {}; // { [nama_lokasi]: timezone } — dari Master Lokasi Kantor, dipakai supaya potongan telat/pulang-cepat dihitung sesuai jam SETEMPAT tiap cabang, bukan satu zona global.
let currentSlip = null; // slip yang sedang dibuka di modal detail
let cutoffDay = 1; // 1 = kalender biasa; diisi dari payroll_settings saat loadData
let periodRange = { start: "", end: "" }; // rentang tanggal aktual (hasil cut-off) untuk periode terpilih
let finalizedPeriods = {}; // { [period]: { period_start, period_end, cutoff_start_day, finalized_by, finalized_at } } — dimuat sekali saat render()
let periodInfo = null; // baris payroll_periods utk periode yg SEDANG dibuka, atau null kalau masih draft
let frozenSlipsByUser = {}; // { [userId]: snapshot } — dari payroll_slips, hanya terisi kalau periodInfo != null
let currentUser = null; // disimpan supaya bisa dipakai di onFinalize/onUnlock

// Batasan akses berdasarkan role, dihitung sekali di awal render():
// - canFinalize: HANYA super_admin yang boleh finalisasi/buka kunci periode.
// - canEditAdjust: super_admin/super_admin_hr/admin_hr boleh, Karyawan TIDAK
//   (dia cuma boleh lihat & cetak slip miliknya sendiri, tidak bisa
//   mengubah tunjangan/potongan siapa pun termasuk dirinya sendiri).
// - isKaryawan: kalau true, daftar karyawan disaring cuma baris dirinya
//   sendiri (walau tabel profiles yang dibaca RLS-nya memang sudah
//   otomatis cuma balikin baris sendiri utk role ini, filter ini jaga-jaga
//   di sisi tampilan juga).
let roleFlags = { isKaryawan: false, canFinalize: false, canEditAdjust: true };

export async function render(container, user, opts = {}) {
  currentUser = user;
  // forceSelfOnly: dipakai oleh menu "Slip Gaji Saya" (lihat js/modules/
  // employee-slip-gaji.js) supaya SIAPA PUN yang membukanya lewat menu itu
  // -- termasuk Super Admin HR/Admin HR yang tidak (atau belum tentu)
  // dikasih akses menu "Slip Gaji" (kelola semua karyawan) -- tetap hanya
  // melihat slip miliknya sendiri, tanpa tombol finalisasi/edit apa pun.
  // Menu "Slip Gaji" biasa (tanpa opts ini) tetap pakai role asli seperti
  // sebelumnya.
  roleFlags = {
    isKaryawan: opts.forceSelfOnly || !STAFF_ROLES.includes(user.role),
    canFinalize: !opts.forceSelfOnly && user.role === "super_admin",
    canEditAdjust: !opts.forceSelfOnly && STAFF_ROLES.includes(user.role),
  };
  period = dateOnlyISO(new Date()).slice(0, 7);
  cutoffDay = await getPayrollCutoffDay();

  // Ambil semua periode yang sudah difinalisasi sekali di awal, supaya
  // label dropdown (rentang tanggal) periode LAMA yang sudah dikunci tetap
  // menampilkan rentang yang dibekukan saat itu, bukan hasil hitung ulang
  // pakai cutoff yang berlaku sekarang.
  const { data: fp } = await supabase.from("payroll_periods").select("*");
  finalizedPeriods = {};
  (fp || []).forEach(r => { finalizedPeriods[r.period] = r; });

  // Kalau pakai cut-off (bukan kalender biasa), pakai dropdown yang
  // labelnya langsung rentang tanggal ("21 Agu 2026 – 20 Sep 2026")
  // supaya tidak perlu menebak-nebak arti nama bulannya. Kalau kalender
  // biasa (cutoffDay = 1), input bulan bawaan browser sudah jelas.
  const periodFilterHtml = cutoffDay > 1
    ? `<select id="filter-period">${buildPeriodOptions(period, cutoffDay).map(o =>
        `<option value="${o.value}" ${o.value === period ? "selected" : ""}>${o.label}</option>`).join("")}</select>`
    : `<input type="month" id="filter-period" value="${period}">`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Slip Gaji</h1>
        <p class="muted">${roleFlags.isKaryawan
          ? "Slip gaji kamu, dihitung otomatis dari absensi, lembur, dan data upah/gaji. Kalau ada yang dirasa keliru, hubungi HR/Admin."
          : "Dihitung otomatis dari absensi, lembur, riwayat upah/gaji, dan Master Level. Tunjangan/potongan yang tidak tercatat otomatis bisa ditambahkan manual per karyawan. Rentang tanggal periode mengikuti pengaturan cut-off di menu Pengaturan Sistem, sampai periode itu difinalisasi."}</p>
      </div>
      <div class="filter-row">
        ${periodFilterHtml}
        ${roleFlags.isKaryawan ? "" : `<button id="btn-export" class="btn-secondary">Export Ringkasan (Excel)</button>`}
      </div>
    </div>

    <div id="slip-lock-banner"></div>
    <div id="slip-summary" class="status-grid"></div>
    <div id="slip-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <!-- Modal: detail & cetak slip -->
    <div id="modal-slip" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <div class="modal-actions no-print" style="justify-content:space-between; margin-bottom:14px;">
          ${roleFlags.canEditAdjust ? `<button type="button" id="btn-edit-adjust" class="btn-secondary">✏️ Edit Tunjangan/Potongan</button>` : `<span></span>`}
          <div style="display:flex; gap:10px;">
            <button type="button" id="btn-print-slip" class="btn-secondary">🖨️ Cetak / Simpan PDF</button>
            <button type="button" id="btn-close-slip" class="btn-primary">Tutup</button>
          </div>
        </div>
        <div id="slip-content" class="slip-print-area"></div>
      </div>
    </div>

    <!-- Modal: edit penyesuaian manual -->
    <div id="modal-adjust" class="modal hidden">
      <div class="modal-box">
        <h3>Tunjangan &amp; Potongan Manual</h3>
        <p class="muted small" id="adjust-emp-label" style="margin-top:-4px;"></p>
        <form id="form-adjust">
          <div class="form-row two-col">
            <label>Hari Perjalanan Dinas <input type="number" name="hari_dinas" min="0" step="1" value="0"></label>
            <label>Tunjangan Lain (Rp) <input type="number" name="tunjangan_lain" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Keterangan Tunjangan Lain <input name="keterangan_tunjangan" placeholder="Contoh: Bonus, THR, dsb"></label>
          </div>
          <div class="form-row">
            <label>Potongan Lain (Rp) <input type="number" name="potongan_lain" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Keterangan Potongan Lain <input name="keterangan_potongan" placeholder="Contoh: Kasbon, pinjaman, dsb"></label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-adjust" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("filter-period").addEventListener("change", e => { period = e.target.value; loadAndRender(); });
  document.getElementById("btn-export")?.addEventListener("click", doExport);
  document.getElementById("btn-close-slip").addEventListener("click", () => document.getElementById("modal-slip").classList.add("hidden"));
  document.getElementById("btn-print-slip").addEventListener("click", () => window.print());
  document.getElementById("btn-edit-adjust")?.addEventListener("click", () => openAdjustModal(currentSlip.emp.id));
  document.getElementById("btn-cancel-adjust").addEventListener("click", () => document.getElementById("modal-adjust").classList.add("hidden"));
  document.getElementById("form-adjust").addEventListener("submit", e => onSubmitAdjust(e, user));

  await loadAndRender();
}

// -----------------------------------------------------------------------
async function loadAndRender() {
  const el = document.getElementById("slip-table");
  el.innerHTML = `<p class="muted">Memuat…</p>`;
  await loadData(period);
  renderLockBanner();
  renderSummary();
  renderTable();
}

async function loadData(p) {
  cutoffDay = await getPayrollCutoffDay();

  // Kalau periode ini sudah difinalisasi, pakai rentang tanggal yang
  // DIBEKUKAN saat itu (bukan hasil hitung ulang dari cutoff sekarang),
  // dan nanti render pakai snapshot payroll_slips, bukan hitung live.
  periodInfo = finalizedPeriods[p] || null;
  periodRange = periodInfo
    ? { start: periodInfo.period_start, end: periodInfo.period_end }
    : payrollPeriodRange(p, cutoffDay);
  const { start, end } = periodRange;

  const [{ data: emp, error: errEmp }, { data: levels }, { data: wages }, { data: salaries }, { data: att }, { data: ot }, { data: adj }, { data: rules }, { data: schedDays }, { data: types }, { data: alw }, { data: slips }, { data: locs }] = await Promise.all([
    supabase.from("profiles").select("*").eq("is_active", true).order("full_name"),
    supabase.from("job_levels").select("*"),
    supabase.from("wage_history").select("*").lte("effective_date", end).order("effective_date", { ascending: false }),
    supabase.from("salary_history").select("*").lte("effective_date", end).order("effective_date", { ascending: false }),
    supabase.from("attendance").select("*").gte("date", start).lte("date", end),
    supabase.from("overtime_requests").select("*").eq("status", "approved").gte("date", start).lte("date", end),
    supabase.from("payroll_adjustments").select("*").eq("period", p),
    supabase.from("late_penalty_rules").select("*").eq("is_active", true).order("menit_offset", { ascending: true }),
    supabase.from("work_schedule_days").select("*"),
    supabase.from("allowance_types").select("*").eq("is_active", true),
    supabase.from("employee_allowances").select("*").eq("is_active", true),
    periodInfo ? supabase.from("payroll_slips").select("*").eq("period", p) : Promise.resolve({ data: [] }),
    supabase.from("office_locations").select("name, timezone"),
  ]);

  if (errEmp) { toast("Gagal memuat data karyawan: " + errEmp.message, "error"); }

  employees = emp || []; // semua karyawan aktif, termasuk yg status/grade-nya belum diatur (biar admin tahu perlu dilengkapi)
  // Karyawan biasa hanya boleh lihat baris dirinya sendiri, walau query di
  // atas tidak difilter per user_id — RLS profiles sebenarnya sudah
  // otomatis membatasi ini di sisi database, filter di sini cuma jaga-jaga
  // tambahan di sisi tampilan supaya tetap benar walau RLS-nya nanti
  // berubah.
  if (roleFlags.isKaryawan && currentUser) {
    employees = employees.filter(e => e.id === currentUser.id);
  }
  jobLevels = levels || [];

  wageByUser = groupByUserSorted(wages);
  salaryByUser = groupByUserSorted(salaries);

  attendanceByUser = {};
  (att || []).forEach(a => { (attendanceByUser[a.user_id] ??= []).push(a); });

  overtimeByUser = {};
  (ot || []).forEach(o => { (overtimeByUser[o.user_id] ??= []).push(o); });

  adjByUser = {};
  (adj || []).forEach(a => { adjByUser[a.user_id] = a; });

  penaltyRules = { telat: { weekday: [], saturday: [] }, pulang_cepat: { weekday: [], saturday: [] } };
  (rules || []).forEach(r => { (penaltyRules[r.jenis]?.[r.day_type] ?? []).push(r); });

  // Jam masuk/pulang per (jadwal, hari-dalam-minggu) -- dipakai resolveShiftWindow()
  // supaya denda telat/pulang-cepat dihitung relatif thd jadwal MASING-MASING
  // karyawan, bukan jam dinding tetap (lihat komentar di hitungDendaTelat).
  scheduleDaysByKey = {};
  (schedDays || []).forEach(d => { scheduleDaysByKey[`${d.schedule_id}_${d.day_of_week}`] = d; });

  tzByLokasi = {};
  (locs || []).forEach(l => { tzByLokasi[l.name] = l.timezone; });

  const typeNameById = {};
  (types || []).forEach(t => { typeNameById[t.id] = t.nama; });
  allowancesByUser = {};
  (alw || []).forEach(a => {
    const nama = typeNameById[a.allowance_type_id];
    if (!nama) return; // jenisnya sudah dinonaktifkan, jangan dihitung
    (allowancesByUser[a.user_id] ??= []).push({ nama, nominal: a.nominal || 0 });
  });

  frozenSlipsByUser = {};
  (slips || []).forEach(s => { frozenSlipsByUser[s.user_id] = s.snapshot; });
}

// -----------------------------------------------------------------------
// MODE FINAL vs DRAFT
// Kalau periode sudah difinalisasi (periodInfo != null), semua tampilan
// (ringkasan, tabel, modal detail, export) pakai snapshot yang dibekukan
// di payroll_slips — TIDAK dihitung ulang dari absensi/tarif yang berlaku
// sekarang. Kalau belum, tetap dihitung live seperti sebelumnya.
// -----------------------------------------------------------------------
function getSlipList() {
  if (periodInfo) {
    // Roster yang ditampilkan = karyawan yang benar-benar punya slip beku
    // saat difinalisasi (karyawan baru sesudahnya tidak ikut nongol di
    // periode lama; karyawan yang keluar setelahnya tetap tampil di sini).
    return employees
      .map(e => frozenSlipsByUser[e.id])
      .filter(Boolean);
  }
  return employees.map(computeSlip);
}

function getSlip(userId) {
  if (periodInfo) return frozenSlipsByUser[userId] || null;
  const emp = employees.find(e => e.id === userId);
  return emp ? computeSlip(emp) : null;
}

function renderLockBanner() {
  const el = document.getElementById("slip-lock-banner");
  if (!el) return;
  if (roleFlags.isKaryawan) { el.innerHTML = ""; return; } // status finalisasi tidak relevan buat karyawan, cukup lihat slipnya saja
  if (periodInfo) {
    const namaPenetap = employees.find(e => e.id === periodInfo.finalized_by)?.full_name || "—";
    el.innerHTML = `
      <div class="status-card done" style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px;">
        <span>🔒 <strong>Final</strong> — periode ini sudah difinalisasi oleh ${namaPenetap} pada ${fmtDate(periodInfo.finalized_at)}. Nilai di bawah dibekukan, tidak berubah walau pengaturan cut-off/tarif berubah lagi nanti.</span>
        ${roleFlags.canFinalize ? `<button id="btn-unlock-period" class="btn-secondary" style="white-space:nowrap;">🔓 Buka Kunci</button>` : ""}
      </div>`;
    document.getElementById("btn-unlock-period")?.addEventListener("click", onUnlock);
  } else {
    el.innerHTML = `
      <div class="status-card" style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px;">
        <span>📝 <strong>Draft</strong> — nilai masih dihitung otomatis dan bisa berubah kalau absensi/lembur/tarif/pengaturan cut-off diubah.${roleFlags.canFinalize ? " Finalisasi untuk mengunci angka periode ini." : " Menunggu Super Admin memfinalisasi periode ini."}</span>
        ${roleFlags.canFinalize ? `<button id="btn-finalize-period" class="btn-primary" style="white-space:nowrap;">🔒 Finalisasi Periode Ini</button>` : ""}
      </div>`;
    document.getElementById("btn-finalize-period")?.addEventListener("click", onFinalize);
  }
}

async function onFinalize() {
  if (!roleFlags.canFinalize) { toast("Hanya Super Admin yang bisa finalisasi periode.", "error"); return; }
  if (!employees.length) { toast("Tidak ada data karyawan untuk difinalisasi", "error"); return; }
  const ok = confirm(`Finalisasi periode ${periodLabel(period)}?\n\nSetelah ini, angka slip gaji periode ini dikunci dan tidak akan berubah otomatis lagi walau cut-off/tarif diubah di kemudian hari. Bisa dibuka kunci lagi kalau perlu dikoreksi.`);
  if (!ok) return;

  const { data: inserted, error: errPeriod } = await supabase.from("payroll_periods").insert({
    period,
    period_start: periodRange.start,
    period_end: periodRange.end,
    cutoff_start_day: cutoffDay,
    finalized_by: currentUser.id,
  }).select().single();
  if (errPeriod) { toast("Gagal finalisasi: " + errPeriod.message, "error"); return; }

  const rows = employees.map(emp => {
    const slip = computeSlip(emp);
    return { period, user_id: emp.id, snapshot: slip, gaji_bersih: slip.gajiBersih };
  });
  const { error: errSlips } = await supabase.from("payroll_slips").insert(rows);
  if (errSlips) {
    // rollback baris payroll_periods supaya tidak nyangkut setengah-jadi
    await supabase.from("payroll_periods").delete().eq("period", period);
    toast("Gagal menyimpan slip: " + errSlips.message, "error");
    return;
  }

  finalizedPeriods[period] = inserted;
  toast("Periode berhasil difinalisasi", "success");
  await loadAndRender();
}

async function onUnlock() {
  if (!roleFlags.canFinalize) { toast("Hanya Super Admin yang bisa membuka kunci periode.", "error"); return; }
  const ok = confirm(`Buka kunci periode ${periodLabel(period)}?\n\nSlip yang sudah dibekukan akan dihapus dan periode ini kembali ke mode draft (dihitung live). Angka bisa jadi berbeda dari yang tadinya sudah dicetak, sampai difinalisasi ulang.`);
  if (!ok) return;

  const { error } = await supabase.from("payroll_periods").delete().eq("period", period);
  if (error) { toast("Gagal membuka kunci: " + error.message, "error"); return; }

  delete finalizedPeriods[period];
  toast("Periode dibuka kunci, kembali ke mode draft", "success");
  await loadAndRender();
}

function groupByUserSorted(rows) {
  const map = {};
  (rows || []).forEach(r => { (map[r.user_id] ??= []).push(r); });
  return map; // sudah urut desc dari query
}

// -----------------------------------------------------------------------
// PERHITUNGAN SATU SLIP
// -----------------------------------------------------------------------
function computeSlip(emp) {
  const level = jobLevels.find(l => l.grade === emp.grade && l.level === emp.level) || null;
  const attRows = attendanceByUser[emp.id] || [];
  const hariHadir = attRows.filter(a => a.check_in).length;
  const hariTelat = attRows.filter(a => a.check_in_status === "telat").length;

  const otRows = overtimeByUser[emp.id] || [];
  const jamHari = (o) => o.total_jam ?? roundOvertimeHours(o.start_time, o.end_time);
  const jamLemburBiasa = otRows.filter(o => !o.is_hari_libur).reduce((s, o) => s + jamHari(o), 0);
  const jamLemburLibur = otRows.filter(o => o.is_hari_libur).reduce((s, o) => s + jamHari(o), 0);

  // Denda keterlambatan & pulang cepat — dihitung per hari dari jam
  // check-in/check-out asli terhadap tabel jam bertingkat di Master Denda
  // Telat (bukan dari status telat/tepat-waktu jadwal kerja, yang dipakai
  // untuk keperluan monitoring absensi saja). Hanya totalnya yang tampil
  // di slip gaji karyawan, rincian per hari tidak dicetak.
  let dendaKeterlambatan = 0;
  let dendaPulangCepat = 0;
  const dendaDasar = level?.denda_terlambat || 0;
  const tz = tzByLokasi[emp.lokasi_kerja]; // zona waktu cabang tempat karyawan ini ditempatkan
  for (const a of attRows) {
    const dow = dayOfWeekFromDateStr(a.date);
    const shift = resolveShiftWindow(emp, dow);
    const telat = hitungDendaTelat(a.check_in, dow, dendaDasar, tz, shift);
    if (telat) dendaKeterlambatan += telat.amount;
    const cepat = hitungDendaPulangCepat(a.check_out, dow, dendaDasar, tz, shift);
    if (cepat) dendaPulangCepat += cepat.amount;
  }

  const adj = adjByUser[emp.id] || { hari_dinas: 0, tunjangan_lain: 0, keterangan_tunjangan: "", potongan_lain: 0, keterangan_potongan: "" };

  let gajiPokok = 0;
  let gajiPokokLabel = "-";
  if (emp.status_karyawan === "bulanan") {
    const s = (salaryByUser[emp.id] || [])[0];
    gajiPokok = s ? s.monthly_salary : 0;
    gajiPokokLabel = "Gaji Bulanan";
  } else if (emp.status_karyawan === "harian") {
    const w = (wageByUser[emp.id] || [])[0];
    gajiPokok = w ? w.daily_wage * hariHadir : 0;
    gajiPokokLabel = w ? `Upah Harian (${fmtRupiah(w.daily_wage)} x ${hariHadir} hari)` : "Upah Harian";
  }

  const rateLemburBiasa = level?.upah_lembur_hari_biasa || 0;
  const rateLemburLibur = level?.upah_lembur_hari_libur || 0;
  const uangLembur = jamLemburBiasa * rateLemburBiasa + jamLemburLibur * rateLemburLibur;
  const uangDinas = (adj.hari_dinas || 0) * (level?.uang_perjalanan_dinas || 0);
  const tunjanganList = allowancesByUser[emp.id] || []; // dari Master Tunjangan, per karyawan
  const tunjanganTambahan = tunjanganList.reduce((s, t) => s + (t.nominal || 0), 0);
  const tunjanganLain = adj.tunjangan_lain || 0;
  const totalPendapatan = gajiPokok + uangLembur + uangDinas + tunjanganTambahan + tunjanganLain;

  const upahLapor = level?.upah_lapor_bpjs || 0;
  const bpjsKesKaryawan = upahLapor * (level?.bpjs_kesehatan_karyawan_persen || 0) / 100;
  const bpjsTkKaryawan = upahLapor * (level?.bpjs_tk_karyawan_persen || 0) / 100;
  const pph21 = totalPendapatan * (level?.pph21_persen || 0) / 100;
  const potonganLain = adj.potongan_lain || 0;
  const totalPotongan = dendaKeterlambatan + dendaPulangCepat + bpjsKesKaryawan + bpjsTkKaryawan + pph21 + potonganLain;

  const gajiBersih = totalPendapatan - totalPotongan;

  return {
    emp, level, adj, hariHadir, hariTelat, jamLemburBiasa, jamLemburLibur,
    gajiPokok, gajiPokokLabel, rateLemburBiasa, rateLemburLibur, uangLembur, uangDinas, tunjanganList, tunjanganTambahan, tunjanganLain, totalPendapatan,
    dendaKeterlambatan, dendaPulangCepat, upahLapor, bpjsKesKaryawan, bpjsTkKaryawan, pph21, potonganLain, totalPotongan, gajiBersih,
  };
}

// -----------------------------------------------------------------------
function renderSummary() {
  const el = document.getElementById("slip-summary");
  if (roleFlags.isKaryawan) { el.innerHTML = ""; return; } // ringkasan agregat cuma relevan buat staff yang lihat banyak karyawan
  const slips = getSlipList();
  const totalBersih = slips.reduce((s, x) => s + x.gajiBersih, 0);
  const totalLembur = slips.reduce((s, x) => s + x.jamLemburBiasa + x.jamLemburLibur, 0);
  const belumDiatur = slips.filter(x => !x.emp.status_karyawan).length;

  el.innerHTML = `
    <div class="status-card">
      <span class="status-label">Karyawan Aktif</span>
      <span class="status-value">${slips.length}</span>
    </div>
    <div class="status-card done">
      <span class="status-label">Total Gaji Bersih</span>
      <span class="status-value">${fmtRupiah(totalBersih)}</span>
    </div>
    <div class="status-card">
      <span class="status-label">Total Jam Lembur</span>
      <span class="status-value">${fmtJam(totalLembur)}</span>
    </div>
    ${belumDiatur ? `
    <div class="status-card">
      <span class="status-label">Status Karyawan Belum Diatur</span>
      <span class="status-value">${belumDiatur}</span>
    </div>` : ""}
  `;
}

function renderTable() {
  const el = document.getElementById("slip-table");
  const slips = getSlipList();
  if (!slips.length) { el.innerHTML = `<p class="muted">${periodInfo ? "Tidak ada slip yang difinalisasi untuk periode ini." : "Belum ada data karyawan aktif."}</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Nama</th><th>Grade</th><th>Status</th>
          <th>Hadir / Telat</th><th>Lembur</th>
          <th>Gaji Pokok</th><th>Gaji Bersih</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${slips.map(s => `
          <tr>
            <td>${s.emp.full_name}</td>
            <td>${s.emp.grade ? `${s.emp.grade} — ${s.emp.level || "-"}` : `<span class="muted">-</span>`}</td>
            <td>${s.emp.status_karyawan
              ? `<span class="badge badge-ok">${s.emp.status_karyawan === "bulanan" ? "Bulanan" : "Harian"}</span>`
              : `<span class="badge badge-warn">Belum diatur</span>`}</td>
            <td>${s.hariHadir} / ${s.hariTelat}</td>
            <td>${fmtJam(s.jamLemburBiasa + s.jamLemburLibur)}</td>
            <td>${fmtRupiah(s.gajiPokok)}</td>
            <td><strong>${fmtRupiah(s.gajiBersih)}</strong></td>
            <td><button class="btn-link btn-detail" data-id="${s.emp.id}">Detail &amp; Cetak</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-detail").forEach(btn => {
    btn.addEventListener("click", () => openSlipModal(btn.dataset.id));
  });
}

// -----------------------------------------------------------------------
// MODAL DETAIL SLIP
// -----------------------------------------------------------------------
// Daftar pilihan periode untuk dropdown (dipakai kalau cutoffDay > 1):
// 2 periode ke depan + 12 periode ke belakang dari bulan berjalan,
// masing-masing dilabeli langsung dengan rentang tanggal cut-off-nya.
function buildPeriodOptions(centerPeriod, cutoffD) {
  const [cy, cm] = centerPeriod.split("-").map(Number);
  const options = [];
  for (let offset = 2; offset >= -12; offset--) {
    const d = new Date(cy, cm - 1 + offset, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    // Periode yang sudah final pakai rentang yang DIBEKUKAN saat itu, bukan
    // hasil hitung ulang dari cutoff yang berlaku sekarang.
    const frozen = finalizedPeriods[value];
    const { start, end } = frozen
      ? { start: frozen.period_start, end: frozen.period_end }
      : payrollPeriodRange(value, cutoffD);
    options.push({ value, label: `${fmtDate(start)} – ${fmtDate(end)}${frozen ? " 🔒" : ""}` });
  }
  return options;
}

function periodLabel(p) {
  // Kalau pakai cut-off (bukan kalender biasa) ATAU periode ini sudah
  // difinalisasi, tampilkan rentang tanggal aktualnya langsung — nama
  // bulan ("September 2026") gampang disalahartikan karena bisa tidak
  // sama dengan bulan awal periodenya, apalagi kalau sudah dibekukan.
  if ((cutoffDay > 1 || periodInfo) && periodRange.start && periodRange.end) {
    return `${fmtDate(periodRange.start)} – ${fmtDate(periodRange.end)}`;
  }
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

function openSlipModal(userId) {
  currentSlip = getSlip(userId);
  renderSlipContent(currentSlip);
  const btnAdjust = document.getElementById("btn-edit-adjust");
  if (btnAdjust) {
    btnAdjust.disabled = !!periodInfo;
    btnAdjust.title = periodInfo ? "Periode ini sudah final — buka kunci dulu untuk mengubah tunjangan/potongan." : "";
  }
  document.getElementById("modal-slip").classList.remove("hidden");
}

function renderSlipContent(s) {
  const e = s.emp;
  document.getElementById("slip-content").innerHTML = `
    <div class="slip-box">
      <div class="slip-header">
        <div>
          <h2>${e.unit_pt || "Slip Gaji"}</h2>
          <p class="muted small" style="margin-top:2px;">Slip Gaji Karyawan</p>
        </div>
        <div class="slip-period">
          <div class="muted small">Periode</div>
          <div style="font-weight:600;">${periodLabel(period)}</div>
        </div>
      </div>

      <div class="slip-emp-grid">
        <div><span class="label">Nama</span>${e.full_name}</div>
        <div><span class="label">Kode Karyawan</span>${e.employee_code || "-"}</div>
        <div><span class="label">Jabatan</span>${e.position || "-"}</div>
        <div><span class="label">Departemen</span>${e.department || "-"}${e.bagian ? ` / ${e.bagian}` : ""}</div>
        <div><span class="label">Grade / Level</span>${e.grade ? `${e.grade} — ${e.level || "-"}` : "-"}</div>
        <div><span class="label">Status Karyawan</span>${e.status_karyawan === "bulanan" ? "Bulanan" : e.status_karyawan === "harian" ? "Harian" : "Belum diatur"}</div>
        <div><span class="label">Hari Hadir / Telat</span>${s.hariHadir} / ${s.hariTelat}</div>
        <div><span class="label">Jam Lembur (Biasa/Libur)</span>${fmtJam(s.jamLemburBiasa)} / ${fmtJam(s.jamLemburLibur)}</div>
      </div>

      <div class="slip-cols">
        <div class="slip-col">
          <h4>Pendapatan</h4>
          <div class="slip-line"><span>${s.gajiPokokLabel}</span><span>${fmtRupiah(s.gajiPokok)}</span></div>
          <div class="slip-line"><span>Uang Lembur (${fmtJam(s.jamLemburBiasa)} biasa + ${fmtJam(s.jamLemburLibur)} libur)</span><span>${fmtRupiah(s.uangLembur)}</span></div>
          <div class="slip-line"><span>Uang Perjalanan Dinas (${s.adj.hari_dinas || 0} hari)</span><span>${fmtRupiah(s.uangDinas)}</span></div>
          ${s.tunjanganList.map(t => `<div class="slip-line"><span>${t.nama}</span><span>${fmtRupiah(t.nominal)}</span></div>`).join("")}
          <div class="slip-line"><span>${s.adj.keterangan_tunjangan || "Tunjangan Lain"}</span><span>${fmtRupiah(s.tunjanganLain)}</span></div>
          <div class="slip-line total"><span>Total Pendapatan</span><span>${fmtRupiah(s.totalPendapatan)}</span></div>
        </div>
        <div class="slip-col">
          <h4>Potongan</h4>
          <div class="slip-line"><span>Denda Keterlambatan</span><span>${fmtRupiah(s.dendaKeterlambatan)}</span></div>
          <div class="slip-line"><span>Denda Pulang Cepat</span><span>${fmtRupiah(s.dendaPulangCepat)}</span></div>
          <div class="slip-line"><span>BPJS Kesehatan (${s.level?.bpjs_kesehatan_karyawan_persen ?? 0}%)</span><span>${fmtRupiah(s.bpjsKesKaryawan)}</span></div>
          <div class="slip-line"><span>BPJS Ketenagakerjaan (${s.level?.bpjs_tk_karyawan_persen ?? 0}%)</span><span>${fmtRupiah(s.bpjsTkKaryawan)}</span></div>
          <div class="slip-line"><span>PPh21 (${s.level?.pph21_persen ?? 0}%)</span><span>${fmtRupiah(s.pph21)}</span></div>
          <div class="slip-line"><span>${s.adj.keterangan_potongan || "Potongan Lain"}</span><span>${fmtRupiah(s.potonganLain)}</span></div>
          <div class="slip-line total"><span>Total Potongan</span><span>${fmtRupiah(s.totalPotongan)}</span></div>
        </div>
      </div>

      <div class="slip-net">
        <span class="label">Gaji Bersih (Take Home Pay)</span>
        <span class="value">${fmtRupiah(s.gajiBersih)}</span>
      </div>

      ${!s.level ? `<p class="small muted" style="margin-top:16px;">⚠️ Grade/Level karyawan ini belum cocok dengan data di Master Level — denda, lembur, BPJS, PPh21, dan uang dinas dihitung Rp 0. Lengkapi Master Level &amp; Data Karyawan terlebih dahulu.</p>` : ""}
      ${!e.status_karyawan ? `<p class="small muted" style="margin-top:8px;">⚠️ Status Karyawan (Bulanan/Harian) belum diatur di Data Karyawan, sehingga Gaji Pokok belum bisa dihitung.</p>` : ""}
      <p class="small muted" style="margin-top:16px;">Dicetak ${fmtDate(new Date())} — dihasilkan otomatis oleh sistem, tidak memerlukan tanda tangan basah.</p>
    </div>
  `;
}

// -----------------------------------------------------------------------
// PENYESUAIAN MANUAL (payroll_adjustments)
// -----------------------------------------------------------------------
function openAdjustModal(userId) {
  if (!roleFlags.canEditAdjust) { toast("Kamu tidak punya akses untuk mengubah tunjangan/potongan.", "error"); return; }
  if (periodInfo) { toast("Periode ini sudah final — buka kunci dulu untuk mengubah tunjangan/potongan.", "error"); return; }
  const emp = employees.find(e => e.id === userId);
  const adj = adjByUser[userId] || { hari_dinas: 0, tunjangan_lain: 0, keterangan_tunjangan: "", potongan_lain: 0, keterangan_potongan: "" };
  const form = document.getElementById("form-adjust");
  form.dataset.userId = userId;
  form.hari_dinas.value = adj.hari_dinas || 0;
  form.tunjangan_lain.value = adj.tunjangan_lain || 0;
  form.keterangan_tunjangan.value = adj.keterangan_tunjangan || "";
  form.potongan_lain.value = adj.potongan_lain || 0;
  form.keterangan_potongan.value = adj.keterangan_potongan || "";
  document.getElementById("adjust-emp-label").textContent = `${emp.full_name} — ${periodLabel(period)}`;
  document.getElementById("modal-adjust").classList.remove("hidden");
}

async function onSubmitAdjust(e, user) {
  e.preventDefault();
  const form = e.target;
  const userId = form.dataset.userId;
  const fd = new FormData(form);
  const payload = {
    user_id: userId,
    period,
    hari_dinas: Number(fd.get("hari_dinas")) || 0,
    tunjangan_lain: Number(fd.get("tunjangan_lain")) || 0,
    keterangan_tunjangan: fd.get("keterangan_tunjangan") || null,
    potongan_lain: Number(fd.get("potongan_lain")) || 0,
    keterangan_potongan: fd.get("keterangan_potongan") || null,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("payroll_adjustments").upsert(payload, { onConflict: "user_id,period" });
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  toast("Tunjangan/potongan tersimpan", "success");
  document.getElementById("modal-adjust").classList.add("hidden");

  const { data: adj } = await supabase.from("payroll_adjustments").select("*").eq("period", period);
  adjByUser = {};
  (adj || []).forEach(a => { adjByUser[a.user_id] = a; });

  const emp = employees.find(x => x.id === userId);
  currentSlip = computeSlip(emp);
  renderSlipContent(currentSlip);
  renderSummary();
  renderTable();
}

// -----------------------------------------------------------------------
function doExport() {
  const slips = getSlipList();
  if (!slips.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const rows = slips.map(s => ({
    "Nama": s.emp.full_name,
    "Kode Karyawan": s.emp.employee_code || "-",
    "Grade": s.emp.grade || "-",
    "Level": s.emp.level || "-",
    "Status": s.emp.status_karyawan || "-",
    "Hari Hadir": s.hariHadir,
    "Hari Telat": s.hariTelat,
    "Jam Lembur Biasa": s.jamLemburBiasa,
    "Jam Lembur Libur": s.jamLemburLibur,
    "Gaji Pokok": s.gajiPokok,
    "Uang Lembur": s.uangLembur,
    "Uang Dinas": s.uangDinas,
    "Tunjangan Tambahan (Total)": s.tunjanganTambahan,
    "Rincian Tunjangan Tambahan": s.tunjanganList.map(t => `${t.nama}: ${fmtRupiah(t.nominal)}`).join("; ") || "-",
    "Tunjangan Lain": s.tunjanganLain,
    "Total Pendapatan": s.totalPendapatan,
    "Denda Keterlambatan": s.dendaKeterlambatan,
    "Denda Pulang Cepat": s.dendaPulangCepat,
    "BPJS Kesehatan": s.bpjsKesKaryawan,
    "BPJS Ketenagakerjaan": s.bpjsTkKaryawan,
    "PPh21": s.pph21,
    "Potongan Lain": s.potonganLain,
    "Total Potongan": s.totalPotongan,
    "Gaji Bersih": s.gajiBersih,
  }));
  exportXLSX(`slip-gaji-ringkasan-${period}.xlsx`, rows, "Slip Gaji");
}
