// =====================================================================
// Konfigurasi koneksi Supabase
// Ganti dua nilai di bawah dengan milik project Supabase kamu sendiri.
// Ambil dari: Supabase Dashboard > Project Settings > API
// =====================================================================
const SUPABASE_URL = "https://cugjzcspygqxlmbqfayc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_GbDS7pltDds4Wpt9wFZ8Sg_t0qlY_1A";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "absensi-auth",
  },
});

// Client kedua yang terpisah, khusus dipakai saat ADMIN membuat akun
// karyawan baru (auth.signUp). Ini penting: kalau memakai client utama,
// signUp akan menimpa sesi login admin yang sedang aktif. Dengan
// storageKey berbeda, sesi admin di client utama tetap aman.
export const supabaseAdminCreate = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storageKey: "absensi-admin-create-temp",
  },
});
