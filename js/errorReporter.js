import { supabase } from "./supabaseClient.js";

// Kirim error JS yang tidak tertangani ke tabel client_errors (migrasi 020).
// Gagal diam-diam: pelaporan tidak boleh menimbulkan error baru. Duplikat
// pesan yang sama dalam satu sesi tidak dikirim ulang.
const sent = new Set();

function report(message, stack) {
  const key = String(message).slice(0, 200);
  if (sent.has(key) || sent.size >= 10) return;
  sent.add(key);
  try {
    supabase.rpc("log_client_error", {
      p_message: String(message),
      p_stack: stack ? String(stack) : null,
      p_page: location.pathname + location.hash,
      p_ua: navigator.userAgent,
    }).then(() => {}, () => {});
  } catch { /* abaikan */ }
}

export function initErrorReporter() {
  window.addEventListener("error", e => report(e.message, e.error?.stack));
  window.addEventListener("unhandledrejection", e => {
    const r = e.reason;
    report(r?.message || String(r), r?.stack);
  });
}
