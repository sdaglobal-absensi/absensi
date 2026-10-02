// Helper Midtrans untuk Edge Function billing & midtrans-webhook.
//
// Secrets (supabase secrets set ...):
//   MIDTRANS_SERVER_KEY  wajib   (Dashboard Midtrans > Settings > Access Keys)
//   MIDTRANS_CLIENT_KEY  wajib   (dipakai browser untuk memuat Snap)
//   MIDTRANS_ENV         "sandbox" (bawaan) atau "production"
import { adminClient, HttpError } from "./common.ts";

export const SERVER_KEY = Deno.env.get("MIDTRANS_SERVER_KEY") ?? "";
export const CLIENT_KEY = Deno.env.get("MIDTRANS_CLIENT_KEY") ?? "";
export const IS_PROD = (Deno.env.get("MIDTRANS_ENV") ?? "sandbox").toLowerCase() === "production";

export const SNAP_URL = IS_PROD
  ? "https://app.midtrans.com/snap/v1/transactions"
  : "https://app.sandbox.midtrans.com/snap/v1/transactions";
export const SNAP_JS = IS_PROD
  ? "https://app.midtrans.com/snap/snap.js"
  : "https://app.sandbox.midtrans.com/snap/snap.js";
const API_BASE = IS_PROD ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";

export function requireConfig() {
  if (!SERVER_KEY || !CLIENT_KEY) {
    throw new HttpError(500, "Pembayaran belum dikonfigurasi (MIDTRANS_SERVER_KEY / MIDTRANS_CLIENT_KEY).");
  }
}

export const basicAuth = () => "Basic " + btoa(SERVER_KEY + ":");

// Status transaksi dari Midtrans (sumber kebenaran; dipakai webhook dan sync-order).
// Return null kalau transaksi belum tercatat di Midtrans (pelanggan belum memilih metode bayar).
export async function fetchStatus(orderCode: string): Promise<Record<string, string> | null> {
  const res = await fetch(`${API_BASE}/v2/${encodeURIComponent(orderCode)}/status`, {
    headers: { Accept: "application/json", Authorization: basicAuth() },
  });
  let data: Record<string, string> = {};
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (res.status === 404 || data?.status_code === "404") return null;
  if (!res.ok) throw new HttpError(502, `Midtrans menolak permintaan status (${res.status}).`);
  return data;
}

// Midtrans -> status internal. null = abaikan (refund/chargeback ditangani manual).
export function mapStatus(tx: Record<string, string>): "paid" | "pending" | "failed" | "canceled" | "expired" | null {
  switch (tx.transaction_status) {
    case "settlement": return "paid";
    case "capture":    return tx.fraud_status === "accept" ? "paid" : "pending"; // challenge = tunggu review
    case "pending":    return "pending";
    case "deny":
    case "failure":    return "failed";
    case "cancel":     return "canceled";
    case "expire":     return "expired";
    default:           return null;
  }
}

async function sha512Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
export async function signatureValid(n: Record<string, string>): Promise<boolean> {
  if (!n.order_id || !n.status_code || !n.gross_amount || !n.signature_key) return false;
  const expected = await sha512Hex(n.order_id + n.status_code + n.gross_amount + SERVER_KEY);
  const given = String(n.signature_key).toLowerCase();
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Terapkan status transaksi ke database. Aman dipanggil berulang (SQL idempoten).
export async function applyTransaction(
  admin: ReturnType<typeof adminClient>, tx: Record<string, string>,
): Promise<{ status: string; applied: boolean } | { ignored: string }> {
  const code = tx.order_id;
  const { data: order } = await admin.from("billing_orders")
    .select("order_code, amount").eq("order_code", code).maybeSingle();
  if (!order) return { ignored: "pesanan tidak dikenal" };

  const mapped = mapStatus(tx);
  if (!mapped) return { ignored: `status ${tx.transaction_status} diabaikan` };

  // Nominal harus sama dengan pesanan kita (gross_amount berbentuk "149000.00").
  if (Math.round(parseFloat(tx.gross_amount)) !== order.amount) {
    console.error("billing: nominal tidak cocok", code, tx.gross_amount, order.amount);
    return { ignored: "nominal tidak cocok" };
  }

  const { data, error } = await admin.rpc("billing_apply_payment", {
    p_order: code,
    p_status: mapped,
    p_payment_type: tx.payment_type ?? null,
    // Waktu dari Midtrans tidak membawa zona waktu (WIB), jadi dibiarkan kosong: SQL memakai now().
    p_paid_at: null,
    p_payload: tx,
  });
  if (error) throw new HttpError(500, "Gagal menyimpan pembayaran: " + error.message);
  return data as { status: string; applied: boolean };
}
