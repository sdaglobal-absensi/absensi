import { supabase } from "../supabaseClient.js";
import { toast, getPosition, getNearestOffice, uploadPhoto, captureFrameAsBlob, reverseGeocode, fmtTime, fmtDate, todayISO, dateOnlyISO, zonedDayOfWeek, zonedMinutesOfDay, zonedTimestamp, hmToMinutes, resolveUserTimezone, tzLabel } from "../core.js";
import { pushSupported, getPushStatus, subscribeToPush } from "../push.js";

const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

let stream = null;
let capturedBlob = null;
let pendingMode = null; // 'in' | 'out'
let afterSubmit = null; // dipanggil setelah absen berhasil (lihat openCamera)

// Status absensi karyawan saat ini: sesi terbuka, sudah lengkap hari ini, atau
// ada sesi lama yang lupa di-check-out. Dipakai bersama oleh halaman Absensi
// dan kartu absen di Dashboard supaya keduanya SELALU menampilkan hasil
// yang sama.
export async function loadAttendanceState(user, tz) {
  // Ambil absensi TERBARU milik user (bukan cuma "hari ini"), supaya shift
  // yang lintas hari (misal masuk jam 22:00, pulang besok jam 06:00) tetap
  // terdeteksi sebagai satu sesi yang sama saat check-out.
  const { data: latest } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", user.id)
    .order("check_in", { ascending: false })
    .limit(1)
    .maybeSingle();

  const today = todayISO(tz);
  let openShift = !!(latest && !latest.check_out);
  let staleOpen = false;

  // Sesi terbuka HANYA dianggap "masih berjalan" (dan memblokir check-in baru)
  // kalau tanggalnya hari ini, atau kalau itu memang shift lintas hari dari
  // kemarin (sesuai Master Jadwal Kerja karyawan). Kalau bukan keduanya —
  // misal karyawan shift reguler yang lupa check-out — jangan diblokir;
  // anggap sesi lama itu tertinggal, dan izinkan check-in baru hari ini.
  if (openShift && latest.date !== today) {
    const continuation = await isOvernightContinuation(user, latest, tz);
    if (!continuation) {
      staleOpen = true;
      openShift = false;
    }
  }

  // Kalau karyawan SUDAH mengajukan Koreksi Absen (pulang) untuk sesi stale
  // ini dan pengajuannya belum ditolak, jangan tampilkan banner "belum
  // check-out" lagi — sudah ditindaklanjuti, tinggal menunggu approval.
  // Banner baru muncul lagi kalau pengajuan itu DITOLAK (dan belum diajukan
  // ulang), supaya karyawan sadar harus bertindak lagi.
  if (staleOpen) {
    const alreadyRequested = await hasActiveCheckoutCorrection(user, latest.date);
    if (alreadyRequested) staleOpen = false;
  }

  let completedToday = !!(latest && latest.check_out && latest.date === today);
  let misdatedTail = false;
  if (completedToday) {
    misdatedTail = await isMorningTailMisdated(user, latest, tz);
    if (misdatedTail) completedToday = false; // izinkan check-in baru utk shift malam ini
  }
  const activeRow = openShift || completedToday ? latest : null;

  return { latest, openShift, staleOpen, completedToday, activeRow, misdatedTail };
}

// Cek apakah karyawan sudah punya pengajuan Koreksi Absen (jenis "pulang")
// untuk tanggal sesi stale tersebut, yang statusnya masih pending atau sudah
// disetujui. Kalau yang terakhir/terbaru untuk tanggal itu statusnya
// "rejected" (dan belum diajukan ulang), dianggap BELUM ditindaklanjuti —
// balik true dari sisi caller = false, supaya banner tetap muncul.
async function hasActiveCheckoutCorrection(user, attendanceDate) {
  const { data } = await supabase
    .from("attendance_correction_requests")
    .select("status, created_at")
    .eq("user_id", user.id)
    .eq("attendance_date", attendanceDate)
    .eq("correction_type", "pulang")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return !!data && data.status !== "rejected";
}

