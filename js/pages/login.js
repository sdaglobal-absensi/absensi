    import { supabase } from "../supabaseClient.js";
    import { login, loginWithPin, getCurrentUser } from "../auth.js";
    import { wirePasswordToggles } from "../core.js";
    import { setupCaptcha } from "../captcha.js";

    wirePasswordToggles();

    // CAPTCHA (Turnstile): widget dipasang saat formnya pertama kali tampil.
    const caps = {};
    const cap = name => (caps[name] ||= setupCaptcha(document.getElementById("captcha-" + name)));
    const captchaMsg = err => /captcha/i.test(String(err?.message)) ? "Verifikasi CAPTCHA gagal. Coba lagi." : null;

    // Pesan login email yang spesifik. Email/password salah tetap umum (tidak membocorkan
    // email mana yang terdaftar); Supabase hanya mengirim email_not_confirmed setelah password benar.
    const loginErrorMsg = err => {
      const code = String(err?.code || "");
      const msg = String(err?.message || "");
      const status = Number(err?.status || 0);
      if (/captcha/i.test(msg) || code === "captcha_failed") return "Verifikasi CAPTCHA gagal. Coba lagi.";
      if (code === "email_not_confirmed" || /email not confirmed/i.test(msg)) return "Email belum dikonfirmasi. Buka kotak masuk (cek juga folder spam) dan klik tautan konfirmasi, lalu masuk lagi.";
      if (status === 429 || /rate_limit/.test(code) || /rate limit/i.test(msg)) return "Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.";
      if (code === "user_banned" || /banned/i.test(msg)) return "Akun ini dinonaktifkan. Hubungi admin.";
      if (err?.name === "AuthRetryableFetchError" || /failed to fetch|networkerror|network request/i.test(msg)) return "Tidak bisa terhubung ke server. Periksa koneksi internet lalu coba lagi.";
      if (status >= 500) return "Layanan sedang bermasalah. Coba lagi sebentar lagi.";
      if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "Email atau password salah.";
      return "Gagal masuk. Coba lagi, atau hubungi admin bila terus berulang.";
    };
    cap("login");

    // toggle antara form login dan form lupa password
    document.getElementById("btn-show-forgot").addEventListener("click", () => {
      document.getElementById("panel-login").classList.add("hidden");
      document.getElementById("panel-forgot").classList.remove("hidden");
      cap("forgot");
    });
    document.getElementById("btn-back-login").addEventListener("click", () => {
      document.getElementById("panel-forgot").classList.add("hidden");
      document.getElementById("panel-login").classList.remove("hidden");
    });

    // Tab: login email <-> login PIN
    function setTab(pin) {
      document.getElementById("tab-email").classList.toggle("active", !pin);
      document.getElementById("tab-pin").classList.toggle("active", pin);
      document.getElementById("tab-email").setAttribute("aria-selected", String(!pin));
      document.getElementById("tab-pin").setAttribute("aria-selected", String(pin));
      document.getElementById("form-login").classList.toggle("hidden", pin);
      document.getElementById("form-login-pin").classList.toggle("hidden", !pin);
      document.getElementById("btn-show-forgot").classList.toggle("hidden", pin);
      cap(pin ? "pin" : "login");
    }
    document.getElementById("tab-email").addEventListener("click", () => setTab(false));
    document.getElementById("tab-pin").addEventListener("click", () => setTab(true));

    // Tautan "Daftarkan usaha" hanya muncul kalau pendaftaran publik dibuka.
    let signupOpen = false;
    (async () => {
      try {
        const { data } = await supabase.rpc("public_signup_open");
        signupOpen = data === true;
        document.getElementById("link-daftar").classList.toggle("hidden", !signupOpen);
      } catch (e) { /* SQL Tahap 2 belum dijalankan: abaikan */ }
    })();

    // Kalau ada session TAPI baris profil-nya bermasalah, app.html akan
    // melempar balik ke sini. Tampilkan pesan yang jelas alih-alih diam-diam
    // redirect lagi (itu yang menyebabkan loop refresh tanpa henti).
    const params = new URLSearchParams(location.search);
    if (params.get("reason") === "no-profile") {
      // Pendaftar usaha yang sudah konfirmasi email tapi belum membuat usahanya
      // -> lanjutkan di halaman daftar (kalau pendaftaran dibuka).
      supabase.rpc("public_signup_open").then(({ data }) => { if (data === true) location.replace("daftar.html?lanjut=1"); });
      document.getElementById("login-error").textContent =
        "Akun berhasil login tapi datanya belum lengkap di database (baris di tabel 'profiles' tidak ditemukan). Hubungi admin usahamu atau admin platform untuk memeriksa akun ini. Jangan menjalankan ulang file SQL lama.";
    }
    if (params.get("reason") === "inactive") {
      document.getElementById("login-error").textContent =
        "Akun kamu sudah dinonaktifkan. Hubungi admin untuk info lebih lanjut.";
    }
    if (params.get("reset") === "success") {
      document.getElementById("login-error").classList.add("success");
      document.getElementById("login-error").textContent = "Password berhasil diubah. Silakan masuk dengan password baru.";
    }

    // Redirect ke app.html HANYA kalau sesi valid *dan* profil lengkap bisa
    // dimuat — persis syarat yang sama dipakai app.html, supaya kedua
    // halaman selalu sepakat dan tidak saling lempar.
    (async () => {
      try {
        const user = await getCurrentUser();
        if (user) window.location.href = "app.html";
      } catch (e) {
        console.error("Cek sesi gagal:", e);
      }
    })();

    document.getElementById("form-login").addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("login-error");
      errEl.classList.remove("success");
      errEl.textContent = "";
      const c = cap("login");
      let token;
      try { token = await c.getToken(); } catch (err) { errEl.textContent = err.message; return; }
      try {
        await login(fd.get("email"), fd.get("password"), token);
        window.location.href = "app.html";
      } catch (err) {
        errEl.textContent = loginErrorMsg(err);
        c.reset();
      }
    });

    document.getElementById("form-login-pin").addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("pin-error");
      const btn = e.target.querySelector('button[type="submit"]');
      errEl.textContent = "";
      btn.disabled = true;
      const c = cap("pin");
      try {
        const token = await c.getToken();
        await loginWithPin(String(fd.get("kode_usaha")).trim(), String(fd.get("kode_karyawan")).trim(), String(fd.get("pin")).trim(), token);
        window.location.href = "app.html";
      } catch (err) {
        errEl.textContent = captchaMsg(err) || err.message || "Gagal masuk.";
        btn.disabled = false;
        c.reset();
      }
    });

    document.getElementById("form-forgot").addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("forgot-error");
      const okEl = document.getElementById("forgot-success");
      errEl.textContent = "";
      okEl.classList.add("hidden");
      const c = cap("forgot");
      try {
        const captchaToken = await c.getToken();
        const redirectTo = new URL("reset-password.html", location.href).href;
        const { error } = await supabase.auth.resetPasswordForEmail(fd.get("email"), { redirectTo, captchaToken });
        if (error) throw error;
        okEl.classList.remove("hidden");
        e.target.reset();
      } catch (err) {
        errEl.textContent = captchaMsg(err) || err.message;
      }
      c.reset();
    });
  
