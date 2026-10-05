// Helper bersama untuk Edge Function account-admin & login-pin.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Rahasia server untuk menurunkan password akun PIN. WAJIB diisi:
//   supabase secrets set PIN_PEPPER=<string acak panjang>
// JANGAN diganti setelah ada akun PIN (semua PIN akan tidak bisa dipakai).
const PIN_PEPPER = Deno.env.get("PIN_PEPPER") ?? "";
// Domain email palsu untuk akun PIN. ".invalid" dijamin tidak pernah
// bisa dikirimi email. Kalau Supabase menolaknya, ganti lewat secret.
export const PIN_EMAIL_DOMAIN = Deno.env.get("PIN_EMAIL_DOMAIN") ?? "pin.kerjora.invalid";

// Origin yang diizinkan memanggil Edge Function. WAJIB diisi di produksi:
//   supabase secrets set ALLOWED_ORIGINS=https://app.contoh.com,https://contoh.com
// Kosong = hanya localhost (pengembangan). Tidak lagi "*".
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

export function corsFor(req?: Request): Record<string, string> {
  const origin = req?.headers.get("origin") ?? "";
  const dev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || dev);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (ALLOWED_ORIGINS[0] ?? "null"),
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// Origin request yang sedang diproses; diisi enterCors(req) di awal handler
// dan terbawa ke seluruh rantai async request itu (aman untuk request paralel).
const corsStore = new AsyncLocalStorage<Record<string, string>>();
export function enterCors(req: Request): Record<string, string> {
  const h = corsFor(req);
  corsStore.enterWith(h);
  return h;
}

// Header CORS untuk request yang sedang berjalan (default: tanpa wildcard).
export function currentCors(): Record<string, string> {
  return corsStore.getStore() ?? corsFor();
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...currentCors(), "Content-Type": "application/json" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

// Password asli akun PIN di Supabase Auth = HMAC(pepper, "<user_id>:<pin>").
// Karena pepper hanya ada di server, orang yang menebak langsung ke
// endpoint Auth Supabase tidak bisa memakai PIN mentah; satu-satunya
// pintu masuk adalah login-pin, yang punya batas percobaan.
export async function derivePinPassword(userId: string, pin: string): Promise<string> {
  if (PIN_PEPPER.length < 16) throw new HttpError(500, "Server belum dikonfigurasi (PIN_PEPPER).");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(PIN_PEPPER),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${userId}:${pin}`));
  return toHex(sig);
}

const WEAK_PINS = new Set(["123456", "654321", "123123", "112233", "121212", "000000", "111111", "222222",
  "333333", "444444", "555555", "666666", "777777", "888888", "999999", "012345", "234567", "345678", "456789"]);

export function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin) && !WEAK_PINS.has(pin);
}

export function generatePin(): string {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    const pin = String(n).padStart(6, "0");
    if (isValidPin(pin)) return pin;
  }
}

export const normKode = (s: unknown) => String(s ?? "").trim();
