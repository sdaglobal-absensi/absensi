// Edge Function: billing
// -----------------------------------------------------------------------
// Pemilik usaha (Super Admin) membeli / memperpanjang paket lewat Midtrans Snap.
//
// Aksi (body JSON: { action, ... }):
//   create-order : { plan, period: "monthly"|"yearly" }
//       -> { order_code, snap_token, redirect_url, client_key, snap_js, amount, reused }
//   config       : {} -> { client_key, snap_js }  (untuk "Lanjut bayar" tanpa membuat pesanan baru)
//   sync-order   : { order_code }
//       -> { status }   Tanya status ke Midtrans lalu terapkan. Dipanggil
//          browser setelah popup Snap ditutup, jadi paket langsung aktif
//          walau webhook terlambat.
//
// Keamanan:
//   - Pemanggil WAJIB login dan berperan super_admin. Tenant diambil dari
//     PROFIL di database, tidak pernah dari body.
//   - Harga dibaca dari tabel plans di server; klien hanya memilih paket + periode.
//
// Deploy (--no-verify-jwt: kunci "sb_publishable_..." bukan JWT; token diverifikasi di sini):
//   supabase functions deploy billing --no-verify-jwt
//   supabase secrets set MIDTRANS_SERVER_KEY=... MIDTRANS_CLIENT_KEY=... MIDTRANS_ENV=sandbox
// -----------------------------------------------------------------------
import { adminClient, anonClient, enterCors, HttpError, json } from "../_shared/common.ts";
import {
  applyTransaction, basicAuth, CLIENT_KEY, fetchStatus, requireConfig, SNAP_JS, SNAP_URL,
} from "../_shared/midtrans.ts";

type Caller = { id: string; tenant_id: string; full_name: string; email: string | null };

Deno.serve(async (req) => {
  const cors = enterCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method tidak didukung" }, 405);

  try {
    requireConfig();
    const admin = adminClient();
    const caller = await authenticate(req, admin);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { throw new HttpError(400, "Body bukan JSON yang valid"); }

    switch (body.action) {
      case "config":       return json({ client_key: CLIENT_KEY, snap_js: SNAP_JS });
      case "create-order": return json(await createOrder(admin, caller, body));
      case "sync-order":   return json(await syncOrder(admin, caller, body));
      default: throw new HttpError(400, "Aksi tidak dikenal");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("billing error:", e);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
});

async function authenticate(req: Request, admin: ReturnType<typeof adminClient>): Promise<Caller> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Belum login");

  const { data: u, error: uErr } = await anonClient().auth.getUser(token);
  if (uErr || !u.user) throw new HttpError(401, "Sesi tidak valid, silakan login ulang");

  const { data: p } = await admin.from("profiles")
    .select("id, tenant_id, role, is_active, full_name").eq("id", u.user.id).maybeSingle();
  if (!p || !p.is_active) throw new HttpError(403, "Akun tidak aktif atau belum terdaftar di sebuah usaha");
  if (p.role !== "super_admin") throw new HttpError(403, "Hanya Pemilik (Super Admin) yang bisa mengelola langganan");

  const { data: t } = await admin.from("tenants").select("status").eq("id", p.tenant_id).maybeSingle();
  if (!t || t.status === "suspended") throw new HttpError(403, "Usaha ini sedang dinonaktifkan");

  return { id: p.id, tenant_id: p.tenant_id, full_name: p.full_name ?? "Pemilik", email: u.user.email ?? null };
}

async function createOrder(admin: ReturnType<typeof adminClient>, caller: Caller, body: Record<string, unknown>) {
  const plan = String(body.plan ?? "");
  const period = String(body.period ?? "");

  const { data: o, error } = await admin.rpc("billing_new_order", {
    p_tenant: caller.tenant_id, p_user: caller.id, p_plan: plan, p_period: period,
  });
  if (error) throw new HttpError(400, error.message);   // pesan SQL sudah berbahasa Indonesia
  const order = o as {
    order_code: string; amount: number; plan_nama: string; period: string;
    snap_token: string | null; redirect_url: string | null; reused: boolean;
  };

  if (order.snap_token) {
    return {
      order_code: order.order_code, snap_token: order.snap_token, redirect_url: order.redirect_url,
      amount: order.amount, reused: true, client_key: CLIENT_KEY, snap_js: SNAP_JS,
    };
  }

  const itemName = `Kerjora ${order.plan_nama} - ${order.period === "yearly" ? "1 tahun" : "1 bulan"}`.slice(0, 50);
  const customer: Record<string, string> = { first_name: caller.full_name.slice(0, 100) };
  if (caller.email && !caller.email.endsWith(".invalid")) customer.email = caller.email;

  const res = await fetch(SNAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: basicAuth() },
    body: JSON.stringify({
      transaction_details: { order_id: order.order_code, gross_amount: order.amount },
      item_details: [{ id: plan, price: order.amount, quantity: 1, name: itemName }],
      customer_details: customer,
      expiry: { unit: "hours", duration: 24 },
    }),
  });
  let snap: { token?: string; redirect_url?: string; error_messages?: string[] } = {};
  try { snap = await res.json(); } catch { /* bukan JSON */ }
  if (!res.ok || !snap.token) {
    console.error("midtrans snap gagal:", res.status, JSON.stringify(snap));
    throw new HttpError(502, "Gagal membuat tagihan di Midtrans" + (snap.error_messages?.length ? `: ${snap.error_messages.join("; ")}` : "."));
  }

  await admin.rpc("billing_attach_snap", { p_order: order.order_code, p_token: snap.token, p_url: snap.redirect_url ?? null });
  return {
    order_code: order.order_code, snap_token: snap.token, redirect_url: snap.redirect_url ?? null,
    amount: order.amount, reused: false, client_key: CLIENT_KEY, snap_js: SNAP_JS,
  };
}

async function syncOrder(admin: ReturnType<typeof adminClient>, caller: Caller, body: Record<string, unknown>) {
  const code = String(body.order_code ?? "");
  const { data: order } = await admin.from("billing_orders")
    .select("order_code, tenant_id, status").eq("order_code", code).maybeSingle();
  // Pesan sama untuk "tidak ada" dan "milik usaha lain", supaya tidak bisa dipakai menebak kode.
  if (!order || order.tenant_id !== caller.tenant_id) throw new HttpError(404, "Pesanan tidak ditemukan");
  if (order.status === "paid") return { status: "paid" };

  const tx = await fetchStatus(code);
  if (!tx) return { status: order.status };
  const result = await applyTransaction(admin, tx);
  return { status: "status" in result ? result.status : order.status };
}
