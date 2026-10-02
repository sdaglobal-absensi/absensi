// Edge Function: checkout-reminder  (TAHAP 3: per usaha / tenant)
// -----------------------------------------------------------------------
// Jalan terjadwal (lihat README-PUSH-NOTIFIKASI.md untuk cron-nya). Tiap
// jalan, function ini memproses SETIAP USAHA (tenant) yang aktif, satu per
// satu, dan melakukan EMPAT pengecekan:
//
//   A. TELAT CHECK-OUT   — sesi attendance terbuka, jam pulang lewat 15–120 mnt.
//   B. TELAT CHECK-IN    — hari kerja, jam masuk lewat 15–120 mnt, belum ada
//                          baris attendance hari ini.
//   C. SEBELUM CHECK-OUT — jam pulang tinggal <= 15 mnt.
//   D. SEBELUM CHECK-IN  — jam masuk tinggal <= 15 mnt, belum check-in.
//
// YANG BERBEDA DARI TAHAP 2 (satu perusahaan) -> TAHAP 3 (banyak usaha):
//   * Function ini memakai service role (tembus RLS), jadi SETIAP query
//     memfilter tenant_id secara eksplisit. Tidak ada lagi lookup yang
//     "global" (mis. nama lokasi kantor sama di dua usaha tidak lagi bentrok).
//   * Usaha berstatus `suspended` dilewati. Usaha yang mematikan pengingat
//     di Pengaturan Sistem (push_settings.reminders_enabled = false) dilewati.
//     Pengingat usaha lain tetap jalan.
//   * Zona waktu dicari dari office_locations MILIK usaha itu.
//   * Query dipaging (batas Supabase 1000 baris/request) dan data dimuat
//     sekali per usaha (jadwal, lokasi, langganan push, log terkirim) lewat
//     query massal — bukan satu query per karyawan.
//   * Karyawan diproses paralel dengan batas (CONCURRENCY) supaya 2.500
//     karyawan tidak membuat function kehabisan waktu.
//   * Anti-dobel dengan "klaim dulu, kirim kemudian": dua eksekusi yang
//     nyaris bersamaan tidak akan mengirim dobel.
//   * Kegagalan satu usaha tidak menghentikan usaha lain.
//
// Catatan: pengingat check-in memakai tanggal kalender HARI INI (menurut
// zona karyawan) sebagai "tanggal shift" — shift lintas tengah malam yang
// sangat telat check-in tidak mendapat push (tetap terlihat di panel admin).
//
// Deploy : supabase functions deploy checkout-reminder
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (otomatis),
//          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// -----------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import {
  addDaysToDateStr, BEFORE_REMINDER_MINUTES, dayOfWeekFromDateStr, REMINDER_DELAY_MINUTES,
  REMINDER_WINDOW_MINUTES, todayInOffset, tzOffsetHours, zonedTimestampMs,
} from "./logic.ts";

const PAGE = 1000;            // batas baris per request Supabase
const IN_CHUNK = 100;         // jumlah id per filter .in(...) (jaga panjang URL)
const CONCURRENCY = 10;       // karyawan/baris diproses paralel
const TIME_BUDGET_MS = 110_000; // berhenti memulai usaha baru setelah ini (batas function ~150 dtk)

// deno-lint-ignore no-explicit-any
type Db = any;

// ---- util -------------------------------------------------------------
async function fetchAll(make: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function inChunks(ids: string[], run: (chunk: string[]) => Promise<any[]>): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...(await run(ids.slice(i, i + IN_CHUNK))));
  return out;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch (e) { console.error("pengingat gagal untuk satu item:", e); }
    }
  });
  await Promise.all(workers);
}

const isDup = (err: any) => err?.code === "23505" || /duplicate key/i.test(err?.message ?? "");

