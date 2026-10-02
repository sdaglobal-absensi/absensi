// =====================================================================
// CAPTCHA (Cloudflare Turnstile) untuk login, daftar usaha, lupa password.
// Site key BOLEH publik. Secret key JANGAN ditaruh di sini — hanya di
// Supabase (Authentication > Attack Protection).
// Token Turnstile sekali pakai: setelah dipakai (berhasil/gagal) panggil
// reset() agar pengguna mendapat token baru.
// =====================================================================
export const TURNSTILE_SITE_KEY = "0x4AAAAAAFLs4UMfaYN-tlRL";

let scriptPromise = null;
function loadScript() {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptPromise = null; reject(new Error("Gagal memuat CAPTCHA. Periksa koneksi internet.")); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

// Pasang widget ke elemen `el`. Return { getToken, reset }.
export function setupCaptcha(el) {
  let widgetId = null;
  let token = "";
  let waiters = [];
  const ready = loadScript().then(() => {
    widgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: "light",
      callback: t => { token = t; waiters.splice(0).forEach(w => w.resolve(t)); },
      "expired-callback": () => { token = ""; },
      "error-callback": () => { token = ""; waiters.splice(0).forEach(w => w.reject(new Error("CAPTCHA gagal. Muat ulang halaman lalu coba lagi."))); },
    });
  }).catch(e => { el.textContent = e.message; });

  return {
    // Menunggu sampai pengguna lolos verifikasi (biasanya otomatis, <2 detik).
    async getToken() {
      await ready;
      if (token) return token;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Verifikasi CAPTCHA belum selesai. Tunggu sebentar lalu coba lagi.")), 20000);
        waiters.push({ resolve: t => { clearTimeout(timer); resolve(t); }, reject: e => { clearTimeout(timer); reject(e); } });
      });
    },
    reset() {
      token = "";
      if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    },
  };
}
