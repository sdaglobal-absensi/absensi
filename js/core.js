import { supabase } from "./supabaseClient.js";

// =====================================================================
// TOAST NOTIFICATION
// =====================================================================
export function toast(message, type = "info") {
  const box = document.getElementById("toast-box") || (() => {
    const el = document.createElement("div");
    el.id = "toast-box";
    document.body.appendChild(el);
    return el;
  })();
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.textContent = message;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// =====================================================================
// ROLE — 4 role: super_admin (satu-satunya role "root", all akses, TIDAK
// bisa dibatasi lewat toggle apapun — ini yang benar-benar tembus di sisi
// server/RLS juga), super_admin_hr, admin_hr, dan karyawan (akses ketiganya
// dibatasi & diatur manual lewat menu "Pengaturan Sistem", persis sama
// perlakuannya satu sama lain — super_admin_hr TIDAK istimewa lagi
// dibanding admin_hr/karyawan, cuma nama role-nya saja yang beda).
// =====================================================================
export const SUPER_ROLES = ["super_admin"];
export const STAFF_ROLES = ["super_admin", "super_admin_hr", "admin_hr"];

export function isSuper(role) {
  return SUPER_ROLES.includes(role);
}

// Menu yang bisa dinyalakan/dimatikan untuk super_admin_hr, admin_hr, dan
// karyawan lewat menu "Pengaturan Sistem" (satu toggle set per role,
// independen satu sama lain). "pengaturan-sistem" (halaman ini sendiri) juga
// ada di daftar yang bisa ditoggle — defaultnya MATI untuk ketiga role, jadi
// tidak ada perubahan perilaku sampai super_admin sengaja menyalakannya. Kalau
// dinyalakan untuk super_admin_hr, dia bisa membuka halaman ini DAN ikut
// mengelola akses menu (termasuk punya akses dirinya sendiri) serta periode
// cut-off slip gaji — jadi nyalakan hanya kalau memang mau didelegasikan.
// super_admin sendiri selalu punya akses penuh, tidak pernah bergantung ke
// toggle ini (lihat isSuper()/getAllowedMenus() di bawah).
const TOGGLABLE_ROLES = ["super_admin_hr", "admin_hr", "karyawan"];
let cachedPermissions = null; // Set<menu_id> enabled=true untuk role user ini, di-cache per sesi halaman
let cachedPermissionsRole = null; // role yang lagi di-cache, buat jaga-jaga kalau role user berubah di sesi yang sama
export async function getAllowedMenus(user) {
  if (isSuper(user.role)) return null; // null = semua menu, tidak difilter (khusus super_admin)
  if (!TOGGLABLE_ROLES.includes(user.role)) return new Set();

  if (cachedPermissions && cachedPermissionsRole === user.role) return cachedPermissions;
  const { data, error } = await supabase
    .from("role_permissions")
    .select("menu_id")
    .eq("role", user.role)
    .eq("enabled", true);
  cachedPermissions = new Set(error ? [] : (data || []).map(r => r.menu_id));
  cachedPermissionsRole = user.role;
  return cachedPermissions;
}

// Dipanggil setelah menu "Pengaturan Sistem" menyimpan perubahan supaya
// sidebar & guard langsung ikut ter-update tanpa perlu refresh halaman.
export function invalidatePermissionCache() {
  cachedPermissions = null;
}

// =====================================================================
// SIDEBAR — menu berbeda tergantung role
// =====================================================================
// Menu pribadi (absensi/izin/lembur/riwayat sendiri) — dulu cuma dipakai
// role karyawan, sekarang ditampilkan juga di sidebar super_admin,
// super_admin_hr, dan admin_hr (semua orang, apapun rolenya, tetap perlu
// absen/ajukan izin & lembur untuk dirinya sendiri). Untuk super_admin_hr,
// admin_hr & karyawan, masing-masing disaring lewat getAllowedMenus() (toggle
// independen per role di Pengaturan Sistem); untuk super_admin (satu-satunya
// root) selalu tampil semua (All Akses).
const EMPLOYEE_SELF_MENUS = [
  { id: "absensi", label: "Absensi", icon: "clock" },
  { id: "izin", label: "Pengajuan Izin", icon: "file" },
  { id: "lembur", label: "Pengajuan Lembur", icon: "file" },
  { id: "riwayat", label: "Riwayat Saya", icon: "history" },
  { id: "slip-gaji-saya", label: "Slip Gaji Saya", icon: "file" },
];

const MENUS = {
  karyawan: EMPLOYEE_SELF_MENUS,
  // Dipakai bersama oleh super_admin, super_admin_hr, dan admin_hr — untuk
  // super_admin_hr/admin_hr, daftar ini disaring lewat getAllowedMenus()
  // sebelum ditampilkan. "pengaturan-sistem" ikut di sini juga (bukan lagi
  // daftar terpisah yang selalu tersembunyi) — untuk super_admin selalu
  // tampil (allowed = null = tidak difilter), untuk role lain baru tampil
  // kalau memang dinyalakan lewat toggle "Kelola Akses Menu" (defaultnya
  // mati untuk semua role selain super_admin).
  staff: [
    { id: "karyawan", label: "Data Karyawan", icon: "users", section: "Organisasi" },
    { id: "struktur-organisasi", label: "Struktur Organisasi", icon: "layers", section: "Organisasi" },
    { id: "absensi-monitor", label: "Monitor Absensi", icon: "clock", section: "Approval & Monitoring" },
    { id: "izin-approval", label: "Approval Izin", icon: "check", section: "Approval & Monitoring" },
    { id: "lembur-approval", label: "Approval Lembur", icon: "check", section: "Approval & Monitoring" },
    { id: "kenaikan-upah", label: "Kenaikan Upah & Gaji", icon: "chart", section: "Payroll & Laporan" },
    { id: "slip-gaji", label: "Slip Gaji", icon: "file", section: "Payroll & Laporan" },
    { id: "laporan", label: "Laporan", icon: "chart", section: "Payroll & Laporan" },
    { id: "master-level", label: "Master Level", icon: "layers", section: "Master Data" },
    { id: "master-tunjangan", label: "Master Tunjangan", icon: "chart", section: "Master Data" },
    { id: "master-denda", label: "Master Denda Telat", icon: "file", section: "Master Data" },
    { id: "master-departemen", label: "Master Departemen", icon: "grid", section: "Master Data" },
    { id: "master-jadwal", label: "Master Jadwal Kerja", icon: "clock", section: "Master Data" },
    { id: "master-libur", label: "Master Hari Libur", icon: "file", section: "Master Data" },
    { id: "master-lokasi", label: "Master Lokasi Kantor", icon: "grid", section: "Master Data" },
    { id: "pengaturan-sistem", label: "Pengaturan Sistem", icon: "gear", section: "Super Admin" },
  ],
};

const ICONS = {
  clock: "M12 6v6l4 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6",
  history: "M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8",
  check: "M20 6L9 17l-5-5",
  chart: "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  layers: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
};

// Menghitung daftar menu yang akan ditampilkan di sidebar untuk user ini,
// setelah difilter lewat getAllowedMenus() (kalau super_admin_hr, admin_hr,
// atau karyawan — ketiganya diperlakukan sama persis, TERMASUK menu staff:
// kalau menu staff dicentang "Diizinkan" untuk Karyawan di Kelola Akses Menu,
// menu itu memang harus ikut muncul di sidebar Karyawan juga, bukan cuma
// untuk Admin HR/Super Admin HR). allowed = null cuma untuk super_admin
// (satu-satunya role yang tidak difilter).
export async function resolveMenu(user) {
  const allowed = await getAllowedMenus(user); // null utk super_admin = semua, tidak difilter

  // Menu pribadi (grup "Menu Saya") digabung di atas menu staff (termasuk
  // "Pengaturan Sistem"), semuanya disaring bareng lewat toggle yang sama
  // (allowed) untuk super_admin_hr, admin_hr, DAN karyawan — ketiganya
  // sekarang lewat jalur yang benar-benar sama, tidak ada jalur khusus lagi
  // untuk karyawan yang diam-diam mengabaikan menu staff. Untuk super_admin,
  // allowed = null = semua, jadi semua menu (termasuk "Pengaturan Sistem")
  // selalu tampil untuknya tanpa perlu toggle.
  const personal = EMPLOYEE_SELF_MENUS.map(m => ({ ...m, section: "Menu Saya" }));
  const combined = [...personal, ...MENUS.staff];
  return allowed ? combined.filter(m => allowed.has(m.id)) : combined;
}

export async function renderSidebar(user, activeId) {
  const menu = await resolveMenu(user);
  const nav = document.getElementById("sidebar-nav");
  let html = "";
  let lastSection;
  for (const item of menu) {
    if (item.section && item.section !== lastSection) {
      html += `<div class="nav-section-label">${item.section}</div>`;
    }
    lastSection = item.section;
    html += `
      <button class="nav-item ${item.id === activeId ? "active" : ""}" data-target="${item.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[item.icon]}"/></svg>
        <span>${item.label}</span>
      </button>
    `;
  }
  nav.innerHTML = html;

  const initials = (user.full_name || "?")
    .trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
  const avatarEl = document.getElementById("sidebar-avatar");
  if (avatarEl) avatarEl.textContent = initials;
  document.getElementById("sidebar-user-name").textContent = user.full_name;
  document.getElementById("sidebar-user-role").textContent = roleLabel(user.role);
  return menu;
}

export function roleLabel(role) {
  return {
    super_admin: "Super Admin",
    super_admin_hr: "Super Admin HR",
    admin_hr: "Admin HR",
    karyawan: "Karyawan",
  }[role] || role;
}

// =====================================================================
// PERIODE SLIP GAJI (cut-off) — diatur lewat menu "Pengaturan Sistem",
// disimpan di tabel payroll_settings (satu baris global untuk semua
// karyawan). cutoff_start_day = 1 berarti periode kalender biasa
// (tanggal 1 - akhir bulan). cutoff_start_day > 1 (mis. 26) berarti
// periode berjalan dari tanggal itu di bulan sebelumnya sampai
// (cutoff_start_day - 1) di bulan yang dipilih.
// =====================================================================
let cachedCutoffDay = null;
export async function getPayrollCutoffDay() {
  if (cachedCutoffDay != null) return cachedCutoffDay;
  const { data, error } = await supabase.from("payroll_settings").select("cutoff_start_day").eq("id", 1).single();
  cachedCutoffDay = error || !data ? 1 : (data.cutoff_start_day || 1);
  return cachedCutoffDay;
}

export function invalidatePayrollSettingsCache() {
  cachedCutoffDay = null;
}

// periodYYYYMM: string "YYYY-MM" dipilih di filter. Mengembalikan
// { start, end } (format YYYY-MM-DD) rentang tanggal absensi/lembur yang
// dipakai untuk menghitung slip gaji periode tsb.
export function payrollPeriodRange(periodYYYYMM, cutoffStartDay = 1) {
  const [y, m] = periodYYYYMM.split("-").map(Number);
  if (!cutoffStartDay || cutoffStartDay <= 1) {
    // Periode kalender biasa: tanggal 1 s/d akhir bulan yang sama.
    return { start: `${periodYYYYMM}-01`, end: dateOnlyISO(new Date(y, m, 0)) };
  }
  // Periode cut-off: mulai tanggal cutoffStartDay bulan SEBELUMNYA,
  // berakhir tanggal (cutoffStartDay - 1) bulan yang dipilih.
  const startDate = new Date(y, m - 2, cutoffStartDay);
  const endDate = new Date(y, m - 1, cutoffStartDay - 1);
  return { start: dateOnlyISO(startDate), end: dateOnlyISO(endDate) };
}

// =====================================================================
// GEOLOCATION
// =====================================================================
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Perangkat tidak mendukung GPS."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error("Gagal mengambil lokasi: " + err.message)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// Jarak antara 2 koordinat dalam meter (Haversine)
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export async function getNearestOffice(lat, lng) {
  const { data: offices } = await supabase.from("office_locations").select("*").eq("is_active", true);
  if (!offices || offices.length === 0) return null;
  let nearest = null;
  let minDist = Infinity;
  for (const o of offices) {
    const d = distanceMeters(lat, lng, o.lat, o.lng);
    if (d < minDist) { minDist = d; nearest = { ...o, distance: d }; }
  }
  return nearest;
}

// =====================================================================
// UPLOAD FOTO ke Supabase Storage, return public URL
// =====================================================================
export async function uploadPhoto(fileOrBlob, pathPrefix) {
  const ext = "jpg";
  const fileName = `${pathPrefix}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("attendance-photos")
    .upload(fileName, fileOrBlob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from("attendance-photos").getPublicUrl(fileName);
  return data.publicUrl;
}

// Ambil Blob dari elemen <video> (dipakai setelah capture kamera).
// watermarkLines (opsional): array baris teks yang dicap di bagian bawah foto
// (misal [waktu, alamat]).
export function captureFrameAsBlob(videoEl, watermarkLines = null) {
  return new Promise(resolve => {
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0);
    if (watermarkLines && watermarkLines.length) {
      drawPhotoWatermark(ctx, canvas.width, canvas.height, watermarkLines);
    }
    canvas.toBlob(blob => resolve(blob), "image/jpeg", 0.85);
  });
}

// Cap teks (waktu, alamat, dsb) di bagian bawah foto dengan latar semi-transparan.
function drawPhotoWatermark(ctx, w, h, lines) {
  const padding = Math.max(8, Math.floor(h * 0.018));
  const fontSize = Math.max(12, Math.floor(h * 0.026));
  const lineHeight = Math.round(fontSize * 1.45);
  ctx.font = `${fontSize}px -apple-system, Arial, sans-serif`;

  // Bungkus tiap baris supaya tidak keluar dari lebar foto
  const maxWidth = w - padding * 2;
  const wrapped = [];
  lines.forEach(line => {
    const words = String(line).split(" ");
    let current = "";
    words.forEach(word => {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        wrapped.push(current);
        current = word;
      } else {
        current = test;
      }
    });
    if (current) wrapped.push(current);
  });
  const capped = wrapped.slice(0, 4); // batasi maksimal 4 baris

  const barHeight = capped.length * lineHeight + padding * 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, h - barHeight, w, barHeight);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  capped.forEach((line, i) => {
    ctx.fillText(line, padding, h - barHeight + padding + i * lineHeight);
  });
}

// Cari lokasi berdasarkan nama/alamat (forward geocode) lewat OpenStreetMap
// Nominatim. Cocok untuk alamat/tempat umum yang sudah terdaftar di peta;
// nama internal perusahaan yang sangat spesifik mungkin tidak ketemu —
// pemanggil tetap harus sediakan opsi isi manual sebagai fallback.
export async function searchLocation(query) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`,
      { headers: { "Accept-Language": "id" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(d => ({ label: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) }));
  } catch (e) {
    return [];
  }
}
// tanpa API key). Bisa gagal/lambat; pemanggil harus siap fallback ke
// koordinat mentah kalau hasilnya null.
export async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0`,
      { headers: { "Accept-Language": "id" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (e) {
    return null;
  }
}

// =====================================================================
// FORMAT HELPERS
// =====================================================================
export function fmtDate(d) {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtTime(d) {
  if (!d) return "-";
  return new Date(d).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(d) {
  if (!d) return "-";
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

// ---------------------------------------------------------------------
// ZONA WAKTU KANTOR (per cabang/lokasi kerja)
// ---------------------------------------------------------------------
// Tiap baris di Master Lokasi Kantor (office_locations) sekarang punya
// kolom "timezone" sendiri (WIB/WITA/WIT), dan tiap karyawan dikaitkan ke
// satu lokasi lewat profiles.lokasi_kerja. Semua fungsi di bawah ini
// menerima parameter "tz" opsional (kode IANA, mis. "Asia/Makassar") --
// isi dengan zona waktu LOKASI KERJA KARYAWAN yang bersangkutan (bukan
// device/HP-nya) supaya telat/tidaknya, tanggal "hari ini", dst dihitung
// sesuai jam setempat cabang itu. Kalau tz tidak diisi/tidak dikenali,
// jatuh ke APP_TIMEZONE di bawah sebagai default (dipakai juga utk hal
// yang company-wide & tidak terikat ke satu cabang tertentu, misal siklus
// tanggal gajian, atau lokasi kerja karyawan yang belum diisi timezone-nya
// sama sekali). Indonesia tidak menerapkan DST, jadi offset tiap zona di
// bawah selalu tetap sepanjang tahun — aman dihardcode berpasangan dengan
// nama zonanya.
export const TIMEZONE_OPTIONS = [
  { value: "Asia/Jakarta", label: "WIB", offset: 7 },
  { value: "Asia/Makassar", label: "WITA", offset: 8 },
  { value: "Asia/Jayapura", label: "WIT", offset: 9 },
];
export const APP_TIMEZONE = "Asia/Jakarta"; // default/fallback: WIB (kantor pusat Surabaya)
export const APP_TIMEZONE_OFFSET_HOURS = 7;  // WIB = UTC+7

function tzOffsetHours(tz) {
  return TIMEZONE_OPTIONS.find(t => t.value === tz)?.offset ?? APP_TIMEZONE_OFFSET_HOURS;
}

function zonedParts(d = new Date(), tz = APP_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || APP_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const p = {};
  fmt.formatToParts(d).forEach(x => { if (x.type !== "literal") p[x.type] = x.value; });
  return p; // { year, month, day, hour, minute, second }
}

// Tanggal "hari ini" (atau tanggal dari Date apa pun) menurut zona kantor,
// format YYYY-MM-DD. Pengganti toISOString().slice(0,10)/getFullYear() dkk
// yang keduanya salah kalau dipakai untuk ini (lihat catatan di atas).
export function dateOnlyISO(d = new Date(), tz) {
  const p = zonedParts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function todayISO(tz) {
  return dateOnlyISO(new Date(), tz);
}

// Hari dalam minggu (0=Minggu..6=Sabtu) dari tanggal kalender "YYYY-MM-DD".
// Murni dari angka Y/M/D, sama sekali tidak menyentuh timezone apa pun —
// jadi selalu benar untuk tanggal kalender (mis. dari <input type="date">).
export function dayOfWeekFromDateStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Hari dalam minggu (0=Minggu..6=Sabtu) dari sebuah instant/waktu (Date),
// menurut zona kantor. Pengganti Date#getDay(), yang memakai timezone
// perangkat. Untuk tanggal kalender murni (string "YYYY-MM-DD" tanpa jam),
// pakai dayOfWeekFromDateStr di atas.
export function zonedDayOfWeek(d = new Date(), tz) {
  const p = zonedParts(d, tz);
  return dayOfWeekFromDateStr(`${p.year}-${p.month}-${p.day}`);
}

// Jam:menit (menurut zona kantor) dari sebuah instant/waktu (Date/timestamptz).
// Dipakai untuk aturan yang bergantung ke JAM ABSOLUT karyawan absen (misal
// tabel potongan telat/pulang cepat berbasis jam pasti seperti "> 08:00"),
// beda dengan status telat/tidaknya jadwal kerja yang sudah dihitung terpisah.
export function zonedMinutesOfDay(d, tz) {
  const p = zonedParts(new Date(d), tz);
  return Number(p.hour) * 60 + Number(p.minute);
}

// Ubah "HH:MM" jadi jumlah menit sejak 00:00, untuk dibandingkan dengan
// zonedMinutesOfDay().
export function hmToMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

// Bangun timestamp (epoch ms, absolut & timezone-agnostic) untuk jam HH:MM
// pada tanggal "YYYY-MM-DD" tertentu, DIUKUR menurut zona kantor. Dipakai
// untuk membandingkan "jam mulai shift kantor" dengan waktu absen karyawan,
// supaya hasilnya konsisten di HP mana pun / timezone device apa pun.
export function zonedTimestamp(dateStr, hh, mm, ss = 0, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh - tzOffsetHours(tz), mm, ss);
}

// Waktu sekarang, sudah diformat sesuai zona kantor (untuk ditampilkan).
export function fmtNowInOfficeZone(tz) {
  return new Date().toLocaleString("id-ID", { timeZone: tz || APP_TIMEZONE, dateStyle: "full", timeStyle: "short" });
}

export function fmtRupiah(n) {
  if (n === null || n === undefined || n === "") return "-";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

// =====================================================================
// PEMBULATAN JAM LEMBUR
// < 25 menit  -> turun ke jam penuh
// 25-54 menit -> naik ke X,5 jam
// >= 55 menit -> naik ke jam penuh berikutnya
// =====================================================================
export function roundOvertimeHours(startTime, endTime) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let startMinutes = sh * 60 + sm;
  let endMinutes = eh * 60 + em;
  if (endMinutes <= startMinutes) endMinutes += 24 * 60; // jaga-jaga kalau lintas hari
  const totalMinutes = endMinutes - startMinutes;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mins < 25) return hours;
  if (mins < 55) return hours + 0.5;
  return hours + 1;
}

export function fmtJam(n) {
  if (n === null || n === undefined) return "-";
  const str = Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
  return `${str} jam`;
}

// =====================================================================
// DIALOG KONFIRMASI generik (dipakai sebelum aksi penting seperti
// Setuju/Tolak pengajuan). Return true kalau user klik konfirmasi.
// =====================================================================
export function confirmDialog({ title, message, confirmLabel = "Ya", confirmClass = "btn-primary" }) {
  return new Promise(resolve => {
    let modal = document.getElementById("global-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "global-confirm-modal";
      modal.className = "modal hidden";
      modal.innerHTML = `
        <div class="modal-box">
          <h3 id="confirm-title"></h3>
          <p id="confirm-message" class="muted" style="white-space:pre-line; margin-top:8px;"></p>
          <div class="modal-actions">
            <button type="button" id="confirm-cancel" class="btn-secondary">Batal</button>
            <button type="button" id="confirm-ok" class="btn-primary">Ya</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    modal.querySelector("#confirm-title").textContent = title;
    modal.querySelector("#confirm-message").textContent = message;
    const okBtn = modal.querySelector("#confirm-ok");
    const cancelBtn = modal.querySelector("#confirm-cancel");
    okBtn.textContent = confirmLabel;
    okBtn.className = confirmClass;
    modal.classList.remove("hidden");

    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// =====================================================================
// TOGGLE LIHAT PASSWORD (tombol mata)
// =====================================================================
export function wirePasswordToggles(root = document) {
  root.querySelectorAll(".btn-toggle-pw").forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.querySelector(".icon-eye").classList.toggle("hidden");
      btn.querySelector(".icon-eye-off").classList.toggle("hidden");
    });
  });
}

