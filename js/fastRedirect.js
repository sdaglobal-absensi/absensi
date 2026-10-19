// Jalan paling awal di index.html (halaman login), sebelum apa pun dimuat.
// Kalau di HP/browser ini masih tersimpan sesi login (kunci "absensi-auth"),
// langsung pindah ke app.html tanpa menampilkan form login dan tanpa
// menunggu jaringan. Pemeriksaan sebenarnya (token, profil, akun aktif)
// tetap dilakukan app.html lewat requireAuth(); kalau sesinya ternyata
// tidak valid, app.html melempar balik ke sini.
//
// Tidak dijalankan saat URL membawa ?reason=... atau ?reset=... (artinya
// app.html baru saja menolak sesi ini, atau ada pesan yang harus dibaca),
// supaya tidak terjadi putaran index <-> app.
(function () {
  try {
    if (/[?&](reason|reset)=/.test(location.search)) return;
    var raw = localStorage.getItem("absensi-auth");
    if (!raw) return;
    var s = JSON.parse(raw);
    if (s && s.refresh_token) location.replace("app.html");
  } catch (e) { /* storage tidak bisa dibaca: tampilkan login seperti biasa */ }
})();