// ---- proses satu usaha ------------------------------------------------
export async function processTenant(db: Db, send: (sub: any, payload: string) => Promise<void>, tenantId: string, now: number) {
  const stats = { checkout_sent: 0, checkin_sent: 0, checkout_before_sent: 0, checkin_before_sent: 0 };

  // Jadwal & zona waktu: dimuat sekali per usaha.
  const days = await fetchAll(() => db.from("work_schedule_days")
    .select("schedule_id, day_of_week, is_working_day, start_time, end_time, crosses_midnight")
    .eq("tenant_id", tenantId).order("schedule_id").order("day_of_week"));
  const dayMap = new Map<string, any>();
  for (const d of days) dayMap.set(`${d.schedule_id}:${d.day_of_week}`, d);

  const offices = await fetchAll(() => db.from("office_locations")
    .select("name, timezone").eq("tenant_id", tenantId).order("id"));
  const tzByOffice = new Map<string, string>();
  for (const o of offices) tzByOffice.set(o.name, o.timezone || "Asia/Jakarta");
  const offsetOf = (lokasi: string | null) => tzOffsetHours(lokasi ? tzByOffice.get(lokasi) : undefined);

  // Langganan push: dimuat sekali per usaha untuk user yang dibutuhkan.
  const subsByUser = new Map<string, any[]>();
  async function loadSubs(userIds: string[]) {
    const need = [...new Set(userIds)].filter(u => !subsByUser.has(u));
    const rows = await inChunks(need, chunk => fetchAll(() => db.from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth").eq("tenant_id", tenantId).in("user_id", chunk).order("id")));
    for (const u of need) subsByUser.set(u, []);
    for (const r of rows) subsByUser.get(r.user_id)!.push(r);
  }

  // Kirim ke semua device; bersihkan endpoint kedaluwarsa. true = minimal satu berhasil.
  async function sendToUser(userId: string, payload: string): Promise<boolean> {
    let any = false;
    for (const sub of subsByUser.get(userId) || []) {
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        any = true;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await db.from("push_subscriptions").delete().eq("id", sub.id).eq("tenant_id", tenantId);
        }
      }
    }
    return any;
  }

  // ---------------- A & C. sesi check-in yang masih terbuka ----------------
  // Diambil SEMUA dulu baru diproses: update flag saat memproses akan
  // mengubah hasil filter, jadi tidak boleh dipaging sambil mengubah.
  const openRows = await fetchAll(() => db.from("attendance")
    .select("id, user_id, date, checkout_reminder_sent_at, checkout_before_reminder_sent_at, profiles!inner(id, is_active, schedule_id, lokasi_kerja)")
    .eq("tenant_id", tenantId)
    .is("check_out", null)
    .or("checkout_reminder_sent_at.is.null,checkout_before_reminder_sent_at.is.null")
    .order("id"));

  type OutTask = { row: any; kind: "before" | "late"; endHHMM: string };
  const outTasks: OutTask[] = [];
  for (const row of openRows) {
    const profile = row.profiles;
    if (!profile?.is_active || !profile.schedule_id) continue;
    const day = dayMap.get(`${profile.schedule_id}:${dayOfWeekFromDateStr(row.date)}`);
    if (!day?.is_working_day || !day.end_time) continue;

    const offset = offsetOf(profile.lokasi_kerja);
    const endDateStr = day.crosses_midnight ? addDaysToDateStr(row.date, 1) : row.date;
    const [eh, em] = day.end_time.split(":").map(Number);
    const minutesSince = (now - zonedTimestampMs(endDateStr, eh, em, offset)) / 60000;
    const endHHMM = day.end_time.slice(0, 5);

    if (row.checkout_before_reminder_sent_at == null && -minutesSince <= BEFORE_REMINDER_MINUTES && -minutesSince > 0) {
      outTasks.push({ row, kind: "before", endHHMM });
    }
    if (row.checkout_reminder_sent_at == null && minutesSince >= REMINDER_DELAY_MINUTES && minutesSince <= REMINDER_WINDOW_MINUTES) {
      outTasks.push({ row, kind: "late", endHHMM });
    }
  }
  await loadSubs(outTasks.map(t => t.row.user_id));
  await pool(outTasks, CONCURRENCY, async ({ row, kind, endHHMM }) => {
    if (!(subsByUser.get(row.user_id) || []).length) return;
    const col = kind === "before" ? "checkout_before_reminder_sent_at" : "checkout_reminder_sent_at";
    // Klaim: hanya satu eksekusi yang berhasil mengisi kolom dari NULL.
    const { data: claimed, error } = await db.from("attendance")
      .update({ [col]: new Date().toISOString() })
      .eq("id", row.id).eq("tenant_id", tenantId).is(col, null).select("id");
    if (error || !claimed?.length) return;
    const payload = JSON.stringify(kind === "before"
      ? { title: "Sebentar lagi jam pulang", body: `Jam pulangmu ${endHHMM}, sebentar lagi. Jangan lupa check-out ya.`, url: "./app.html#absensi" }
      : { title: "Lupa check-out?", body: `Jam pulangmu sudah lewat (${endHHMM}) tapi belum ada check-out. Yuk absen pulang.`, url: "./app.html#absensi" });
    if (await sendToUser(row.user_id, payload)) {
      if (kind === "before") stats.checkout_before_sent++; else stats.checkout_sent++;
    } else {
      // tidak ada device yang menerima -> lepas klaim supaya bisa dicoba lagi
      await db.from("attendance").update({ [col]: null }).eq("id", row.id).eq("tenant_id", tenantId);
    }
  });

  // ---------------- B & D. karyawan yang belum check-in ----------------
  const profiles = await fetchAll(() => db.from("profiles")
    .select("id, schedule_id, lokasi_kerja")
    .eq("tenant_id", tenantId).eq("is_active", true).not("schedule_id", "is", null).order("id"));

  type InCand = { profile: any; todayStr: string; startHHMM: string; before: boolean; late: boolean };
  const cands: InCand[] = [];
  for (const profile of profiles) {
    const offset = offsetOf(profile.lokasi_kerja);
    const todayStr = todayInOffset(offset, now);
    const day = dayMap.get(`${profile.schedule_id}:${dayOfWeekFromDateStr(todayStr)}`);
    if (!day?.is_working_day || !day.start_time) continue;
    const [sh, sm] = day.start_time.split(":").map(Number);
    const minutesSince = (now - zonedTimestampMs(todayStr, sh, sm, offset)) / 60000;
    const before = -minutesSince <= BEFORE_REMINDER_MINUTES && -minutesSince > 0;
    const late = minutesSince >= REMINDER_DELAY_MINUTES && minutesSince <= REMINDER_WINDOW_MINUTES;
    if (before || late) cands.push({ profile, todayStr, startHHMM: day.start_time.slice(0, 5), before, late });
  }

  if (cands.length) {
    const ids = cands.map(c => c.profile.id);
    const dates = [...new Set(cands.map(c => c.todayStr))];
    const keyOf = (u: string, d: string) => `${u}|${d}`;

    const attRows = await inChunks(ids, chunk => fetchAll(() => db.from("attendance")
      .select("user_id, date").eq("tenant_id", tenantId).in("user_id", chunk).in("date", dates).order("user_id").order("date")));
    const hasAtt = new Set(attRows.map(r => keyOf(r.user_id, r.date)));

    const beforeLog = await inChunks(ids, chunk => fetchAll(() => db.from("checkin_before_reminder_sent")
      .select("user_id, date").eq("tenant_id", tenantId).in("user_id", chunk).in("date", dates).order("user_id").order("date")));
    const lateLog = await inChunks(ids, chunk => fetchAll(() => db.from("checkin_reminders_sent")
      .select("user_id, date").eq("tenant_id", tenantId).in("user_id", chunk).in("date", dates).order("user_id").order("date")));
    const sentBefore = new Set(beforeLog.map(r => keyOf(r.user_id, r.date)));
    const sentLate = new Set(lateLog.map(r => keyOf(r.user_id, r.date)));

    const todo = cands.filter(c => !hasAtt.has(keyOf(c.profile.id, c.todayStr)));
    await loadSubs(todo.map(c => c.profile.id));

    await pool(todo, CONCURRENCY, async c => {
      const uid = c.profile.id;
      if (!(subsByUser.get(uid) || []).length) return;
      const k = keyOf(uid, c.todayStr);

      async function claimAndSend(table: string, payload: object): Promise<boolean> {
        // Klaim lewat INSERT (primary key user_id+date): yang kedua pasti bentrok -> tidak kirim dobel.
        const { error } = await db.from(table).insert({ tenant_id: tenantId, user_id: uid, date: c.todayStr });
        if (error) { if (!isDup(error)) console.error(`klaim ${table} gagal:`, error.message); return false; }
        if (await sendToUser(uid, JSON.stringify(payload))) return true;
        await db.from(table).delete().eq("tenant_id", tenantId).eq("user_id", uid).eq("date", c.todayStr);
        return false;
      }

      if (c.before && !sentBefore.has(k)) {
        const ok = await claimAndSend("checkin_before_reminder_sent", {
          title: "Sebentar lagi jam masuk",
          body: `Jadwalmu hari ini mulai jam ${c.startHHMM}, sebentar lagi. Jangan lupa check-in ya.`,
          url: "./app.html#absensi",
        });
        if (ok) stats.checkin_before_sent++;
      }
      if (c.late && !sentLate.has(k)) {
        const ok = await claimAndSend("checkin_reminders_sent", {
          title: "Belum check-in?",
          body: `Jadwalmu hari ini mulai jam ${c.startHHMM} dan belum ada check-in. Yuk segera absen masuk.`,
          url: "./app.html#absensi",
        });
        if (ok) stats.checkin_sent++;
      }
    });
  }

  return stats;
}