export function passwordToggleBtnHtml(targetId) {
  return `
    <button type="button" class="btn-toggle-pw" data-target="${targetId}" aria-label="Tampilkan/sembunyikan password">
      <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg class="icon-eye-off hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a21.86 21.86 0 015.06-6.06M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 8 11 8a21.86 21.86 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24M1 1l22 22"/></svg>
    </button>
  `;
}

// =====================================================================
// SEARCH SELECT — dropdown dengan pencarian (menggantikan <select> biasa
// untuk pilihan yang datanya banyak/berasal dari master data)
// =====================================================================
export function searchSelectHtml({ id, label, placeholder = "Ketik untuk cari…", required = false, hint = "" }) {
  return `
    <div class="search-select" data-ss-id="${id}">
      <label for="${id}-input">${label}</label>
      <input type="text" id="${id}-input" autocomplete="off" placeholder="${placeholder}" ${required ? "required" : ""}>
      <input type="hidden" id="${id}-value">
      <div class="search-select-list hidden" id="${id}-list"></div>
      ${hint ? `<span class="small muted">${hint}</span>` : ""}
    </div>
  `;
}

// options: array apa saja. getLabel/getValue: cara membaca teks & nilainya.
export function wireSearchSelect(id, options, { getLabel = o => String(o), getValue = o => String(o), onSelect } = {}) {
  const input = document.getElementById(`${id}-input`);
  const hidden = document.getElementById(`${id}-value`);
  const list = document.getElementById(`${id}-list`);
  if (!input) return null;

  function renderList(filter = "") {
    const f = filter.toLowerCase();
    const filtered = options.filter(o => getLabel(o).toLowerCase().includes(f));
    list.innerHTML = filtered.length
      ? filtered.map(o => `<div class="search-option" data-value="${escapeAttr(getValue(o))}">${getLabel(o)}</div>`).join("")
      : `<div class="search-option muted">Tidak ada hasil — cek Master Data</div>`;
    list.classList.remove("hidden");
  }

  input.addEventListener("focus", () => renderList(input.value));
  input.addEventListener("input", () => { hidden.value = ""; renderList(input.value); });
  list.addEventListener("mousedown", e => {
    const opt = e.target.closest(".search-option");
    if (!opt || opt.dataset.value === undefined) return;
    const o = options.find(x => getValue(x) === opt.dataset.value);
    if (!o) return;
    input.value = getLabel(o);
    hidden.value = getValue(o);
    list.classList.add("hidden");
    if (onSelect) onSelect(o);
  });
  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !list.contains(e.target)) list.classList.add("hidden");
  });

  const controller = {
    setValue(value, labelText) { input.value = labelText ?? value ?? ""; hidden.value = value ?? ""; },
    clear() { input.value = ""; hidden.value = ""; },
    setOptions(newOptions) { options = newOptions; },
    get value() { return hidden.value; },
  };
  return controller;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// Hitung "lama bekerja" dari tanggal masuk ke hari ini, format "X tahun Y bulan"
export function lamaBekerja(joinDateStr) {
  if (!joinDateStr) return "-";
  const start = new Date(joinDateStr);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months--;
  if (months < 0) return "-";
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (years === 0 && remMonths === 0) return "Baru bergabung";
  const parts = [];
  if (years > 0) parts.push(`${years} tahun`);
  if (remMonths > 0) parts.push(`${remMonths} bulan`);
  return parts.join(" ");
}

// CSV export helper
export function exportCSV(filename, rows) {
  if (!rows.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map(r => headers.map(h => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Export Excel (.xlsx) asli lewat SheetJS (dimuat via <script> di app.html)
export function exportXLSX(filename, rows, sheetName = "Data") {
  if (!rows.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  if (typeof XLSX === "undefined") {
    toast("Gagal export: library Excel belum termuat, coba refresh halaman.", "error");
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}
