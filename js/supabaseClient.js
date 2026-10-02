// =====================================================================
// Konfigurasi koneksi Supabase
// Ganti dua nilai di bawah dengan milik project Supabase kamu sendiri.
// Ambil dari: Supabase Dashboard > Project Settings > API
// =====================================================================
export const SUPABASE_URL = "https://cugjzcspygqxlmbqfayc.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_GbDS7pltDds4Wpt9wFZ8Sg_t0qlY_1A";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "absensi-auth",
  },
});
