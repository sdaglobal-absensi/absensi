    import { requireAuth, logout } from "../auth.js";
    import { escapeHtml, renderSidebar, toast, ICONS, isMenuBlockedByPlan, planInfoSync, fmtDate } from "../core.js";
    import { initNotifications } from "../notifications.js";
import { ensurePrivacyConsent } from "../privacy.js";
import { initErrorReporter } from "../errorReporter.js";

initErrorReporter();

    const MODULE_MAP = {
      "dashboard": () => import("../modules/dashboard.js"),
      "absensi": () => import("../modules/employee-absensi.js"),
      "izin": () => import("../modules/employee-izin.js"),
      "lembur": () => import("../modules/employee-lembur.js"),
      "koreksi": () => import("../modules/employee-koreksi-absen.js"),
      "riwayat": () => import("../modules/employee-riwayat.js"),
      "slip-gaji-saya": () => import("../modules/employee-slip-gaji.js"),
      "profil": () => import("../modules/employee-profil.js"),
      "pengumuman": () => import("../modules/employee-pengumuman.js"),
      "dinas-luar": () => import("../modules/employee-dinas-luar.js"),
      "dinas-luar-approval": () => import("../modules/admin-dinas-luar.js"),
      "kasbon": () => import("../modules/employee-kasbon.js"),
      "kasbon-approval": () => import("../modules/admin-kasbon.js"),
      "reimburse": () => import("../modules/employee-reimburse.js"),
      "reimburse-approval": () => import("../modules/admin-reimburse.js"),
      "dokumen": () => import("../modules/employee-dokumen.js"),
      "dokumen-kelola": () => import("../modules/admin-dokumen.js"),
      "onboarding-kelola": () => import("../modules/admin-onboarding.js"),
      "kpi-saya": () => import("../modules/employee-kpi.js"),
      "kpi-kelola": () => import("../modules/admin-kpi.js"),
      "kpi-nilai": () => import("../modules/admin-kpi-nilai.js"),
      "tukar-shift": () => import("../modules/employee-tukar-shift.js"),
      "tukar-shift-approval": () => import("../modules/admin-tukar-shift.js"),
      "pengumuman-kelola": () => import("../modules/admin-pengumuman.js"),
      "karyawan": () => import("../modules/admin-karyawan.js"),
      "struktur-organisasi": () => import("../modules/admin-struktur-organisasi.js"),
      "analitik-hr": () => import("../modules/admin-analitik.js"),
      "absensi-monitor": () => import("../modules/admin-absensi.js"),
      "izin-approval": () => import("../modules/admin-izin.js"),
      "lembur-approval": () => import("../modules/admin-lembur.js"),
      "koreksi-approval": () => import("../modules/admin-koreksi-absen.js"),
      "profil-approval": () => import("../modules/admin-profil-approval.js"),
      "kenaikan-upah": () => import("../modules/admin-kenaikan-upah.js"),
      "slip-gaji": () => import("../modules/admin-slip-gaji.js"),
      "invoice-outsourcing": () => import("../modules/admin-invoice-outsourcing.js"),
      "laporan": () => import("../modules/admin-laporan.js"),
      "master-level": () => import("../modules/admin-master-level.js"),
      "master-tunjangan": () => import("../modules/admin-master-tunjangan.js"),
      "master-denda": () => import("../modules/admin-master-denda.js"),
      "master-departemen": () => import("../modules/admin-master-departemen.js"),
      "master-pt": () => import("../modules/admin-master-pt.js"),
      "master-jadwal": () => import("../modules/admin-master-jadwal.js"),
      "master-libur": () => import("../modules/admin-master-libur.js"),
      "master-lokasi": () => import("../modules/admin-master-lokasi.js"),
      "kuota-cuti": () => import("../modules/admin-kuota-cuti.js"),
      "audit-log": () => import("../modules/admin-audit-log.js"),
      "ekspor-backup": () => import("../modules/admin-ekspor-backup.js"),
      "paket": () => import("../modules/super-paket.js"),
      "platform": () => import("../modules/platform-admin.js"),
      "pengaturan-sistem": () => import("../modules/super-pengaturan.js"),
    };

    let currentUser = null;
    let allowedTabIds = null; // Set berisi tabId yang boleh dibuka user ini. Sejak Tahap 4 SELALU berisi (juga untuk super_admin), karena menu di luar paket usaha tidak boleh dibuka siapa pun.

    function isTabAllowed(tabId) {
      if (!MODULE_MAP[tabId]) return false;
      if (!allowedTabIds) return true; // super_admin — All Akses, tidak difilter
      return allowedTabIds.has(tabId);
    }

    let menuLabels = {};
    const TAB_ORDER = [
      { id: "dashboard", label: "Beranda", icon: "home" },
      { id: "izin", label: "Izin", icon: "file" },
      { id: "absensi", label: "Absen", icon: "clock", primary: true },
      { id: "riwayat", label: "Riwayat", icon: "history" },
    ];
    let tabbarIds = [];

    function buildTabbar(menu) {
      const ids = new Set(menu.map(m => m.id));
      const tabs = TAB_ORDER.filter(t => ids.has(t.id));
      tabbarIds = tabs.map(t => t.id);
      const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${p}"/></svg>`;
      const html = tabs.map(t => `
        <button class="tab-item ${t.primary ? "tab-primary" : ""}" data-tab="${t.id}">
          <span class="tab-icon">${svg(ICONS[t.icon])}</span><span class="tab-label">${t.label}</span>
        </button>`).join("") + `
        <button class="tab-item" data-tab="__menu">
          <span class="tab-icon">${svg(ICONS.grid)}</span><span class="tab-label">Menu</span>
        </button>`;
      document.getElementById("tabbar").innerHTML = html;
    }

    function updateTabbarActive(tabId) {
      const inBar = tabbarIds.includes(tabId);
      document.querySelectorAll("#tabbar .tab-item").forEach(b => {
        const t = b.dataset.tab;
        b.classList.toggle("active", t === tabId || (t === "__menu" && !inBar));
      });
      const title = document.getElementById("mobile-title");
      if (title) title.textContent = tabId === "dashboard" ? "KERJORA" : (menuLabels[tabId] || "KERJORA");
    }

    let currentTabId = null;

    // Tahap 5 — banner masa aktif untuk Pemilik: muncul saat sisa waktu paket
    // atau trial <= 7 hari, atau paket baru saja habis (14 hari terakhir).
    function renderPlanBanner() {
      const el = document.getElementById("plan-banner");
      const info = planInfoSync();
      el.className = "hidden";
      if (!info || !info.is_owner || info.plan === "internal") return;
      const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      let tone = "", text = "", label = "Perpanjang";
      const d = info.days_left;
      if (d !== null && d !== undefined && d <= 7) {
        const nm = esc(info.plan_nama || info.plan);
        const trial = info.status === "trial";
        tone = d <= 2 ? "danger" : "warn";
        text = d <= 0
          ? `${trial ? "Masa percobaan" : "Paket " + nm} berakhir hari ini.`
          : `${trial ? "Masa percobaan paket " + nm : "Paket " + nm} berakhir ${d} hari lagi (${esc(fmtDate(info.plan_expires_at || info.trial_ends_at))}).`;
      } else if (info.recently_expired) {
        const from = esc(info.recently_expired.from_plan || "berbayar");
        tone = "danger";
        label = "Aktifkan lagi";
        text = `Masa aktif paket ${from} sudah habis, usahamu kembali ke paket Gratis. Fitur berbayar terkunci, datanya tetap aman.`;
      } else return;
      el.className = `plan-banner plan-banner-${tone}`;
      el.innerHTML = `<span>${text}</span><button type="button" class="btn-primary btn-sm" id="plan-banner-btn">${label}</button>`;
      document.getElementById("plan-banner-btn").addEventListener("click", () => loadTab("paket"));
    }

    async function loadTab(tabId, { silent = false } = {}) {
      if (!isTabAllowed(tabId)) {
        document.getElementById("content").innerHTML = isMenuBlockedByPlan(tabId)
          ? `<p class="muted">Fitur ini tidak termasuk paket usahamu. Lihat menu <b>Paket &amp; Fitur</b> untuk fitur yang tersedia.</p>`
          : `<p class="muted">Kamu tidak punya akses ke halaman ini. Hubungi Super Admin / Super Admin HR kalau merasa ini seharusnya bisa diakses.</p>`;
        return;
      }
      const loader = MODULE_MAP[tabId];
      const contentEl = document.getElementById("content");
      currentTabId = tabId;
      if (!silent) {
        contentEl.innerHTML = `<div class="skeleton-page"><div class="skeleton sk-title"></div><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div></div>`;
        window.scrollTo(0, 0);
      }
      try {
        const mod = await loader();
        document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.target === tabId));
        updateTabbarActive(tabId);
        await mod.render(contentEl, currentUser);
        contentEl.classList.remove("page-enter");
        void contentEl.offsetWidth; // restart animasi
        contentEl.classList.add("page-enter");
        history.replaceState(null, "", `#${tabId}`);
      } catch (err) {
        console.error("Gagal memuat halaman:", err);
        document.getElementById("content").innerHTML =
          `<p class="muted">Terjadi kesalahan saat memuat halaman ini: ${escapeHtml(err.message)}. Coba refresh, atau cek console browser (F12) untuk detail.</p>`;
      }
    }

    (async function init() {
      try {
        currentUser = await requireAuth(["super_admin", "super_admin_hr", "admin_hr", "admin_approval", "karyawan"]);
      } catch (err) {
        console.error("Gagal memeriksa sesi:", err);
        document.getElementById("content").innerHTML =
          `<p class="muted">Gagal memeriksa sesi login: ${escapeHtml(err.message)}</p>`;
        return;
      }
      if (!currentUser) return;
      await ensurePrivacyConsent(); // UU PDP: wajib setuju kebijakan privasi versi aktif

      if (new URLSearchParams(location.search).get("reason") === "forbidden") {
        toast("Kamu tidak punya akses ke halaman itu.", "error");
        history.replaceState(null, "", "app.html");
      }

      const menu = await renderSidebar(currentUser, null); // activeId diisi ulang di loadTab lewat startTab
      // Semua role dibatasi ke menu yang benar-benar muncul di sidebar-nya,
      // hasil dari resolveMenu(): toggle Pengaturan Sistem per role (kecuali
      // super_admin yang tidak difilter toggle) DAN paket usaha (Tahap 4,
      // berlaku untuk super_admin juga).
      allowedTabIds = new Set(menu.map(m => m.id));
      menuLabels = Object.fromEntries(menu.map(m => [m.id, m.label]));
      buildTabbar(menu);
      renderPlanBanner();

      const fallbackTab = "dashboard";
      const hashTab = location.hash.replace("#", "");
      const startTab = hashTab && isTabAllowed(hashTab) ? hashTab : fallbackTab;

      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebar-backdrop");
      function closeMobileMenu() {
        sidebar.classList.remove("mobile-open");
        backdrop.classList.remove("show");
      }
      document.getElementById("btn-hamburger").addEventListener("click", () => {
        sidebar.classList.add("mobile-open");
        backdrop.classList.add("show");
      });
      backdrop.addEventListener("click", closeMobileMenu);

      document.getElementById("tabbar").addEventListener("click", e => {
        const btn = e.target.closest(".tab-item");
        if (!btn) return;
        if (navigator.vibrate) navigator.vibrate(8); // getar halus (Android)
        if (btn.dataset.tab === "__menu") {
          sidebar.classList.add("mobile-open");
          backdrop.classList.add("show");
        } else {
          loadTab(btn.dataset.tab);
        }
      });

      document.getElementById("sidebar-nav").addEventListener("click", e => {
        const btn = e.target.closest(".nav-item");
        if (btn) {
          loadTab(btn.dataset.target);
          closeMobileMenu(); // tutup drawer di HP begitu satu menu dipilih
        }
      });
      document.getElementById("btn-logout").addEventListener("click", logout);

      window.addEventListener("kerjora:navigate", e => {
        if (e.detail?.tab) loadTab(e.detail.tab);
      });
      // Notifikasi baru masuk (realtime) -> segarkan halaman baca-saja yang sedang
      // terbuka, supaya mis. banner "belum check-out" hilang setelah koreksi disetujui.
      // Halaman berisi formulir sengaja tidak disentuh agar isian tidak hilang.
      window.addEventListener("kerjora:notification", e => {
        if (e.detail?.type === "approval_decided" && ["dashboard", "riwayat"].includes(currentTabId)) {
          loadTab(currentTabId, { silent: true });
        }
      });
      initNotifications(currentUser);

      loadTab(startTab);
    })();
  
