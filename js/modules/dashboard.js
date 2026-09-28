import { supabase } from "../supabaseClient.js";
import { fmtTime, fmtDate, todayISO, roleLabel, resolveMenu, ICONS, resolveUserTimezone, tzLabel } from "../core.js";
import { loadAttendanceState, cameraModalHtml, openCamera, reminderBannerHTML, goToKoreksiCheckout, onLeaveLabel } from "./employee-absensi.js";
import { countPendingForMe } from "../approvalHelper.js";

// Menu personal yang sudah punya kartu ringkasannya sendiri di dashboard —
// tidak perlu diulang lagi di grid "Menu Lainnya" di bawah.
const HANDLED_IN_SUMMARY = new Set(["dashboard", "absensi", "izin", "lembur"]);

// Ikon kecil untuk kartu ringkasan Dashboard.
const DASH_SVG = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const DASH_ICONS = {
  login: DASH_SVG('<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/>'),
  logout: DASH_SVG('<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>'),
  file: DASH_SVG('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>'),
  check: DASH_SVG('<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>'),
  alert: DASH_SVG('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>'),
  chevron: DASH_SVG('<path d="M9 18l6-6-6-6"/>'),
};

export async function render(container, user) {
  const tz = await resolveUserTimezone(user); // zona waktu lokasi kerja karyawan, bukan WIB/device yang di-hardcode

  container.innerHTML = `
    <div class="dash-hero">
      <div>
        <div class="dash-eyebrow">${greeting(tz)}</div>
        <h1 class="dash-title">${escapeHtml(user.full_name || "Pengguna")}</h1>
        <div class="dash-role">
          <span class="badge badge-ok">${roleLabel(user.role)}</span>
          ${user.department ? `<span class="muted small">${escapeHtml(user.department)}${user.position ? " • " + escapeHtml(user.position) : ""}</span>` : ""}
        </div>
      </div>
      <div class="dash-clock-wrap">
        <div class="muted small" id="dash-date">${fmtNowDate(tz)}</div>
        <div class="live-clock" id="dash-live-clock">--:--:--</div>
      </div>
    </div>

    <div id="dash-reminder-banner"></div>

    <div class="dash-stats" id="dash-personal-stats">
      ${skeletonCards(3)}
    </div>

    <div id="dash-org-section" class="hidden">
      <h2 class="dash-section-title">Ringkasan Perusahaan Hari Ini</h2>
      <div class="dash-stats" id="dash-org-stats"></div>
    </div>

    <div id="dash-activity-section" class="hidden">
      <h2 class="dash-section-title">Aktivitas Absensi Terbaru</h2>
      <div id="dash-activity" class="table-wrap dash-panel"><p class="muted">Memuat…</p></div>
    </div>

    <h2 class="dash-section-title">Akses Cepat</h2>
    <div class="quick-links-grid" id="dash-quick-links"><p class="muted">Memuat menu…</p></div>

    ${cameraModalHtml()}
  `;

  startClock(tz);
  loadQuickLinks(user);
  loadPersonalStats(user, tz);
  loadOrgStats(user);
}

// =====================================================================
// JAM & TANGGAL — mengikuti zona waktu LOKASI KERJA karyawan (tz, lihat
// resolveUserTimezone di core.js), bukan jam device/HP-nya ataupun WIB
// yang di-hardcode, supaya konsisten dengan yang ditampilkan di halaman
// Absensi.
// =====================================================================
let clockInterval = null;
function startClock(tz) {
  if (clockInterval) clearInterval(clockInterval);
  const label = tzLabel(tz);
  function tick() {
    const el = document.getElementById("dash-live-clock");
    if (!el) { clearInterval(clockInterval); clockInterval = null; return; }
    el.textContent = new Date().toLocaleTimeString("id-ID", { timeZone: tz || undefined, hour12: false }) + " " + label;
  }
  tick();
  clockInterval = setInterval(tick, 1000);
}

