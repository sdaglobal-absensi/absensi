import { supabase } from "./supabaseClient.js";
import { logout } from "./auth.js";

// Naikkan nilai ini setiap isi privacy.html berubah material -> semua pengguna
// diminta setuju ulang. Disimpan di tabel privacy_consents (migrasi 019).
export const PRIVACY_VERSION = "2026-10";

// Tampilkan layar persetujuan bila user belum menyetujui versi aktif.
// Resolve setelah user setuju. Bila RPC belum ada (migrasi 019 belum dijalankan)
// atau gagal, jangan mengunci aplikasi — lanjut saja.
export async function ensurePrivacyConsent() {
  try {
    const { data, error } = await supabase.rpc("has_accepted_privacy", { p_version: PRIVACY_VERSION });
    if (error || data === true) return;
  } catch { return; }

  await new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "privacy-title");

    const box = document.createElement("div");
    box.className = "modal-box";

    const h = document.createElement("h3");
    h.id = "privacy-title";
    h.textContent = "Persetujuan Kebijakan Privasi";

    const p = document.createElement("p");
    p.className = "muted";
    p.style.margin = "8px 0 12px";
    p.textContent = "Aplikasi ini memproses data pribadi Anda (identitas, foto selfie dan lokasi saat absen, data gaji) untuk keperluan kepegawaian sesuai UU PDP. Baca kebijakan lengkapnya sebelum melanjutkan.";

    const link = document.createElement("a");
    link.href = "privacy.html";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Baca Kebijakan Privasi";
    link.style.display = "inline-block";

    const label = document.createElement("label");
    label.style.cssText = "display:flex;gap:10px;align-items:flex-start;margin:14px 0 6px;cursor:pointer;font-size:.9rem;line-height:1.45;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    // CSS global membuat <input> selebar kolom; paksa ukuran asli agar sejajar dengan teks.
    cb.style.cssText = "width:18px;height:18px;flex:none;margin:1px 0 0;padding:0;";
    const span = document.createElement("span");
    span.textContent = "Saya telah membaca dan menyetujui Kebijakan Privasi.";
    label.append(cb, span);

    const warn = document.createElement("p");
    warn.className = "muted small";
    warn.style.margin = "0 0 4px";
    warn.textContent = "Jika tidak setuju, Anda tidak dapat memakai aplikasi ini dan akan keluar dari akun. Pertanyaan? Hubungi HR/admin perusahaan Anda.";

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn-secondary";
    reject.textContent = "Tolak & Keluar";
    reject.addEventListener("click", async () => {
      reject.disabled = true;
      btn.disabled = true;
      await logout();
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "Setuju & Lanjutkan";
    btn.disabled = true;
    cb.addEventListener("change", () => { btn.disabled = !cb.checked; });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { error } = await supabase.rpc("accept_privacy", { p_version: PRIVACY_VERSION });
      if (error) { btn.disabled = !cb.checked; warn.textContent = "Gagal menyimpan persetujuan: " + error.message; return; }
      overlay.remove();
      resolve();
    });
    actions.append(reject, btn);

    box.append(h, p, link, label, warn, actions);
    overlay.append(box);
    document.body.appendChild(overlay);
  });
}
