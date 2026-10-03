import { supabase } from "./supabaseClient.js";
import { callFunction } from "./accountApi.js";

// ---------------------------------------------------------------------
// Ambil sesi & profil user yang sedang login. Return null kalau belum login.
// ---------------------------------------------------------------------
export async function getCurrentUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !profile) return null;
  // Akun PIN memakai email palsu internal -> jangan ditampilkan ke user.
  const user = { ...profile, email: profile.login_type === "pin" ? null : session.user.email };
  user.base_schedule_id = profile.schedule_id;
  user.schedule_id = await effectiveScheduleId(profile);
  return user;
}

// ---------------------------------------------------------------------
// Tukar shift (SQL 013): kalau hari ini ada jadwal penimpa, seluruh logika
// absensi memakainya lewat user.schedule_id. Jadwal dasar tetap di
// user.base_schedule_id. Kalau shift tukaran kemarin lintas tengah malam dan
// sekarang masih pagi, jadwal kemarin itulah yang dipakai (check-out dini hari).
// Gagal/tabel belum ada -> pakai jadwal dasar.
// ---------------------------------------------------------------------
async function effectiveScheduleId(profile) {
  const base = profile.schedule_id;
  try {
    const tz = "Asia/Jakarta";
    const now = new Date();
    const fmt = d => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    const today = fmt(now);
    const yesterday = fmt(new Date(now.getTime() - 86400000));
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now)) % 24;

    const { data, error } = await supabase.from("schedule_overrides")
      .select("work_date, schedule_id").eq("user_id", profile.id).in("work_date", [yesterday, today]);
    if (error || !data?.length) return base;

    const todayRow = data.find(r => r.work_date === today);
    if (todayRow) return todayRow.schedule_id;

    const yRow = data.find(r => r.work_date === yesterday);
    if (yRow && hour < 12) {
      const dow = new Date(yesterday + "T00:00:00Z").getUTCDay();
      const { data: day } = await supabase.from("work_schedule_days")
        .select("crosses_midnight").eq("schedule_id", yRow.schedule_id).eq("day_of_week", dow).maybeSingle();
      if (day?.crosses_midnight) return yRow.schedule_id;
    }
  } catch { /* pakai jadwal dasar */ }
  return base;
}

// ---------------------------------------------------------------------
// Wajib dipanggil di setiap halaman terproteksi. Redirect ke login kalau
// belum authenticated, atau redirect kalau role tidak diizinkan.
// ---------------------------------------------------------------------
export async function requireAuth(allowedRoles = null) {
  let user;
  try {
    user = await getCurrentUser();
  } catch (e) {
    console.error("requireAuth error:", e);
    user = null;
  }
  if (!user) {
    // Cek dulu apakah sebenarnya ada session tapi baris profiles-nya
    // yang bermasalah (RLS / trigger tidak jalan) — beri pesan jelas
    // di halaman login alih-alih diam-diam redirect (penyebab loop).
    const { data: { session } } = await supabase.auth.getSession();
    window.location.href = session ? "index.html?reason=no-profile" : "index.html";
    return null;
  }
  if (!user.is_active) {
    await supabase.auth.signOut();
    window.location.href = "index.html?reason=inactive";
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    window.location.href = "app.html?reason=forbidden";
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
export async function login(email, password, captchaToken) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email, password, options: captchaToken ? { captchaToken } : undefined,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Login karyawan tanpa email: kode usaha + kode karyawan + PIN.
// Dicek server (Edge Function login-pin, ada batas percobaan salah);
// sesi yang dikembalikan dipasang di client utama seperti login biasa.
// ---------------------------------------------------------------------
export async function loginWithPin(kodeUsaha, kodeKaryawan, pin, captchaToken) {
  const res = await callFunction("login-pin", { kode_usaha: kodeUsaha, kode_karyawan: kodeKaryawan, pin, captcha_token: captchaToken }, false);
  if (!res?.session?.access_token) {
    throw new Error("Server login PIN tidak mengembalikan sesi. Edge Function login-pin yang ter-deploy kemungkinan bukan versi yang benar — deploy ulang.");
  }
  const { error } = await supabase.auth.setSession(res.session);
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------
export async function logout() {
  await supabase.auth.signOut();
  window.location.href = "index.html";
}
