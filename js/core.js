/* ======================================================================
   CORE — mesin inti aplikasi.
   Modul (file di js/modules/*.js) mendaftar ke sini lewat App.registerModule().
   JANGAN tambahkan logika menu baru di file ini — buat file modul baru saja.
   ====================================================================== */
window.App = (function () {
  const modules = [];      // semua modul terdaftar: {id,label,icon,roles,order,mount,unmount}
  let currentUser = null;
  let currentProfile = null;
  let activeModule = null;

  const $ = (id) => document.getElementById(id);

  /* ---------- util yang boleh dipakai semua modul ---------- */
  const util = {
    $,
    todayStr() {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    },
    timeStr(iso) {
      return iso ? new Date(iso).toLocaleTimeString("id-ID", { hour12: false }) : "—";
    },
    dateLong(dateStr) {
      const d = new Date(dateStr + "T00:00:00");
      return d.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    },
    escapeHtml(str) {
      return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },
    ticketHTML(row) {
      const d = new Date(row.date + "T00:00:00");
      const dow = d.toLocaleDateString("id-ID", { weekday: "short" });
      const dnum = d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
      const photo = row.check_out_photo_url || row.check_in_photo_url;
      const address = row.check_out_address || row.check_in_address;
      return `
        <div class="ticket">
          <div class="stub"><div class="dow">${dow}</div><div>${dnum}</div></div>
          <div class="perforation"></div>
          <div class="body">
            <div class="times">
              <div><div class="t-label">Masuk</div><div class="t-value">${util.timeStr(row.check_in)}</div></div>
              <div><div class="t-label">Pulang</div><div class="t-value">${util.timeStr(row.check_out)}</div></div>
            </div>
            ${address ? `<div style="font-size:12px; color:var(--muted); max-width:220px;">📍 ${util.escapeHtml(address)}</div>` : ""}
            ${photo ? `<a href="${photo}" target="_blank" rel="noopener"><img src="${photo}" alt="foto absen" style="width:38px;height:38px;border-radius:8px;object-fit:cover;border:1px solid var(--border);" /></a>` : ""}
            <span class="badge ${row.status}">${row.status}</span>
          </div>
        </div>`;
    },
  };

  /* ---------- registrasi modul ---------- */
  function registerModule(mod) {
    if (!mod.id || !mod.label || typeof mod.mount !== "function") {
      console.error("Modul tidak valid, harus punya id, label, dan mount():", mod);
      return;
    }
    modules.push(Object.assign({ roles: ["karyawan", "admin"], order: 99 }, mod));
  }

  /* ---------- auth bootstrap ---------- */
  async function init() {
    sb.auth.onAuthStateChange((_event, session) => {
      if (session && session.user) boot(session.user);
      else showLogin();
    });
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) boot(session.user);
    else showLogin();
  }

  async function boot(user) {
    currentUser = user;
    const { data: profile, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (error || !profile) {
      console.error("Gagal memuat profil:", error);
      await sb.auth.signOut();
      return;
    }
    currentProfile = profile;
    showApp();
  }

  function showLogin() {
    $("screen-login").style.display = "flex";
    $("screen-app").style.display = "none";
  }

  function showApp() {
    $("screen-login").style.display = "none";
    $("screen-app").style.display = "block";
    $("who-name").textContent = currentProfile.full_name || currentUser.email;
    $("who-role").textContent = currentProfile.role === "admin" ? "Admin" : "Karyawan";
    $("who-avatar").textContent = (currentProfile.full_name || currentUser.email).slice(0, 1).toUpperCase();
    buildMenu();
  }

  /* ---------- sidebar / router ---------- */
  function buildMenu() {
    const nav = $("sidebar-nav");
    const visible = modules
      .filter((m) => m.roles.includes(currentProfile.role))
      .sort((a, b) => a.order - b.order);

    nav.innerHTML = "";
    visible.forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "nav-item";
      btn.dataset.id = m.id;
      btn.innerHTML = `<span class="nav-icon">${m.icon || "▫"}</span><span>${m.label}</span>`;
      btn.onclick = () => selectModule(m.id);
      nav.appendChild(btn);
    });

    if (visible.length) selectModule(visible[0].id);
    else $("module-container").innerHTML = '<div class="empty-state">Belum ada menu untuk role ini.</div>';
  }

  async function selectModule(id) {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.id === id));

    if (activeModule && typeof activeModule.unmount === "function") {
      try { activeModule.unmount(); } catch (e) { console.warn("unmount error:", e); }
    }

    const mod = modules.find((m) => m.id === id);
    const container = $("module-container");
    if (!mod) { container.innerHTML = '<div class="empty-state">Modul tidak ditemukan.</div>'; return; }

    container.innerHTML = '<div class="module-loading">Memuat…</div>';
    activeModule = mod;
    try {
      await mod.mount(container, { sb, util, user: currentUser, profile: currentProfile });
    } catch (e) {
      console.error(e);
      container.innerHTML = '<div class="empty-state">Gagal memuat modul: ' + util.escapeHtml(e.message) + "</div>";
    }
  }

  async function logout() {
    await sb.auth.signOut();
  }

  return {
    registerModule,
    init,
    logout,
    util,
    get user() { return currentUser; },
    get profile() { return currentProfile; },
  };
})();
