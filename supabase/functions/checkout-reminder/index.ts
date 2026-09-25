// Edge Function: checkout-reminder
// -----------------------------------------------------------------------
// Jalan terjadwal (lihat README-PUSH-NOTIFIKASI.md untuk cara memasang
// cron-nya). Setiap kali jalan, function ini melakukan EMPAT pengecekan:
//
//   A. PENGINGAT TELAT CHECK-OUT — sesi attendance yang masih terbuka
//      (check_out null) sudah lewat jam pulang seharusnya.
//   B. PENGINGAT TELAT CHECK-IN — karyawan yang jadwalnya hari ini adalah
//      hari kerja, jam masuknya sudah lewat, tapi belum ada baris
//      attendance sama sekali (belum check-in).
//   C. PENGINGAT SEBELUM CHECK-OUT — sesi attendance yang masih terbuka,
//      jam pulangnya SEBENTAR LAGI (dalam BEFORE_REMINDER_MINUTES ke
//      depan), supaya karyawan diingatkan sebelum lupa.
//   D. PENGINGAT SEBELUM CHECK-IN — karyawan berjadwal hari kerja yang jam
//      masuknya SEBENTAR LAGI (dalam BEFORE_REMINDER_MINUTES ke depan) dan
//      belum ada baris attendance hari ini.
//
// Untuk semuanya, jam kerja diambil dari Master Jadwal Kerja karyawan
// (work_schedules / work_schedule_days) dan dihitung dengan offset zona
// waktu TETAP per lokasi (TANPA DST) — SENGAJA dibuat sama persis dengan
// zonedTimestamp() di js/core.js supaya konsisten dengan jam yang dipakai
// menentukan status telat di aplikasi.
//
// Anti-kirim-dobel:
//   - Telat check-out   : kolom attendance.checkout_reminder_sent_at
//   - Telat check-in    : tabel checkin_reminders_sent (belum ada baris
//     attendance untuk ditempeli flag, jadi pakai tabel log terpisah)
//   - Sebelum check-out : kolom attendance.checkout_before_reminder_sent_at
//   - Sebelum check-in  : tabel checkin_before_reminder_sent (alasan sama
//     seperti telat check-in — baris attendance belum ada)
//
// Catatan: untuk kesederhanaan, pengingat check-in (telat maupun sebelum)
// memakai tanggal kalender HARI INI (menurut tz karyawan) sebagai "tanggal
// shift" — tidak mereplikasi logika penuh resolveShiftDate() di
// employee-absensi.js untuk shift lintas tengah malam yang telat check-in.
// Ini cukup untuk kasus mayoritas (shift reguler); shift lintas hari yang
// sangat telat check-in tetap akan ketahuan lewat panel admin, hanya saja
// tidak dapat push.
//
// Deploy: supabase functions deploy checkout-reminder
// Secrets yang wajib di-set (lihat README-PUSH-NOTIFIKASI.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY,
//   VAPID_PRIVATE_KEY, VAPID_SUBJECT (mis. "mailto:admin@perusahaan.com")
// -----------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const REMINDER_DELAY_MINUTES = 15;   // kirim "telat" mulai 15 menit setelah jam masuk/pulang lewat
const REMINDER_WINDOW_MINUTES = 120; // tapi jangan kirim kalau sudah > 2 jam (basi, biar admin yg tindak lanjuti)

// Pengingat "sebentar lagi" dikirim begitu sisa waktu ke jam masuk/pulang
// masuk ke jendela [0, BEFORE_REMINDER_MINUTES] menit. Nilai default sengaja
// disamakan dengan interval cron yang disarankan (tiap 15 menit) di
// README-PUSH-NOTIFIKASI.md — kalau cron-nya diubah jadi jarang, naikkan
// juga angka ini supaya jendelanya tidak "kelewatan" di antara dua run.
const BEFORE_REMINDER_MINUTES = 15;

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

// "Tanggal hari ini" menurut offset zona tertentu (bukan zona server Deno).
function todayInOffset(offsetHours: number): string {
  const shifted = new Date(Date.now() + offsetHours * 3600000);
  return shifted.toISOString().slice(0, 10);
}

