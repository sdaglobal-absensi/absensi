// ===== common.ts (digabung supaya bisa ditempel di editor Dashboard) =====
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

// ===== login-pin =====
// Edge Function: login-pin
// -----------------------------------------------------------------------
// Login karyawan TANPA email: kode usaha + kode karyawan + PIN (6 digit).
// Publik (tidak butuh login). Mengembalikan sesi Supabase biasa yang lalu
// dipasang di browser lewat supabase.auth.setSession().
//
// Anti tebak-tebakan: 5 kali salah berturut-turut untuk pasangan
// (kode usaha, kode karyawan) mengunci 15 menit. Penguncian dihitung per
// akun, jadi penyerang tidak bisa menebak 1.000.000 PIN. Admin bisa
// membuka kunci dengan mereset PIN (aksi reset-pin di account-admin).
//
// Deploy: supabase functions deploy login-pin --no-verify-jwt
// -----------------------------------------------------------------------
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const GENERIC = "Kode usaha, kode karyawan, atau PIN salah.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method tidak didukung" }, 405);

  try {
    let b: Record<string, unknown>;
    try { b = await req.json(); } catch { throw new HttpError(400, "Body bukan JSON yang valid"); }

    const kodeUsaha = normKode(b.kode_usaha).toLowerCase();
    const kodeKaryawan = normKode(b.kode_karyawan);
    const pin = normKode(b.pin);
    const captchaToken = typeof b.captcha_token === "string" && b.captcha_token ? b.captcha_token : undefined;
    if (!kodeUsaha || !kodeKaryawan || !/^\d{6}$/.test(pin)) throw new HttpError(400, "Lengkapi kode usaha, kode karyawan, dan PIN 6 digit.");
    if (kodeUsaha.length > 40 || kodeKaryawan.length > 40) throw new HttpError(400, GENERIC);

    const admin = adminClient();
    const key = `${kodeUsaha}|${kodeKaryawan.toLowerCase()}`;

    // 1) Sedang terkunci?
    const { data: att } = await admin.from("pin_login_attempts").select("fail_count, locked_until").eq("key", key).maybeSingle();
    if (att?.locked_until && new Date(att.locked_until) > new Date()) {
      const sisa = Math.ceil((new Date(att.locked_until).getTime() - Date.now()) / 60000);
      throw new HttpError(429, `Terlalu banyak percobaan salah. Coba lagi ${sisa} menit lagi, atau minta admin mereset PIN.`);
    }

    // 2) Cari akun (semua kegagalan memakai pesan yang sama + dihitung)
    const ok = await tryLogin(admin, kodeUsaha, kodeKaryawan, pin, captchaToken);
    if (!ok) {
      const fails = (att?.fail_count ?? 0) + 1;
      const locked = fails >= MAX_FAIL;
      await admin.from("pin_login_attempts").upsert({
        key, fail_count: locked ? 0 : fails,
        locked_until: locked ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
        updated_at: new Date().toISOString(),
      });
      if (locked) throw new HttpError(429, `Terlalu banyak percobaan salah. Akun dikunci ${LOCK_MINUTES} menit.`);
      throw new HttpError(401, GENERIC);
    }

    await admin.from("pin_login_attempts").delete().eq("key", key);
    return json({ session: ok });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("login-pin error:", e);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
});

// Mengembalikan { access_token, refresh_token } kalau cocok, selain itu null.
async function tryLogin(admin: ReturnType<typeof adminClient>, kodeUsaha: string, kodeKaryawan: string, pin: string, captchaToken?: string) {
  const { data: tn } = await admin.from("tenants").select("id, status").ilike("kode", escapeLike(kodeUsaha)).maybeSingle();
  if (!tn || tn.status === "suspended") return null;

  const { data: p } = await admin.from("profiles").select("id, login_type, is_active")
    .eq("tenant_id", tn.id).ilike("employee_code", escapeLike(kodeKaryawan)).maybeSingle();
  if (!p || p.login_type !== "pin" || !p.is_active) return null;

  const { data: au } = await admin.auth.admin.getUserById(p.id);
  if (!au?.user?.email) return null;

  const password = await derivePinPassword(p.id, pin);
  const { data, error } = await anonClient().auth.signInWithPassword({ email: au.user.email, password, options: { captchaToken } });
  if (error || !data.session) return null;
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, m => "\\" + m);
}
