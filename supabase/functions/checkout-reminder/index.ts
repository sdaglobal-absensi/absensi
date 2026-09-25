// Edge Function: checkout-reminder
// -----------------------------------------------------------------------
// Jalan terjadwal (lihat README-PUSH-NOTIFIKASI.md untuk cara memasang
// cron-nya). Setiap kali jalan, function ini:
//   1. Ambil semua baris attendance yang masih terbuka (check_out null)
//      dan belum pernah dikirimi pengingat (checkout_reminder_sent_at null).
//   2. Untuk tiap baris, hitung jam pulang seharusnya dari Master Jadwal
//      Kerja karyawan itu (work_schedules / work_schedule_days) — logika
//      timezone-nya SENGAJA dibuat sama persis dengan zonedTimestamp() di
//      js/core.js (offset tetap per lokasi, TANPA DST), supaya jam
//      "telat check-out" yang dipakai di sini konsisten dengan jam
//      "telat check-in" yang dilihat karyawan di aplikasi.
//   3. Kalau sekarang sudah REMINDER_DELAY_MINUTES lewat dari jam pulang
//      (dan belum lewat REMINDER_WINDOW_MINUTES supaya tidak mengirim
//      pengingat basi untuk sesi yang sudah lama sekali telat), kirim push
//      notification ke semua device karyawan itu, lalu tandai
//      checkout_reminder_sent_at supaya tidak dikirim ulang.
//
// Deploy: supabase functions deploy checkout-reminder
// Secrets yang wajib di-set (lihat README-PUSH-NOTIFIKASI.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY,
//   VAPID_PRIVATE_KEY, VAPID_SUBJECT (mis. "mailto:admin@perusahaan.com")
// -----------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const REMINDER_DELAY_MINUTES = 15;   // kirim mulai 15 menit setelah jam pulang
const REMINDER_WINDOW_MINUTES = 120; // tapi jangan kirim kalau sudah > 2 jam (basi, biar admin yg tindak lanjuti)

// Sama persis dengan TIMEZONE_OPTIONS di js/core.js — offset tetap
// (Indonesia tidak pakai DST), jadi aman dihardcode di sini juga.
const TZ_OFFSET: Record<string, number> = {
  "Asia/Jakarta": 7,
  "Asia/Makassar": 8,
  "Asia/Jayapura": 9,
};
const DEFAULT_TZ_OFFSET = 7; // WIB, sama seperti APP_TIMEZONE_OFFSET_HOURS di core.js

function dayOfWeekFromDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Setara zonedTimestamp() di js/core.js: bangun epoch ms untuk jam HH:MM
// pada tanggal tertentu, DIUKUR menurut offset zona kerjanya.
function zonedTimestampMs(dateStr: string, hh: number, mm: number, offsetHours: number): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh - offsetHours, mm, 0);
}

Deno.serve(async req => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!
    );

    // 1. Ambil semua sesi terbuka yang belum pernah dikirimi pengingat.
    const { data: openRows, error: openErr } = await supabase
      .from("attendance")
      .select("id, user_id, date, check_in, profiles!inner(id, is_active, schedule_id, lokasi_kerja)")
      .is("check_out", null)
      .is("checkout_reminder_sent_at", null);

    if (openErr) throw openErr;
    if (!openRows || !openRows.length) {
      return new Response(JSON.stringify({ checked: 0, sent: 0 }), { headers: { "Content-Type": "application/json" } });
    }

    // Cache jadwal & timezone kantor supaya tidak query berulang untuk
    // karyawan-karyawan yang berbagi schedule_id / lokasi_kerja yang sama.
    const scheduleDayCache = new Map<string, any>();
    const officeTzCache = new Map<string, string>();
    const now = Date.now();
    let sent = 0;

    for (const row of openRows) {
      const profile = (row as any).profiles;
      if (!profile?.is_active || !profile.schedule_id) continue;

      const dow = dayOfWeekFromDateStr(row.date);
      const cacheKey = `${profile.schedule_id}:${dow}`;
      let day = scheduleDayCache.get(cacheKey);
      if (day === undefined) {
        const { data } = await supabase
          .from("work_schedule_days")
          .select("is_working_day, start_time, end_time, crosses_midnight")
          .eq("schedule_id", profile.schedule_id)
          .eq("day_of_week", dow)
          .maybeSingle();
        day = data || null;
        scheduleDayCache.set(cacheKey, day);
      }
      if (!day?.is_working_day || !day.end_time) continue;

      let tzName = officeTzCache.get(profile.lokasi_kerja || "");
      if (tzName === undefined) {
        if (profile.lokasi_kerja) {
          const { data: office } = await supabase
            .from("office_locations")
            .select("timezone")
            .eq("name", profile.lokasi_kerja)
            .maybeSingle();
          tzName = office?.timezone || "Asia/Jakarta";
        } else {
          tzName = "Asia/Jakarta";
        }
        officeTzCache.set(profile.lokasi_kerja || "", tzName);
      }
      const offset = TZ_OFFSET[tzName] ?? DEFAULT_TZ_OFFSET;

      const endDateStr = day.crosses_midnight ? addDaysToDateStr(row.date, 1) : row.date;
      const [eh, em] = day.end_time.split(":").map(Number);
      const shiftEndMs = zonedTimestampMs(endDateStr, eh, em, offset);

      const minutesSinceEnd = (now - shiftEndMs) / 60000;
      if (minutesSinceEnd < REMINDER_DELAY_MINUTES || minutesSinceEnd > REMINDER_WINDOW_MINUTES) continue;

      // 2. Ambil semua device (subscription) milik karyawan ini dan kirim push.
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth")
        .eq("user_id", row.user_id);

      if (!subs || !subs.length) continue;

      const payload = JSON.stringify({
        title: "Lupa check-out?",
        body: `Jam pulangmu sudah lewat (${day.end_time}) tapi belum ada check-out. Yuk absen pulang.`,
        url: "./app.html#absensi",
      });

      let anySent = false;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          anySent = true;
        } catch (err: any) {
          // Endpoint kedaluwarsa (user uninstall/hapus izin) -> bersihkan baris subscription-nya.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }

      if (anySent) {
        sent++;
        await supabase.from("attendance").update({ checkout_reminder_sent_at: new Date().toISOString() }).eq("id", row.id);
      }
    }

    return new Response(JSON.stringify({ checked: openRows.length, sent }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
