// Edge Function: midtrans-webhook
// -----------------------------------------------------------------------
// Penerima notifikasi pembayaran Midtrans (HTTP Notification).
//
// Pengamanan berlapis:
//   1. signature_key diperiksa (SHA512 dengan Server Key).
//   2. Status ditanyakan ULANG ke API Midtrans; yang dipakai adalah jawaban
//      Midtrans, bukan isi request.
//   3. Nominal dicocokkan dengan pesanan di database.
//   4. billing_apply_payment() idempoten: notifikasi dobel tidak
//      memperpanjang paket dua kali.
//
// Deploy (wajib --no-verify-jwt; Midtrans tidak membawa token Supabase):
//   supabase functions deploy midtrans-webhook --no-verify-jwt
// Lalu isi di Dashboard Midtrans > Settings > Configuration:
//   Payment Notification URL = https://<project-ref>.supabase.co/functions/v1/midtrans-webhook
// -----------------------------------------------------------------------
import { adminClient, corsHeaders, HttpError, json } from "../_shared/common.ts";
import { applyTransaction, fetchStatus, requireConfig, signatureValid } from "../_shared/midtrans.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method tidak didukung" }, 405);

  try {
    requireConfig();
    let n: Record<string, string>;
    try { n = await req.json(); } catch { throw new HttpError(400, "Body bukan JSON yang valid"); }

    if (!(await signatureValid(n))) throw new HttpError(401, "Signature tidak valid");

    // Notifikasi uji dari dashboard Midtrans memakai order_id palsu: jawab 200 saja.
    const tx = await fetchStatus(n.order_id);
    if (!tx) return json({ ok: true, ignored: "transaksi belum ada di Midtrans" });
    if (tx.order_id !== n.order_id) throw new HttpError(400, "order_id tidak konsisten");

    const result = await applyTransaction(adminClient(), tx);
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("midtrans-webhook error:", e);
    return json({ error: "Terjadi kesalahan di server" }, 500); // 5xx => Midtrans mengirim ulang
  }
});
