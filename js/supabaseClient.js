/* ======================================================================
   KONFIGURASI SUPABASE
   File ini SATU-SATUNYA tempat yang perlu diisi agar aplikasi tersambung
   ke database. Ambil dari: Supabase Dashboard → Project Settings → API
   ====================================================================== */
const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";

/* Jam masuk kantor — dipakai modul absensi untuk menandai "terlambat" */
window.JAM_MASUK = "08:00:00";

window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
