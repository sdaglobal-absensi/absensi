// "Slip Gaji Saya" — menu personal, terpisah dari "Slip Gaji" (menu staff
// yang bisa kelola & lihat semua karyawan). Menu ini sengaja dipisah supaya
// Super Admin bisa memberi Admin HR / Super Admin HR akses untuk lihat &
// cetak slip gajinya SENDIRI, TANPA harus ikut membuka akses lihat/kelola
// gaji seluruh karyawan lain (menu "Slip Gaji" yang lebih luas).
//
// Secara teknis, ini cuma memanggil ulang render() dari admin-slip-gaji.js
// dengan opts.forceSelfOnly = true, yang membuat modul itu berperilaku
// persis seperti tampilan Karyawan (1 baris = dirinya sendiri, tanpa tombol
// finalisasi/buka kunci, tanpa tombol edit tunjangan/potongan) — apapun
// role asli user yang membukanya.
import { render as renderSlipGaji } from "./admin-slip-gaji.js";

export async function render(container, user) {
  return renderSlipGaji(container, user, { forceSelfOnly: true });
}
