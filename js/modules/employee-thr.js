// "Slip THR Saya" — menu personal untuk melihat & mencetak slip THR milik sendiri.
// Sama seperti employee-slip-gaji.js: memanggil ulang render() modul THR dengan
// forceSelfOnly = true, sehingga SIAPA PUN yang membukanya lewat menu ini (termasuk
// Admin HR) hanya melihat slip THR miliknya sendiri yang sudah diterbitkan.
import { render as renderThr } from "./admin-thr.js";

export async function render(container, user) {
  return renderThr(container, user, { forceSelfOnly: true });
}