function fmtNowDate(tz) {
  return new Date().toLocaleDateString("id-ID", { timeZone: tz || undefined, weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function greeting(tz) {
  const hour = Number(new Date().toLocaleString("id-ID", { timeZone: tz || undefined, hour: "2-digit", hour12: false }));
  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 18) return "Selamat sore";
  return "Selamat malam";
}

// =====================================================================
// KARTU RINGKASAN PRIBADI — status absensi hari ini + pengajuan pending milik sendiri
// =====================================================================
async function loadPersonalStats(user, tz) {
  const today = todayISO(tz);
  // Status absen memakai fungsi yang SAMA dengan halaman Absensi (termasuk
  // shift lintas hari & sesi lama yang lupa check-out), jadi Dashboard dan
  // halaman Absensi tidak pernah menampilkan status yang berbeda.
  const [state, allowedMenu, { count: izinPending }, { count: lemburPending }] = await Promise.all([
    loadAttendanceState(user, tz),
    resolveMenu(user).then(menu => new Set(menu.map(m => m.id))),
    supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "pending"),
    supabase.from("overtime_requests").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "pending"),
  ]);

  const el = document.getElementById("dash-personal-stats");
  if (!el) return;

  // Banner "lupa check-out" — muncul lagi setiap Dashboard dibuka (halaman
  // yang pertama dilihat karyawan tiap login) selama belum ditindaklanjuti,
  // supaya tidak cuma mengandalkan notifikasi push yang bisa diabaikan.
  // Lihat reminderBannerHTML() di employee-absensi.js untuk detailnya.
  const bannerEl = document.getElementById("dash-reminder-banner");
  if (bannerEl) {
    bannerEl.innerHTML = state.staleOpen ? reminderBannerHTML(state.staleRow) : "";
    bannerEl.querySelector("#btn-koreksi-checkout")?.addEventListener("click", () => goToKoreksiCheckout(state.staleRow));
  }

  const att = state.activeRow;
  // Tombol absen hanya untuk yang menu "Absensi"-nya diizinkan (di server,
  // insert absensi juga ditolak kalau menu itu mati — jadi tombolnya
  // sekalian tidak ditampilkan). Kalau karyawan sedang izin/cuti/sakit untuk
  // hari ini, baik yang sudah disetujui MAUPUN yang masih menunggu
  // (state.onLeaveToday), tombol absen juga disembunyikan — lihat catatan
  // di loadAttendanceState() untuk alasannya.
  const canAbsen = allowedMenu.has("absensi") && !state.onLeaveToday;
  const canCheckIn = canAbsen && !state.openShift && !state.completedToday;
  const canCheckOut = canAbsen && state.openShift;
  const leaveLabel = state.onLeaveToday ? await onLeaveLabel(state.onLeaveToday) : null;
  // Sesi yang dimulai bukan hari ini (shift lintas hari) diberi keterangan tanggalnya.
  const otherDay = att && att.date !== today ? `<span class="muted small">Sesi ${fmtDate(att.date)}</span>` : "";

  const inVal = att?.check_in ? fmtTime(att.check_in) : "";
  const outVal = att?.check_out ? fmtTime(att.check_out) : "";
  const pendingTotal = (izinPending || 0) + (lemburPending || 0);
  const leaveBadge = leaveLabel ? `<span class="badge badge-warn">${leaveLabel}</span>` : "";

  el.innerHTML = `
    <div class="dash-stat ${inVal ? "ok" : ""}">
      <div class="dash-stat-top"><span class="dash-stat-icon">${DASH_ICONS.login}</span><span class="dash-stat-label">Check-in Hari Ini</span></div>
      <div class="dash-stat-value ${inVal ? "" : "empty"}">${inVal || "--.--"}</div>
      <div class="dash-stat-meta">
        ${att?.check_in_status
          ? `<span class="badge badge-${att.check_in_status === "telat" ? "warn" : "ok"}">${att.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>`
          : leaveBadge || `<span>Belum check-in</span>`}
        ${otherDay}
      </div>
      ${state.misdatedTail ? `<div class="dash-stat-note">ℹ️ ${fmtTime(state.latest.check_in)}–${fmtTime(state.latest.check_out)} tadi = sisa shift semalam.</div>` : ""}
      ${leaveLabel ? `<div class="dash-stat-note">🗓️ ${fmtDate(state.onLeaveToday.start_date)} – ${fmtDate(state.onLeaveToday.end_date)}</div>` : ""}
      ${canCheckIn ? `<button type="button" class="btn-primary btn-card-action" data-mode="in">Check-in Sekarang</button>` : ""}
    </div>
    <div class="dash-stat ${outVal ? "ok" : ""}">
      <div class="dash-stat-top"><span class="dash-stat-icon">${DASH_ICONS.logout}</span><span class="dash-stat-label">Check-out Hari Ini</span></div>
      <div class="dash-stat-value ${outVal ? "" : "empty"}">${outVal || "--.--"}</div>
      <div class="dash-stat-meta">
        ${outVal ? `<span class="badge badge-ok">Tercatat</span>` : leaveBadge || `<span>Belum check-out</span>`}
      </div>
      ${canCheckOut ? `<button type="button" class="btn-primary btn-card-action" data-mode="out">Check-out Sekarang</button>` : ""}
    </div>
    <div class="dash-stat ${pendingTotal ? "warn" : ""}">
      <div class="dash-stat-top"><span class="dash-stat-icon">${DASH_ICONS.file}</span><span class="dash-stat-label">Pengajuan Pending</span></div>
      <div class="dash-stat-value ${pendingTotal ? "" : "empty"}">${pendingTotal}</div>
      <div class="dash-stat-meta"><span>${izinPending || 0} izin/cuti • ${lemburPending || 0} lembur</span></div>
    </div>
  `;

  // Alur absen (GPS + selfie + penentuan telat) memakai kode yang sama
  // dengan halaman Absensi. Setelah berhasil, Dashboard dimuat ulang supaya
  // kartu di atas dan ringkasan perusahaan langsung ikut ter-update.
  el.querySelectorAll(".btn-card-action").forEach(btn => {
    btn.addEventListener("click", () => {
      openCamera(btn.dataset.mode, user, state.activeRow, tz, () => render(document.getElementById("content"), user));
    });
  });
}

// =====================================================================
// KARTU RINGKASAN PERUSAHAAN — cuma dihitung/ditampilkan untuk bagian yang
// memang diizinkan buat user ini (lewat allowedTabIds), supaya tidak query
// tabel yang RLS-nya bakal menolak dia.
// =====================================================================
async function loadOrgStats(user) {
  const allowed = await resolveMenu(user).then(menu => new Set(menu.map(m => m.id)));
  const canKaryawan = allowed.has("karyawan");
  const canAbsensi = allowed.has("absensi-monitor");
  const canIzin = allowed.has("izin-approval");
  const canLembur = allowed.has("lembur-approval");
  const canKoreksi = allowed.has("koreksi-approval");

  if (!canKaryawan && !canAbsensi && !canIzin && !canLembur && !canKoreksi) return; // pure karyawan — tidak ada bagian ini

  const today = todayISO();
  const cards = [];

  try {
    if (canKaryawan) {
      const { count: totalKaryawan } = await supabase.from("profiles").select("id", { count: "exact", head: true }).eq("is_active", true);
      cards.push({ label: "Total Karyawan Aktif", value: totalKaryawan ?? "-" });
    }
    if (canAbsensi) {
      const { data: attToday } = await supabase.from("attendance").select("check_in, check_in_status").eq("date", today);
      const hadir = (attToday || []).filter(a => a.check_in).length;
      const telat = (attToday || []).filter(a => a.check_in_status === "telat").length;
      cards.push({ label: "Hadir Hari Ini", value: hadir, tone: "ok" });
      cards.push({ label: "Telat Hari Ini", value: telat, tone: telat > 0 ? "warn" : "ok" });

      // Sesi lama (bukan hari ini) yang sudah check-in tapi belum check-out —
      // biasanya karyawan lupa absen pulang. Dihitung terpisah dari "Hadir
      // Hari Ini" supaya admin langsung sadar tanpa harus buka Monitor
      // Absensi dan gonta-ganti tanggal satu-satu.
      const { count: lupaCheckout } = await supabase
        .from("attendance")
        .select("id", { count: "exact", head: true })
        .is("check_out", null)
        .lt("date", today);
      cards.push({ label: "Lupa Check-out (Sesi Lama)", value: lupaCheckout || 0, tone: lupaCheckout ? "warn" : "ok", target: "absensi-monitor" });
    }
    if (canIzin) {
      const izinPending = await countPendingForMe("leave", user);
      cards.push({ label: "Izin/Cuti Menunggu Approvalmu", value: izinPending ?? 0, tone: izinPending ? "warn" : "ok", target: "izin-approval" });
    }
    if (canLembur) {
      const lemburPending = await countPendingForMe("overtime", user);
      cards.push({ label: "Lembur Menunggu Approvalmu", value: lemburPending ?? 0, tone: lemburPending ? "warn" : "ok", target: "lembur-approval" });
    }
    if (canKoreksi) {
      const koreksiPending = await countPendingForMe("koreksi", user);
      cards.push({ label: "Koreksi Absen Menunggu Approvalmu", value: koreksiPending ?? 0, tone: koreksiPending ? "warn" : "ok", target: "koreksi-approval" });
    }
  } catch (e) {
    // RLS/permission edge-case — diam saja, jangan sampai dashboard error total.
  }

  const section = document.getElementById("dash-org-section");
  const el = document.getElementById("dash-org-stats");
  if (!el || !cards.length) return;
  section.classList.remove("hidden");
  el.innerHTML = cards.map(c => `
    <div class="dash-stat ${c.tone === "ok" ? "ok" : c.tone === "warn" ? "warn" : ""} ${c.target ? "dash-stat-link" : ""}" ${c.target ? `data-target="${c.target}"` : ""}>
      <div class="dash-stat-top">
        <span class="dash-stat-icon">${c.tone === "warn" ? DASH_ICONS.alert : DASH_ICONS.check}</span>
        <span class="dash-stat-label">${c.label}</span>
        ${c.target ? `<span class="dash-stat-chevron">${DASH_ICONS.chevron}</span>` : ""}
      </div>
      <div class="dash-stat-value">${c.value}</div>
    </div>
  `).join("");
  el.querySelectorAll(".dash-stat-link").forEach(card => {
    card.addEventListener("click", () => goTo(card.dataset.target));
  });

  if (canAbsensi) loadRecentActivity();
}

// =====================================================================
// AKTIVITAS TERBARU — 6 check-in terakhir hari ini (khusus yang punya akses Monitor Absensi)
// =====================================================================
async function loadRecentActivity() {
  const today = todayISO();
  const { data, error } = await supabase
    .from("attendance")
    .select("check_in, check_in_status, check_out, profiles(full_name, department)")
    .eq("date", today)
    .not("check_in", "is", null)
    .order("check_in", { ascending: false })
    .limit(6);

  const section = document.getElementById("dash-activity-section");
  const el = document.getElementById("dash-activity");
  if (!el) return;
  if (error || !data || !data.length) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Departemen</th><th>Check-in</th><th>Status</th><th>Check-out</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${escapeHtml(r.profiles?.full_name || "-")}</td>
            <td>${escapeHtml(r.profiles?.department || "-")}</td>
            <td>${fmtTime(r.check_in)}</td>
            <td>${r.check_in_status ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : "-"}</td>
            <td>${r.check_out ? fmtTime(r.check_out) : `<span class="muted">Belum</span>`}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// =====================================================================
// GRID MENU CEPAT — semua menu yang boleh dibuka user ini, dikelompokkan
// per section sidebar, supaya dashboard juga berfungsi sebagai "peta" menu.
// =====================================================================
async function loadQuickLinks(user) {
  const menu = await resolveMenu(user);
  const el = document.getElementById("dash-quick-links");
  if (!el) return;
  const items = menu.filter(m => !HANDLED_IN_SUMMARY.has(m.id));
  if (!items.length) { el.innerHTML = `<p class="muted">Tidak ada menu lain.</p>`; return; }

  el.innerHTML = items.map(m => `
    <button type="button" class="quick-link-card" data-target="${m.id}">
      <span class="quick-link-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[m.icon] || ICONS.file}"/></svg>
      </span>
      <span class="quick-link-text">
        <span class="quick-link-label">${escapeHtml(m.label)}</span>
        <span class="quick-link-section">${escapeHtml(m.section || "")}</span>
      </span>
    </button>
  `).join("");

  el.querySelectorAll(".quick-link-card").forEach(card => {
    card.addEventListener("click", () => goTo(card.dataset.target));
  });
}

function goTo(tabId) {
  if (!tabId) return;
  document.querySelector(`.nav-item[data-target="${tabId}"]`)?.click();
}

function skeletonCards(n) {
  return Array.from({ length: n }).map(() => `
    <div class="dash-stat"><div class="dash-stat-top"><span class="dash-stat-icon"></span><span class="dash-stat-label">&nbsp;</span></div><div class="dash-stat-value empty">--</div></div>
  `).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
