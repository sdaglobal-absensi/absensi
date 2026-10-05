// Edge Function: retention-cleanup
// -----------------------------------------------------------------------
// Menghapus FOTO absensi yang lebih tua dari masa simpan tiap usaha
// (data_retention_settings.photo_retention_months) — file di Storage dihapus
// lewat API Storage (bukan SQL) dan kolom *_photo_url dikosongkan. Data
// absensi (jam, status, jarak) TIDAK dihapus.
//
// Deploy : supabase functions deploy retention-cleanup --no-verify-jwt
// Rahasia: supabase secrets set CRON_SECRET=<string acak panjang>
// Jadwal : sekali sehari lewat pg_cron/pg_net atau Scheduled Function dengan
//          header `x-cron-secret: <CRON_SECRET>`. Contoh (SQL Editor):
//   select cron.schedule('retention-cleanup', '0 19 * * *', $$
//     select net.http_post(
//       url := 'https://<project>.supabase.co/functions/v1/retention-cleanup',
//       headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'Content-Type', 'application/json'),
//       body := '{}'::jsonb) $$);
// -----------------------------------------------------------------------
import { adminClient, enterCors, HttpError, json } from "../_shared/common.ts";

const BUCKET = "attendance-photos";
const BATCH = 200;
const MAX_BATCHES_PER_TENANT = 25; // batasi waktu eksekusi; sisa diproses esok hari

Deno.serve(async req => {
  const cors = enterCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method tidak didukung" }, 405);
  try {
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "Tidak diizinkan");

    const admin = adminClient();
    const { data: settings, error } = await admin
      .from("data_retention_settings").select("tenant_id, photo_retention_months")
      .not("photo_retention_months", "is", null);
    if (error) throw error;

    const summary: Record<string, number> = {};
    for (const s of settings ?? []) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - s.photo_retention_months);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      let removed = 0;

      for (let i = 0; i < MAX_BATCHES_PER_TENANT; i++) {
        const { data: rows, error: e1 } = await admin.from("attendance")
          .select("id, check_in_photo_url, check_out_photo_url")
          .eq("tenant_id", s.tenant_id).lt("date", cutoffDate)
          .or("check_in_photo_url.not.is.null,check_out_photo_url.not.is.null")
          .limit(BATCH);
        if (e1) { console.error("retention select:", e1.message); break; }
        if (!rows?.length) break;

        // Yang tersimpan adalah PATH di bucket privat (Tahap 3); abaikan nilai URL lama.
        const paths = rows.flatMap(r => [r.check_in_photo_url, r.check_out_photo_url])
          .filter((p): p is string => !!p && !p.startsWith("http"));
        if (paths.length) {
          const { error: e2 } = await admin.storage.from(BUCKET).remove(paths);
          if (e2) { console.error("retention remove:", e2.message); break; } // jangan kosongkan kolom bila file gagal dihapus
        }
        const { error: e3 } = await admin.from("attendance")
          .update({ check_in_photo_url: null, check_out_photo_url: null })
          .in("id", rows.map(r => r.id));
        if (e3) { console.error("retention update:", e3.message); break; }
        removed += rows.length;
        if (rows.length < BATCH) break;
      }
      summary[s.tenant_id] = removed;
    }
    return json({ ok: true, rows_cleared: summary });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("retention-cleanup error:", e);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
});
