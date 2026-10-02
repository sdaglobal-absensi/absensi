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

// ===== account-admin =====
// Edge Function: account-admin
// -----------------------------------------------------------------------
// Satu-satunya jalan resmi membuat / mengelola akun karyawan (menggantikan
// auth.signUp dari browser admin, yang tidak bisa menempatkan akun ke
// tenant yang benar).
//
// Aksi (body JSON: { action, ... }):
//   create-employee : buat akun karyawan baru di tenant si pemanggil.
//       { employee_code, full_name, login_type: "email"|"pin",
//         email?, password?  (login_type=email)
//         pin?               (login_type=pin; kosong = dibuatkan acak) }
//   reset-pin       : { user_id, pin? } -> PIN baru untuk akun PIN.
//
// Keamanan:
//   - Pemanggil WAJIB login. Tenant diambil dari PROFIL pemanggil di
//     database, TIDAK PERNAH dari body request.
//   - Pemanggil harus Super Admin, atau role dengan menu "karyawan"
//     menyala di Pengaturan Sistem (aturan yang sama dengan Data Karyawan).
//   - Role akun baru selalu 'karyawan' (diubah lewat Struktur Organisasi).
//
// Deploy (wajib --no-verify-jwt karena kunci "sb_publishable_..." bukan JWT;
// function ini memverifikasi token sendiri di bawah):
//   supabase functions deploy account-admin --no-verify-jwt
//   supabase secrets set PIN_PEPPER=<string-acak-panjang>
// -----------------------------------------------------------------------
const STAFF_ROLES = ["super_admin", "super_admin_hr", "admin_hr"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method tidak didukung" }, 405);

  try {
    const admin = adminClient();
    const caller = await authenticate(req, admin);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { throw new HttpError(400, "Body bukan JSON yang valid"); }

    switch (body.action) {
      case "create-employee": return json(await createEmployee(admin, caller, body));
      case "reset-pin":       return json(await resetPin(admin, caller, body));
      default: throw new HttpError(400, "Aksi tidak dikenal");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("account-admin error:", e);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
});

type Caller = { id: string; tenant_id: string; role: string };

// Verifikasi token, ambil profil, pastikan boleh mengelola karyawan.
async function authenticate(req: Request, admin: ReturnType<typeof adminClient>): Promise<Caller> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Belum login");

  const { data: u, error: uErr } = await anonClient().auth.getUser(token);
  if (uErr || !u.user) throw new HttpError(401, "Sesi tidak valid, silakan login ulang");

  const { data: p } = await admin.from("profiles")
    .select("id, tenant_id, role, is_active").eq("id", u.user.id).maybeSingle();
  if (!p || !p.is_active) throw new HttpError(403, "Akun tidak aktif atau belum terdaftar di sebuah usaha");

  const { data: t } = await admin.from("tenants").select("status").eq("id", p.tenant_id).maybeSingle();
  if (!t || t.status === "suspended") throw new HttpError(403, "Usaha ini sedang dinonaktifkan");

  if (p.role !== "super_admin") {
    if (!STAFF_ROLES.includes(p.role)) throw new HttpError(403, "Tidak punya akses mengelola karyawan");
    const { data: rp } = await admin.from("role_permissions").select("enabled")
      .eq("tenant_id", p.tenant_id).eq("role", p.role).eq("menu_id", "karyawan").maybeSingle();
    if (!rp?.enabled) throw new HttpError(403, "Menu Data Karyawan belum diizinkan untuk role kamu");
  }
  return { id: p.id, tenant_id: p.tenant_id, role: p.role };
}