Deno.serve(async _req => {
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

    const now = Date.now();

    // Saklar global dari Pengaturan Sistem (Super Admin). Kalau dimatikan,
    // tidak ada notifikasi jenis apapun yang dikirim ke siapapun sama
    // sekali -- tapi ini TIDAK mencabut izin notifikasi browser yang sudah
    // diberikan karyawan (itu tetap tersimpan di push_subscriptions, cuma
    // tidak dipakai selama saklar ini mati). Default true kalau baris
    // belum ada / gagal dibaca, supaya perilaku tetap seperti sebelum ada
    // saklar ini.
    const { data: settings } = await supabase
      .from("push_settings")
      .select("reminders_enabled")
      .eq("id", 1)
      .maybeSingle();
    if (settings && settings.reminders_enabled === false) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "reminders_disabled_by_admin" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const scheduleDayCache = new Map<string, any>();
    const officeTzCache = new Map<string, string>();

    async function resolveTzOffset(lokasiKerja: string | null): Promise<number> {
      const key = lokasiKerja || "";
      let tzName = officeTzCache.get(key);
      if (tzName === undefined) {
        if (lokasiKerja) {
          const { data: office } = await supabase
            .from("office_locations")
            .select("timezone")
            .eq("name", lokasiKerja)
            .maybeSingle();
          tzName = office?.timezone || "Asia/Jakarta";
        } else {
          tzName = "Asia/Jakarta";
        }
        officeTzCache.set(key, tzName);
      }
      return TZ_OFFSET[tzName] ?? DEFAULT_TZ_OFFSET;
    }

    async function resolveScheduleDay(scheduleId: string, dow: number) {
      const cacheKey = `${scheduleId}:${dow}`;
      let day = scheduleDayCache.get(cacheKey);
      if (day === undefined) {
        const { data } = await supabase
          .from("work_schedule_days")
          .select("is_working_day, start_time, end_time, crosses_midnight")
          .eq("schedule_id", scheduleId)
          .eq("day_of_week", dow)
          .maybeSingle();
        day = data || null;
        scheduleDayCache.set(cacheKey, day);
      }
      return day;
    }

    // Helper dipakai oleh kedua jenis pengingat: kirim ke semua device
    // karyawan ini, bersihkan endpoint yang sudah kedaluwarsa, kembalikan
    // true kalau minimal satu device berhasil dikirimi.
    async function sendToUser(userId: string, payload: string): Promise<boolean> {
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth")
        .eq("user_id", userId);
      if (!subs || !subs.length) return false;

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
      return anySent;
    }

    // -----------------------------------------------------------------
    // A. PENGINGAT CHECK-OUT (telat + sebelum)
    // -----------------------------------------------------------------
    let checkoutSent = 0;
    let checkoutBeforeSent = 0;
    const { data: openRows, error: openErr } = await supabase
      .from("attendance")
      .select(
        "id, user_id, date, checkout_reminder_sent_at, checkout_before_reminder_sent_at, profiles!inner(id, is_active, schedule_id, lokasi_kerja)"
      )
      .is("check_out", null)
      .or("checkout_reminder_sent_at.is.null,checkout_before_reminder_sent_at.is.null");
    if (openErr) throw openErr;

    for (const row of openRows || []) {
      const profile = (row as any).profiles;
      if (!profile?.is_active || !profile.schedule_id) continue;

      const dow = dayOfWeekFromDateStr(row.date);
      const day = await resolveScheduleDay(profile.schedule_id, dow);
      if (!day?.is_working_day || !day.end_time) continue;

      const offset = await resolveTzOffset(profile.lokasi_kerja);
      const endDateStr = day.crosses_midnight ? addDaysToDateStr(row.date, 1) : row.date;
      const [eh, em] = day.end_time.split(":").map(Number);
      const shiftEndMs = zonedTimestampMs(endDateStr, eh, em, offset);
      const minutesSince = (now - shiftEndMs) / 60000; // positif = sudah lewat, negatif = belum sampai

      // C. Sebelum check-out: jam pulang sebentar lagi tiba, belum pernah diingatkan.
      if (
        row.checkout_before_reminder_sent_at == null &&
        -minutesSince <= BEFORE_REMINDER_MINUTES &&
        -minutesSince > 0
      ) {
        const payload = JSON.stringify({
          title: "Sebentar lagi jam pulang",
          body: `Jam pulangmu ${day.end_time.slice(0, 5)}, sebentar lagi. Jangan lupa check-out ya.`,
          url: "./app.html#absensi",
        });
        if (await sendToUser(row.user_id, payload)) {
          checkoutBeforeSent++;
          await supabase
            .from("attendance")
            .update({ checkout_before_reminder_sent_at: new Date().toISOString() })
            .eq("id", row.id);
        }
      }

      // A. Telat check-out: jam pulang sudah lewat 15–120 menit, belum checkout.
      if (
        row.checkout_reminder_sent_at == null &&
        minutesSince >= REMINDER_DELAY_MINUTES &&
        minutesSince <= REMINDER_WINDOW_MINUTES
      ) {
        const payload = JSON.stringify({
          title: "Lupa check-out?",
          body: `Jam pulangmu sudah lewat (${day.end_time.slice(0, 5)}) tapi belum ada check-out. Yuk absen pulang.`,
          url: "./app.html#absensi",
        });
        if (await sendToUser(row.user_id, payload)) {
          checkoutSent++;
          await supabase.from("attendance").update({ checkout_reminder_sent_at: new Date().toISOString() }).eq("id", row.id);
        }
      }
    }

    // -----------------------------------------------------------------
    // B & D. PENGINGAT CHECK-IN (telat + sebelum) — karyawan aktif
    //    berjadwal, hari kerja, belum ada baris attendance hari ini sama
    //    sekali. Iterasi semua karyawan aktif berjadwal (bukan cuma yang
    //    sudah attendance), karena justru yang BELUM check-in ini yang
    //    perlu diingatkan.
    // -----------------------------------------------------------------
    let checkinSent = 0;
    let checkinBeforeSent = 0;
    const { data: profiles, error: profErr } = await supabase
      .from("profiles")
      .select("id, is_active, schedule_id, lokasi_kerja")
      .eq("is_active", true)
      .not("schedule_id", "is", null);
    if (profErr) throw profErr;

    for (const profile of profiles || []) {
      const offset = await resolveTzOffset(profile.lokasi_kerja);
      const todayStr = todayInOffset(offset);
      const dow = dayOfWeekFromDateStr(todayStr);
      const day = await resolveScheduleDay(profile.schedule_id, dow);
      if (!day?.is_working_day || !day.start_time) continue;

      const [sh, sm] = day.start_time.split(":").map(Number);
      const shiftStartMs = zonedTimestampMs(todayStr, sh, sm, offset);
      const minutesSince = (now - shiftStartMs) / 60000; // positif = sudah lewat, negatif = belum sampai

      const isBeforeWindow = -minutesSince <= BEFORE_REMINDER_MINUTES && -minutesSince > 0;
      const isLateWindow = minutesSince >= REMINDER_DELAY_MINUTES && minutesSince <= REMINDER_WINDOW_MINUTES;
      if (!isBeforeWindow && !isLateWindow) continue;

      // Sudah check-in hari ini? (baris attendance untuk tanggal ini sudah ada)
      const { data: existing } = await supabase
        .from("attendance")
        .select("id")
        .eq("user_id", profile.id)
        .eq("date", todayStr)
        .maybeSingle();
      if (existing) continue;

      // D. Sebelum check-in: jam masuk sebentar lagi tiba, belum pernah diingatkan hari ini.
      if (isBeforeWindow) {
        const { data: alreadyBefore } = await supabase
          .from("checkin_before_reminder_sent")
          .select("user_id")
          .eq("user_id", profile.id)
          .eq("date", todayStr)
          .maybeSingle();
        if (!alreadyBefore) {
          const payload = JSON.stringify({
            title: "Sebentar lagi jam masuk",
            body: `Jadwalmu hari ini mulai jam ${day.start_time.slice(0, 5)}, sebentar lagi. Jangan lupa check-in ya.`,
            url: "./app.html#absensi",
          });
          if (await sendToUser(profile.id, payload)) {
            checkinBeforeSent++;
            // Insert dulu (bukan upsert) supaya kalau ada 2 invocation nyaris
            // bersamaan, yang kedua akan gagal insert (primary key bentrok)
            // dan otomatis tidak mengirim dobel.
            await supabase
              .from("checkin_before_reminder_sent")
              .insert({ user_id: profile.id, date: todayStr })
              .select()
              .maybeSingle();
          }
        }
      }

      // B. Telat check-in: jam masuk sudah lewat 15–120 menit, belum check-in.
      if (isLateWindow) {
        const { data: already } = await supabase
          .from("checkin_reminders_sent")
          .select("user_id")
          .eq("user_id", profile.id)
          .eq("date", todayStr)
          .maybeSingle();
        if (!already) {
          const payload = JSON.stringify({
            title: "Belum check-in?",
            body: `Jadwalmu hari ini mulai jam ${day.start_time.slice(0, 5)} dan belum ada check-in. Yuk segera absen masuk.`,
            url: "./app.html#absensi",
          });
          if (await sendToUser(profile.id, payload)) {
            checkinSent++;
            await supabase.from("checkin_reminders_sent").insert({ user_id: profile.id, date: todayStr }).select().maybeSingle();
          }
        }
      }
    }

    return new Response(
      JSON.stringify({
        checkout_sent: checkoutSent,
        checkin_sent: checkinSent,
        checkout_before_sent: checkoutBeforeSent,
        checkin_before_sent: checkinBeforeSent,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
