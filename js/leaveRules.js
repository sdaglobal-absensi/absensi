import { supabase } from "./supabaseClient.js";

// =======================================================================
// Helper bersama untuk fitur Cuti Tahunan & Cuti Khusus — dipakai oleh
// Pengajuan Izin (karyawan), Approval Izin (admin), dan Kuota Cuti Tahunan
// (admin). Master 7 jenis cuti khusus ada di tabel special_leave_rules;
// saldo Cuti Tahunan per karyawan per tahun ada di leave_balances.
// =======================================================================

let cachedRules = null;

export async function fetchSpecialLeaveRules() {
  if (cachedRules) return cachedRules;
  const { data, error } = await supabase.from("special_leave_rules").select("*").order("sort_order");
  cachedRules = error ? [] : (data || []);
  return cachedRules;
}

export function invalidateSpecialLeaveRulesCache() {
  cachedRules = null;
}

export async function fetchMyLeaveBalance(userId, year = new Date().getFullYear()) {
  const { data, error } = await supabase
    .from("leave_balances")
    .select("*")
    .eq("user_id", userId)
    .eq("tahun", year)
    .maybeSingle();
  return error ? null : data;
}

// Tanggal "YYYY-MM-DD" + n hari (murni angka Y/M/D, tidak menyentuh timezone).
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function leaveCategoryLabel(cat) {
  return { tahunan: "Cuti Tahunan", khusus: "Cuti Khusus" }[cat] || cat;
}

// Label jenis pengajuan untuk ditampilkan (Pengajuan Izin & Approval Izin).
//   r     : baris leave_requests
//   rules : hasil fetchSpecialLeaveRules() (untuk melabeli special_leave_code)
export function leaveTypeLabel(r, rules) {
  if (r.type === "izin") return "Izin Tidak Masuk";
  if (r.type === "sakit") return "Sakit";
  if (r.type !== "cuti") return r.type;
  if (r.leave_category === "khusus") {
    const rule = (rules || []).find(x => x.kode === r.special_leave_code);
    return `Cuti Khusus${rule ? " — " + rule.label : ""}`;
  }
  if (r.leave_category === "tahunan") return "Cuti Tahunan";
  return "Cuti";
}