async function createEmployee(admin: ReturnType<typeof adminClient>, caller: Caller, b: Record<string, unknown>) {
  const code = normKode(b.employee_code);
  const fullName = normKode(b.full_name);
  const loginType = b.login_type === "pin" ? "pin" : "email";
  if (!code) throw new HttpError(400, "Kode Karyawan wajib diisi");
  if (code.length > 40) throw new HttpError(400, "Kode Karyawan terlalu panjang (maks. 40 karakter)");
  if (!fullName) throw new HttpError(400, "Nama Lengkap wajib diisi");

  // Kode karyawan unik per usaha (tanpa membedakan huruf besar/kecil)
  const { data: dup } = await admin.from("profiles").select("id")
    .eq("tenant_id", caller.tenant_id).ilike("employee_code", escapeLike(code)).limit(1);
  if (dup && dup.length) throw new HttpError(409, `Kode Karyawan "${code}" sudah dipakai di usaha ini`);

  // Batas jumlah karyawan paket
  const { data: tn } = await admin.from("tenants").select("max_karyawan").eq("id", caller.tenant_id).single();
  if (tn?.max_karyawan) {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true })
      .eq("tenant_id", caller.tenant_id);
    if ((count ?? 0) >= tn.max_karyawan) {
      throw new HttpError(403, `Batas jumlah karyawan untuk paket ini sudah tercapai (maks. ${tn.max_karyawan}).`);
    }
  }

  const appMeta = { tenant_id: caller.tenant_id, login_type: loginType };
  const userMeta = { full_name: fullName, employee_code: code };

  // ---------- akun email ----------
  if (loginType === "email") {
    const email = normKode(b.email).toLowerCase();
    const password = String(b.password ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Format email tidak valid");
    if (password.length < 6) throw new HttpError(400, "Password minimal 6 karakter");

    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: userMeta, app_metadata: appMeta,
    });
    if (error || !data.user) {
      if (/already|registered|exists/i.test(error?.message ?? "")) throw new HttpError(409, "Email sudah terdaftar di sistem login");
      throw new HttpError(400, error?.message || "Gagal membuat akun");
    }
    await assertProfile(admin, data.user.id);
    await audit(admin, caller, "account.create", data.user.id,
      `Membuat akun karyawan ${code} — ${fullName} (login email)`, { employee_code: code, full_name: fullName, login_type: "email" });
    return { user_id: data.user.id, login_type: "email", email };
  }

  // ---------- akun PIN ----------
  let pin = normKode(b.pin);
  if (pin && !isValidPin(pin)) throw new HttpError(400, "PIN harus 6 digit angka dan tidak boleh pola mudah ditebak (mis. 123456, 111111)");
  if (!pin) pin = generatePin();

  const placeholderEmail = `u-${crypto.randomUUID()}@${PIN_EMAIL_DOMAIN}`;
  const { data, error } = await admin.auth.admin.createUser({
    email: placeholderEmail, password: crypto.randomUUID() + crypto.randomUUID(),
    email_confirm: true, user_metadata: userMeta, app_metadata: appMeta,
  });
  if (error || !data.user) throw new HttpError(400, error?.message || "Gagal membuat akun");
  const uid = data.user.id;

  try {
    await assertProfile(admin, uid);
    const pw = await derivePinPassword(uid, pin);
    const { error: pwErr } = await admin.auth.admin.updateUserById(uid, { password: pw });
    if (pwErr) throw new HttpError(500, "Gagal menyimpan PIN: " + pwErr.message);
    const { error: pErr } = await admin.from("profiles").update({ login_type: "pin", email: null }).eq("id", uid);
    if (pErr) throw new HttpError(500, "Gagal menandai akun PIN: " + pErr.message);
  } catch (e) {
    await admin.auth.admin.deleteUser(uid).catch(() => {}); // batalkan akun setengah jadi
    throw e;
  }
  await audit(admin, caller, "account.create", uid,
    `Membuat akun karyawan ${code} — ${fullName} (login PIN)`, { employee_code: code, full_name: fullName, login_type: "pin" });
  return { user_id: uid, login_type: "pin", pin };
}

// Catat ke audit_log (Tahap 3). Sengaja TIDAK pernah menyimpan PIN/password.
// Gagal mencatat tidak boleh menggagalkan pembuatan akun, jadi hanya di-log.
async function audit(
  admin: ReturnType<typeof adminClient>, caller: Caller, action: string,
  recordId: string, summary: string, data?: Record<string, unknown>,
) {
  try {
    const { error } = await admin.rpc("audit_write", {
      p_tenant: caller.tenant_id, p_actor: caller.id, p_action: action,
      p_table: "profiles", p_record: recordId, p_summary: summary, p_data: data ?? null,
    });
    if (error) console.error("audit_write gagal:", error.message);
  } catch (e) {
    console.error("audit_write error:", e);
  }
}

// Pastikan trigger handle_new_user benar-benar membuat profil di tenant yang benar.
async function assertProfile(admin: ReturnType<typeof adminClient>, uid: string) {
  const { data } = await admin.from("profiles").select("id").eq("id", uid).maybeSingle();
  if (!data) {
    await admin.auth.admin.deleteUser(uid).catch(() => {});
    throw new HttpError(500, "Profil karyawan tidak terbentuk (cek bahwa 001_multi_tenant.sql sudah dijalankan)");
  }
}

async function resetPin(admin: ReturnType<typeof adminClient>, caller: Caller, b: Record<string, unknown>) {
  const userId = normKode(b.user_id);
  if (!userId) throw new HttpError(400, "user_id wajib diisi");

  const { data: target } = await admin.from("profiles")
    .select("id, tenant_id, role, login_type, employee_code").eq("id", userId).maybeSingle();
  // Tenant lain diperlakukan seperti "tidak ada" (tidak membocorkan keberadaan akun)
  if (!target || target.tenant_id !== caller.tenant_id) throw new HttpError(404, "Karyawan tidak ditemukan");
  if (target.login_type !== "pin") throw new HttpError(400, "Akun ini memakai email & password, bukan PIN");
  if (target.role === "super_admin" && caller.role !== "super_admin") throw new HttpError(403, "Tidak boleh mengubah akun Super Admin");

  let pin = normKode(b.pin);
  if (pin && !isValidPin(pin)) throw new HttpError(400, "PIN harus 6 digit angka dan tidak boleh pola mudah ditebak");
  if (!pin) pin = generatePin();

  const pw = await derivePinPassword(userId, pin);
  const { error } = await admin.auth.admin.updateUserById(userId, { password: pw });
  if (error) throw new HttpError(500, "Gagal mengganti PIN: " + error.message);

  // Buka kunci kalau sebelumnya terkunci karena salah PIN
  const { data: tn } = await admin.from("tenants").select("kode").eq("id", caller.tenant_id).single();
  if (tn && target.employee_code) {
    await admin.from("pin_login_attempts").delete()
      .eq("key", `${tn.kode.toLowerCase()}|${target.employee_code.toLowerCase()}`);
  }
  await audit(admin, caller, "account.reset_pin", userId,
    `Reset PIN karyawan ${target.employee_code ?? userId}`, { employee_code: target.employee_code ?? null });
  return { user_id: userId, pin };
}

// Escape karakter wildcard LIKE supaya "_" dan "%" di kode karyawan dibaca apa adanya.
function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, m => "\\" + m);
}
