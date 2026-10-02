// Helper bersama untuk Edge Function account-admin & login-pin.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

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

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
