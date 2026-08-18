/* ======================================================================
   KONFIGURASI SUPABASE
   File ini SATU-SATUNYA tempat yang perlu diisi agar aplikasi tersambung
   ke database. Ambil dari: Supabase Dashboard → Project Settings → API
   ====================================================================== */
const SUPABASE_URL = "https://cugjzcspygqxlmbqfayc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_GbDS7pltDds4Wpt9wFZ8Sg_t0qlY_1A";

/* Jam masuk kantor — dipakai modul absensi untuk menandai "terlambat" */
window.JAM_MASUK = "08:00:00";

window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