export async function render(container, user) {
  const tz = await resolveUserTimezone(user);
  const { latest, openShift, staleOpen, completedToday, activeRow, misdatedTail } = await loadAttendanceState(user, tz);

  const scheduleInfo = await loadMySchedule(user);

  container.innerHTML = `
    <div class="page-header">
      <h1>Absensi</h1>
      <div style="text-align:right;">
        <p class="muted" style="margin:0;">${new Date().toLocaleDateString("id-ID", { timeZone: tz || undefined, weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
        <div class="live-clock" id="live-clock">--:--:--</div>
      </div>
    </div>

    ${staleOpen ? reminderBannerHTML(latest) : ""}
    ${openShift ? `<p class="muted small" style="margin-top:-14px; margin-bottom:18px;">Sesi kerja dari ${fmtDate(activeRow.date)} masih berjalan (belum check-out).</p>` : ""}
    ${misdatedTail ? `<p class="small" style="margin-top:-14px; margin-bottom:18px; color:var(--muted);">ℹ️ Check-in ${fmtTime(latest.check_in)} – check-out ${fmtTime(latest.check_out)} tadi adalah sisa shift semalam. Kamu tetap bisa check-in untuk shift malam ini.</p>` : ""}

    ${scheduleCardHtml(scheduleInfo, tz)}

    <div class="status-grid">
      <div class="status-card ${activeRow?.check_in ? "done" : ""}">
        <span class="status-label">Check-in</span>
        <span class="status-value">${activeRow?.check_in ? fmtTime(activeRow.check_in) : "Belum absen"}</span>
        ${activeRow?.check_in_status ? `<span class="badge badge-${activeRow.check_in_status === "telat" ? "warn" : "ok"}">${activeRow.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : ""}
      </div>
      <div class="status-card ${activeRow?.check_out ? "done" : ""}">
        <span class="status-label">Check-out</span>
        <span class="status-value">${activeRow?.check_out ? fmtTime(activeRow.check_out) : "Belum absen"}</span>
      </div>
    </div>

    <div class="action-area">
      ${!openShift && !completedToday
        ? `<button id="btn-open-camera" class="btn-primary btn-lg" data-mode="in">Check-in Sekarang</button>`
        : openShift
        ? `<button id="btn-open-camera" class="btn-primary btn-lg" data-mode="out">Check-out Sekarang</button>`
        : `<p class="muted">Absensi hari ini sudah lengkap. Sampai jumpa besok 👋</p>`
      }
    </div>

    <div id="push-opt-in"></div>

    ${cameraModalHtml()}
  `;

  const btnOpen = document.getElementById("btn-open-camera");
  if (btnOpen) btnOpen.addEventListener("click", () => openCamera(btnOpen.dataset.mode, user, activeRow, tz));

  document.getElementById("btn-koreksi-checkout")?.addEventListener("click", () => goToKoreksiCheckout(latest));

  startLiveClock(tz);
  renderPushOptIn(user);
}

// =====================================================================
// PENGINGAT "LUPA CHECK-OUT" — beda dari notifikasi push (yang cuma dikirim
// beberapa kali lalu berhenti supaya tidak spam, lihat README-PUSH-NOTIFIKASI.md),
// banner ini ditampilkan LAGI setiap kali karyawan buka halaman Absensi atau
// Dashboard selama sesi lamanya (staleOpen) belum ditindaklanjuti sama
// sekali — supaya tidak tergantung pada notifikasi yang gampang
// di-dismiss/diabaikan/lupa. Begitu karyawan MENGAJUKAN Koreksi Absen untuk
// sesi itu (lihat hasActiveCheckoutCorrection() di loadAttendanceState),
// banner ini berhenti muncul — tidak perlu menunggu sampai disetujui admin.
// Kalau pengajuannya ditolak dan belum diajukan ulang, banner muncul lagi.
// Lihat juga loadPersonalStats() di dashboard.js untuk banner yang sama
// di halaman Dashboard.
export function reminderBannerHTML(latestOpenRow) {
  return `
    <div class="reminder-banner">
      <div class="reminder-banner-row">
        <span class="reminder-banner-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
        <div class="reminder-banner-body">
          <p class="reminder-banner-title">Kamu belum check-out dari sesi ${fmtDate(latestOpenRow.date)}</p>
          <p class="reminder-banner-desc">Check-in tercatat jam ${fmtTime(latestOpenRow.check_in)}, tapi jam pulangnya belum tersimpan. Ajukan Koreksi Absen sekarang supaya datanya lengkap dan tidak perlu diingatkan terus.</p>
          <div class="reminder-banner-actions">
            <button type="button" id="btn-koreksi-checkout" class="btn-primary btn-sm">Ajukan Koreksi Absen Sekarang</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Membawa karyawan ke menu Koreksi Absen dengan tanggal & jenis "pulang"
// sudah terisi otomatis, supaya proses menuntaskannya secepat mungkin
// (makin sedikit langkah, makin kecil kemungkinan ditunda lagi).
export function goToKoreksiCheckout(latestOpenRow) {
  sessionStorage.setItem("koreksi_prefill", JSON.stringify({
    attendance_date: latestOpenRow.date,
    correction_type: "pulang",
  }));
  document.querySelector('.nav-item[data-target="koreksi"]')?.click();
}

// Tawaran "aktifkan pengingat" — hanya muncul kalau browser mendukung push,
// karyawan belum berlangganan di device ini, DAN Super Admin sedang
// menyalakan notifikasi push absensi (tabel push_settings, diatur dari
// halaman Pengaturan Sistem). Kalau Super Admin mematikannya, kartu ini
// disembunyikan total (tidak ada yang bisa diklik) -- tapi karyawan yang
// SUDAH pernah aktif sebelumnya tetap tidak menerima notifikasi apapun
// selama saklar itu mati, karena Edge Function checkout-reminder juga
// mengecek saklar yang sama di sisi server.
// Sengaja tidak memunculkan prompt izin notifikasi secara otomatis (browser
// akan memblokir/mengabaikan permintaan izin yang tidak dipicu klik user,
// dan itu pengalaman yang buruk), jadi karyawan yang menekan tombolnya
// sendiri.
async function renderPushOptIn(user) {
  const el = document.getElementById("push-opt-in");
  if (!el || !pushSupported()) return;

  const { data: settings } = await supabase.from("push_settings").select("reminders_enabled").eq("id", 1).maybeSingle();
  if (settings && settings.reminders_enabled === false) return; // Super Admin mematikan notifikasi -> kartu tidak ditampilkan

  const status = await getPushStatus();
  if (status !== "not-subscribed") return; // sudah aktif, ditolak, atau tidak didukung

  el.innerHTML = `
    <div class="card" style="margin-top:16px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <p class="muted small" style="margin:0;">🔔 Mau diingatkan otomatis sebelum & sesudah jam masuk/pulang kalau lupa absen?</p>
      <button id="btn-aktifkan-pengingat" class="btn-secondary">Aktifkan Pengingat</button>
    </div>
  `;
  document.getElementById("btn-aktifkan-pengingat").addEventListener("click", async () => {
    const ok = await subscribeToPush(user);
    if (ok) el.innerHTML = "";
  });
}

// Modal kamera absen. Dipisah supaya bisa disisipkan juga di Dashboard.
export function cameraModalHtml() {
  return `
    <div id="camera-modal" class="modal hidden">
      <div class="modal-box">
        <h3 id="camera-title">Ambil Foto</h3>
        <p class="muted small" id="camera-status">Menyiapkan kamera & lokasi…</p>
        <div class="camera-frame">
          <video id="camera-video" autoplay playsinline></video>
          <canvas id="camera-preview" class="hidden"></canvas>
        </div>
        <div class="modal-actions">
          <button id="btn-cancel" class="btn-secondary">Batal</button>
          <button id="btn-capture" class="btn-primary" disabled>Ambil Foto</button>
          <button id="btn-retake" class="btn-secondary hidden">Ambil Ulang</button>
          <button id="btn-submit" class="btn-primary hidden">Kirim Absen</button>
        </div>
      </div>
    </div>
  `;
}

// Jam berjalan realtime di header halaman, mengikuti zona waktu LOKASI KERJA
// karyawan (tz -- lihat resolveUserTimezone), bukan jam device/HP-nya. Timer
// lama otomatis dihentikan tiap kali render() dipanggil ulang (misal ganti
// tab lalu balik lagi ke Absensi), dan juga berhenti sendiri kalau elemennya
// sudah tidak ada di DOM (user sudah pindah ke halaman lain).
let clockInterval = null;
function startLiveClock(tz) {
  if (clockInterval) clearInterval(clockInterval);
  const label = tzLabel(tz);

  function tick() {
    const el = document.getElementById("live-clock");
    if (!el) { clearInterval(clockInterval); clockInterval = null; return; }
    const timeStr = new Date().toLocaleTimeString("id-ID", { timeZone: tz || undefined, hour12: false });
    el.textContent = `${timeStr} ${label}`;
  }
  tick();
  clockInterval = setInterval(tick, 1000);
}

// Ambil jadwal kerja milik karyawan (untuk ditampilkan, dan dipakai juga
// oleh getLateCutoff supaya tidak query dua kali kalau memungkinkan).
async function loadMySchedule(user) {
  if (!user.schedule_id) return null;
  const [{ data: sched }, { data: days }] = await Promise.all([
    supabase.from("work_schedules").select("*").eq("id", user.schedule_id).maybeSingle(),
    supabase.from("work_schedule_days").select("*").eq("schedule_id", user.schedule_id).order("day_of_week"),
  ]);
  if (!sched) return null;
  return { sched, days: days || [] };
}

function scheduleCardHtml(info, tz) {
  const todayDow = zonedDayOfWeek(new Date(), tz);
  if (!info) {
    return `
      <div class="card" style="margin-bottom:24px;">
        <p class="muted small" style="margin:0;">Jadwal kerja belum diatur oleh admin. Hubungi HR/Admin kalau ini seharusnya sudah ada.</p>
      </div>
    `;
  }
  const { sched, days } = info;
  const todayRow = days.find(d => d.day_of_week === todayDow);
  const todayJam = todayRow && todayRow.is_working_day
    ? `${(todayRow.start_time || "").slice(0, 5)} – ${(todayRow.end_time || "").slice(0, 5)}${todayRow.crosses_midnight ? " (lintas hari)" : ""}`
    : "Libur";

  return `
    <div class="card" style="margin-bottom:24px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <div>
          <strong>Jadwal Kerja Saya: ${sched.name}</strong>
          <p style="margin:6px 0 0;">Hari ini (${DAY_NAMES[todayDow]}): <strong>${todayJam}</strong></p>
        </div>
        ${sched.late_tolerance_minutes ? `<span class="small muted">Toleransi telat: ${sched.late_tolerance_minutes} menit</span>` : ""}
      </div>
      <details style="margin-top:12px;">
        <summary class="small" style="cursor:pointer; color:var(--primary); font-weight:600;">Lihat jadwal satu minggu</summary>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="table">
            <thead><tr><th>Hari</th><th>Jam Kerja</th></tr></thead>
            <tbody>
              ${DAY_NAMES.map((name, i) => {
                const d = days.find(x => x.day_of_week === i);
                const isToday = i === todayDow;
                const jam = d && d.is_working_day
                  ? `${(d.start_time || "").slice(0, 5)} – ${(d.end_time || "").slice(0, 5)}${d.crosses_midnight ? " (lintas hari)" : ""}`
                  : `<span class="muted">Libur</span>`;
                return `<tr${isToday ? ' style="font-weight:600; background:var(--bg);"' : ""}><td>${name}${isToday ? " · <span class=\"small\" style=\"font-weight:400;\">Hari ini</span>" : ""}</td><td>${jam}</td></tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  `;
}

// Cek apakah sesi terbuka dari kemarin memang shift lintas hari (misal
// 22:00-06:00) berdasarkan Master Jadwal Kerja karyawan pada hari check-in
// tersebut terjadi. Kalau karyawan tidak punya jadwal, anggap bukan
// lintas hari (perilaku aman/default).
function yesterdayISO(base = new Date(), tz) {
  const d = new Date(base);
  d.setDate(d.getDate() - 1);
  return dateOnlyISO(d, tz);
}

async function isOvernightContinuation(user, row, tz) {
  if (!row || row.date !== yesterdayISO(new Date(), tz)) return false;
  if (!user.schedule_id) return false;
  const dow = zonedDayOfWeek(new Date(row.check_in), tz);
  const { data: day } = await supabase
    .from("work_schedule_days")
    .select("crosses_midnight")
    .eq("schedule_id", user.schedule_id)
    .eq("day_of_week", dow)
    .maybeSingle();
  return !!day?.crosses_midnight;
}

// Kebalikan dari isOvernightContinuation: mendeteksi sesi yang SUDAH check-out,
// tanggalnya kebetulan HARI INI, tapi jam check-in-nya jauh lebih pagi dari jam
// mulai shift hari ini (mis. check-in 01:03 padahal shift malam hari ini baru
// mulai 22:00). Ini kelanjutan shift SEMALAM yang salah tersimpan dengan
// tanggal hari ini -- bisa terjadi kalau shift kemarin di Master Jadwal Kerja
// belum ditandai "Lintas Hari", atau kemarin bukan hari kerja. Baris begini
// TIDAK BOLEH dianggap "absensi hari ini sudah lengkap" -- karyawan harus
// tetap bisa check-in untuk shift malam ini yang sungguhan baru mau mulai.
async function isMorningTailMisdated(user, row, tz) {
  if (!user.schedule_id) return false;
  const dow = zonedDayOfWeek(new Date(row.check_in), tz);
  const { data: day } = await supabase
    .from("work_schedule_days")
    .select("is_working_day, start_time, crosses_midnight")
    .eq("schedule_id", user.schedule_id)
    .eq("day_of_week", dow)
    .maybeSingle();
  if (!day?.is_working_day || !day.crosses_midnight || !day.start_time) return false;
  const startMinutes = hmToMinutes(day.start_time.slice(0, 5));
  const checkinMinutes = zonedMinutesOfDay(row.check_in, tz);
  return checkinMinutes < startMinutes;
}

// Tentukan TANGGAL & HARI-JADWAL yang relevan untuk sebuah check-in BARU
// (bukan cuma tanggal kalender "hari ini" apa adanya). Ini krusial untuk
// shift lintas tengah malam (mis. 22:00-06:00): kalau karyawan baru
// check-in dini hari (mis. 00:12, telat 2+ jam dari jam masuk 22:00),
// check-in itu SECARA JADWAL masih bagian dari shift yang mulai KEMARIN,
// bukan shift baru "hari ini". Kalau tetap dicatat dengan tanggal hari ini,
// baris attendance hari ini (unique per karyawan+tanggal) langsung
// "terpakai" oleh shift semalam yang cuma telat check-in, sehingga shift
// yang sungguhan baru mulai malam ini (di tanggal kalender yang sama)
// jadi tidak bisa check-in sama sekali -- padahal jam shiftnya sendiri
// sudah lewat. Fungsi ini cuma dipanggil saat memulai check-in BARU (tidak
// ada sesi terbuka), jadi aman dipakai berdampingan dengan openShift/
// isOvernightContinuation di atas.
async function resolveShiftDate(user, now, tz) {
  const todayStr = dateOnlyISO(now, tz);
  const todayDow = zonedDayOfWeek(now, tz);
  if (!user.schedule_id) return { dateStr: todayStr, dow: todayDow };

  const nowMinutes = zonedMinutesOfDay(now, tz);
  const yst = new Date(now);
  yst.setDate(yst.getDate() - 1);
  const yesterdayStr = dateOnlyISO(yst, tz);
  const yesterdayDow = zonedDayOfWeek(yst, tz);

  const [{ data: todayRow }, { data: yesterdayRow }] = await Promise.all([
    supabase.from("work_schedule_days").select("*").eq("schedule_id", user.schedule_id).eq("day_of_week", todayDow).maybeSingle(),
    supabase.from("work_schedule_days").select("*").eq("schedule_id", user.schedule_id).eq("day_of_week", yesterdayDow).maybeSingle(),
  ]);

  // Kemarin memang jadwal shift lintas hari, DAN sekarang masih sebelum jam
  // pulang shift semalam itu, DAN shift hari ini sendiri belum waktunya
  // mulai (atau hari ini libur) -- berarti ini check-in telat utk shift
  // kemarin, bukan shift baru hari ini.
  if (yesterdayRow?.is_working_day && yesterdayRow.crosses_midnight && yesterdayRow.end_time) {
    const endMinutes = hmToMinutes(yesterdayRow.end_time.slice(0, 5));
    const todayShiftAlreadyStarted = !!(todayRow?.is_working_day && todayRow.start_time) && nowMinutes >= hmToMinutes(todayRow.start_time.slice(0, 5));
    if (nowMinutes < endMinutes && !todayShiftAlreadyStarted) {
      return { dateStr: yesterdayStr, dow: yesterdayDow };
    }
  }
  return { dateStr: todayStr, dow: todayDow };
}

// Dipanggil dari halaman Absensi maupun Dashboard.
// onDone = fungsi yang dijalankan setelah absen BERHASIL terkirim (mis. muat
// ulang halaman yang sedang tampil). Kalau tidak diisi, halaman Absensi yang
// dimuat ulang.
export async function openCamera(mode, user, activeRow, tz, onDone = null) {
  pendingMode = mode;
  capturedBlob = null;
  afterSubmit = onDone;
  // Kembalikan tampilan modal ke keadaan awal (video tampil, tombol Ambil Foto).
  // Tanpa ini, kalau sebelumnya foto sudah diambil lalu dibatalkan, modal yang
  // dibuka lagi masih menampilkan foto lama, bukan kamera.
  retake();
  const modal = document.getElementById("camera-modal");
  modal.classList.remove("hidden");
  document.getElementById("camera-title").textContent = mode === "in" ? "Check-in" : "Check-out";
  document.getElementById("camera-status").textContent = "Menyiapkan kamera & lokasi…";
  document.getElementById("btn-capture").disabled = true;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    const video = document.getElementById("camera-video");
    video.srcObject = stream;
    document.getElementById("camera-status").textContent = "Kamera siap. Ambil lokasi GPS…";

    // Validasi GPS di background, tidak blokir kamera
    getPosition()
      .then(async pos => {
        const office = await getNearestOffice(pos.lat, pos.lng);
        window.__pendingPos = pos;
        window.__pendingOffice = office;
        window.__pendingAddress = null;
        if (office && office.distance > office.radius_meters) {
          document.getElementById("camera-status").textContent =
            `⚠️ Kamu ${Math.round(office.distance)}m dari ${office.name} (radius ${office.radius_meters}m). Absen tetap bisa dikirim untuk ditinjau admin.`;
        } else if (office) {
          document.getElementById("camera-status").textContent = `Lokasi terverifikasi ✓ (${office.name}). Silakan ambil foto.`;
        } else {
          document.getElementById("camera-status").textContent = "Lokasi tercatat, tapi belum ada data kantor untuk dibandingkan. Silakan ambil foto.";
        }
        document.getElementById("btn-capture").disabled = false;
        // Cari alamat dari koordinat di belakang layar (tidak memblokir tombol Ambil Foto)
        reverseGeocode(pos.lat, pos.lng).then(addr => { window.__pendingAddress = addr; });
      })
      .catch(err => {
        document.getElementById("camera-status").textContent = "⚠️ " + err.message + " Kamu tetap bisa lanjut tanpa GPS.";
        window.__pendingPos = null;
        window.__pendingOffice = null;
        document.getElementById("btn-capture").disabled = false;
      });
  } catch (err) {
    document.getElementById("camera-status").textContent = "❌ Tidak bisa mengakses kamera: " + err.message;
  }

  document.getElementById("btn-cancel").onclick = closeCamera;
  document.getElementById("btn-capture").onclick = capturePhoto;
  document.getElementById("btn-retake").onclick = retake;
  document.getElementById("btn-submit").onclick = () => submitAttendance(user, activeRow, tz);
}

function buildWatermarkLines() {
  const now = new Date();
  const timeStr = now.toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const pos = window.__pendingPos;
  const addressStr = window.__pendingAddress
    || (pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : "Lokasi tidak tersedia");
  return [timeStr, addressStr];
}

async function capturePhoto() {
  const video = document.getElementById("camera-video");
  const watermarkLines = buildWatermarkLines();
  capturedBlob = await captureFrameAsBlob(video, watermarkLines);

  video.classList.add("hidden");
  const canvas = document.getElementById("camera-preview");
  canvas.classList.remove("hidden");

  // Gambar ulang dari hasil blob (yang sudah ada watermark-nya) supaya
  // preview yang dilihat karyawan persis sama dengan yang akan diupload.
  const bitmap = await createImageBitmap(capturedBlob);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);

  document.getElementById("btn-capture").classList.add("hidden");
  document.getElementById("btn-retake").classList.remove("hidden");
  document.getElementById("btn-submit").classList.remove("hidden");
}

function retake() {
  capturedBlob = null;
  document.getElementById("camera-video").classList.remove("hidden");
  document.getElementById("camera-preview").classList.add("hidden");
  document.getElementById("btn-capture").classList.remove("hidden");
  document.getElementById("btn-retake").classList.add("hidden");
  document.getElementById("btn-submit").classList.add("hidden");
}

// Tentukan status tepat-waktu/telat berdasarkan Master Jadwal Kerja milik
// karyawan, DIHITUNG dalam zona waktu lokasi kerja karyawan tsb (tz -- lihat
// resolveUserTimezone). Kalau karyawan belum dikaitkan ke jadwal manapun SAMA
// SEKALI, pakai jam 08:15 sebagai cadangan (perilaku lama) supaya tidak
// mengganggu yang belum sempat diatur adminnya.
//
// PENTING: cadangan 08:15 ini HANYA untuk karyawan tanpa schedule_id sama
// sekali. Kalau karyawan SUDAH punya jadwal tapi tanggal yang relevan
// (shiftCtx.dateStr/dow, lihat resolveShiftDate) ternyata "Libur" atau tidak
// ketemu baris jadwalnya, function ini mengembalikan null -- BUKAN ikut jatuh
// ke cadangan 08:15. Sebelumnya bug ini menyebabkan check-in di hari libur
// (mis. shift lintas hari yang salah terdeteksi sebagai hari terpisah, atau
// karyawan absen di luar jadwal) selalu dicap "Tepat waktu" begitu saja
// selama jamnya masih di bawah 08:15, padahal sebetulnya tidak ada shift yang
// jadi acuan sama sekali untuk tanggal itu. Pemanggil (submitAttendance) yang
// menerima null berarti tidak boleh memberi status telat/tepat_waktu --
// simpan check_in_status = null (badge-nya otomatis tidak tampil, sama
// seperti baris lama yang belum ada statusnya).
async function getLateCutoff(user, now, tz, shiftCtx) {
  const { dateStr: todayStr, dow } = shiftCtx || await resolveShiftDate(user, now, tz); // tanggal & hari-jadwal yang relevan (lihat resolveShiftDate)
  if (user.schedule_id) {
    const [{ data: sched }, { data: day }] = await Promise.all([
      supabase.from("work_schedules").select("*").eq("id", user.schedule_id).maybeSingle(),
      supabase.from("work_schedule_days").select("*").eq("schedule_id", user.schedule_id).eq("day_of_week", dow).maybeSingle(),
    ]);
    if (day?.is_working_day && day.start_time) {
      const [h, m] = day.start_time.split(":").map(Number);
      const toleranceMs = (sched?.late_tolerance_minutes || 0) * 60000;
      return new Date(zonedTimestamp(todayStr, h, m, 0, tz) + toleranceMs);
    }
    return null; // karyawan punya jadwal, tapi tanggal ini Libur/tidak ada barisnya -> tidak ada acuan jam masuk
  }
  return new Date(zonedTimestamp(todayStr, 8, 15, 0, tz));
}

async function submitAttendance(user, activeRow, tz) {
  if (!capturedBlob) { toast("Ambil foto dulu", "error"); return; }
  const submitBtn = document.getElementById("btn-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Mengirim…";

  try {
    const pos = window.__pendingPos;
    const office = window.__pendingOffice;
    const photoUrl = await uploadPhoto(capturedBlob, `${user.id}/${pendingMode}`);
    const now = new Date();

    if (pendingMode === "in") {
      const shiftCtx = await resolveShiftDate(user, now, tz);
      const cutoff = await getLateCutoff(user, now, tz, shiftCtx);
      // cutoff null = tidak ada jadwal kerja yang jadi acuan untuk tanggal ini
      // (Libur / baris jadwal tidak ketemu) -> jangan dicap telat ataupun
      // tepat waktu, biarkan check_in_status kosong (lihat komentar getLateCutoff).
      const status = cutoff ? (now > cutoff ? "telat" : "tepat_waktu") : null;

      const { error } = await supabase.from("attendance").insert({
        user_id: user.id,
        date: shiftCtx.dateStr,
        check_in: now.toISOString(),
        check_in_lat: pos?.lat ?? null,
        check_in_lng: pos?.lng ?? null,
        check_in_distance_m: office ? Math.round(office.distance) : null,
        check_in_photo_url: photoUrl,
        check_in_status: status,
      });
      if (error) throw error;
      toast("Check-in berhasil!", "success");
    } else {
      // Update baris sesi yang masih terbuka (bisa jadi tanggalnya kemarin,
      // untuk shift lintas hari), bukan selalu baris tanggal hari ini.
      if (!activeRow) throw new Error("Tidak ada sesi check-in yang terbuka.");
      const { error } = await supabase.from("attendance").update({
        check_out: now.toISOString(),
        check_out_lat: pos?.lat ?? null,
        check_out_lng: pos?.lng ?? null,
        check_out_distance_m: office ? Math.round(office.distance) : null,
        check_out_photo_url: photoUrl,
      }).eq("id", activeRow.id);
      if (error) throw error;
      toast("Check-out berhasil!", "success");
    }

    closeCamera();
    if (afterSubmit) afterSubmit();
    else render(document.getElementById("content"), user);
  } catch (err) {
    toast("Gagal mengirim absen: " + err.message, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Kirim Absen";
  }
}

function closeCamera() {
  document.getElementById("camera-modal").classList.add("hidden");
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  capturedBlob = null;
}
