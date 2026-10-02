import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabaseClient.js";

// ---------------------------------------------------------------------
// Pemanggil Edge Function. Error dari server (HTTP 4xx/5xx) dilempar
// sebagai Error dengan pesan Indonesia dari server, siap ditampilkan.
// withSession=true : kirim token user yang login (untuk account-admin)
// ---------------------------------------------------------------------
export async function callFunction(name, body, withSession = true) {
  let token = SUPABASE_ANON_KEY;
  if (withSession) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Sesi habis, silakan login ulang.");
    token = session.access_token;
  }
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Tidak bisa terhubung ke server. Periksa koneksi internet.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Edge Function "${name}" belum di-deploy.`);
    throw new Error(data?.error || `Permintaan gagal (${res.status})`);
  }
  return data;
}

// Buat akun karyawan di usaha si admin yang login.
// { employee_code, full_name, login_type:"email"|"pin", email?, password?, pin? }
// -> { user_id, login_type, email? | pin? }
export const createEmployeeAccount = payload =>
  callFunction("account-admin", { action: "create-employee", ...payload });

// Ganti PIN akun PIN (kosongkan pin = dibuatkan acak) -> { user_id, pin }
export const resetEmployeePin = (user_id, pin) =>
  callFunction("account-admin", { action: "reset-pin", user_id, pin: pin || undefined });

// Teks undangan siap kirim lewat WhatsApp.
export function inviteText({ namaUsaha, kodeUsaha, namaKaryawan, kodeKaryawan, email, secretLabel, secret, loginType }) {
  const link = new URL("index.html", location.href).href;
  const lines = [
    `Halo ${namaKaryawan},`,
    `Akun absensi kamu di *${namaUsaha}* sudah dibuat.`,
    ``,
    `Buka: ${link}`,
  ];
  if (loginType === "pin") {
    lines.push(`Pilih tab "Karyawan (tanpa email)", lalu isi:`,
      `Kode usaha: ${kodeUsaha}`, `Kode karyawan: ${kodeKaryawan}`, `${secretLabel}: ${secret}`);
  } else {
    lines.push(`Email: ${email}`, `${secretLabel}: ${secret}`);
  }
  lines.push(``, `Segera simpan dan jangan bagikan ke orang lain.`);
  return lines.join("\n");
}
