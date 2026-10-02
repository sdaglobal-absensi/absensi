// Fungsi murni untuk checkout-reminder (dipisah supaya mudah diuji).
// Sengaja SAMA PERSIS dengan zonedTimestamp() / TIMEZONE_OPTIONS di js/core.js.

export const REMINDER_DELAY_MINUTES = 15;    // "telat" dikirim mulai 15 menit setelah jam masuk/pulang lewat
export const REMINDER_WINDOW_MINUTES = 120;  // jangan kirim kalau sudah > 2 jam (basi)
// Pengingat "sebentar lagi". Samakan dengan interval cron (15 menit); kalau
// cron dijarangkan, naikkan angka ini agar jendelanya tidak terlewat.
export const BEFORE_REMINDER_MINUTES = 15;

// Offset tetap (Indonesia tanpa DST).
export const TZ_OFFSET: Record<string, number> = {
  "Asia/Jakarta": 7,
  "Asia/Makassar": 8,
  "Asia/Jayapura": 9,
};
export const DEFAULT_TZ_OFFSET = 7; // WIB

export function tzOffsetHours(tzName: string | null | undefined): number {
  return (tzName && TZ_OFFSET[tzName]) || DEFAULT_TZ_OFFSET;
}

export function dayOfWeekFromDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// epoch ms untuk jam HH:MM pada tanggal tertentu, DIUKUR menurut offset zona kerjanya.
export function zonedTimestampMs(dateStr: string, hh: number, mm: number, offsetHours: number): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh - offsetHours, mm, 0);
}

// "Tanggal hari ini" menurut offset zona tertentu (bukan zona server Deno).
export function todayInOffset(offsetHours: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + offsetHours * 3600000).toISOString().slice(0, 10);
}