// ---- pilih usaha yang boleh diproses ----------------------------------
export async function eligibleTenants(db: Db): Promise<string[]> {
  const tenants = await fetchAll(() => db.from("tenants").select("id, status").neq("status", "suspended").order("id"));
  const settings = await fetchAll(() => db.from("push_settings").select("tenant_id, reminders_enabled").order("tenant_id"));
  // Tidak ada baris = pengingat dianggap menyala (sama seperti perilaku sebelum ada saklar).
  const off = new Set(settings.filter(s => s.reminders_enabled === false).map(s => s.tenant_id));
  return tenants.map(t => t.id).filter(id => !off.has(id));
}

if (import.meta.main) {
  Deno.serve(async _req => {
    try {
      const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      webpush.setVapidDetails(
        Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
        Deno.env.get("VAPID_PUBLIC_KEY")!,
        Deno.env.get("VAPID_PRIVATE_KEY")!,
      );
      const send = async (sub: any, payload: string) => { await webpush.sendNotification(sub, payload); };

      const started = Date.now();
      const now = Date.now();
      let ids = await eligibleTenants(db);

      // Putar urutan tiap slot 15 menit supaya, kalau waktu habis, usaha yang
      // sama tidak selalu jadi yang terakhir.
      if (ids.length > 1) {
        const shift = Math.floor(now / 900000) % ids.length;
        ids = [...ids.slice(shift), ...ids.slice(0, shift)];
      }

      const total = { checkout_sent: 0, checkin_sent: 0, checkout_before_sent: 0, checkin_before_sent: 0 };
      const errors: { tenant_id: string; error: string }[] = [];
      let processed = 0;
      for (const id of ids) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        try {
          const s = await processTenant(db, send, id, now);
          for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
        } catch (e) {
          console.error(`usaha ${id} gagal:`, e);
          errors.push({ tenant_id: id, error: String((e as any)?.message ?? e) });
        }
        processed++;
      }

      return new Response(JSON.stringify({
        ...total, tenants_total: ids.length, tenants_processed: processed,
        tenants_skipped_time: ids.length - processed, errors,
      }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  });
}
