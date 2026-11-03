// Memuat data kehadiran SATU tanggal dan menyusunnya jadi baris status per karyawan
// (aturan di js/laporanHarian.js). Dipakai bersama oleh Laporan Harian dan rekap
// Laporan Aktivitas supaya definisi "karyawan terjadwal / wajib hadir" selalu sama.
import { supabase } from "./supabaseClient.js";
import { dayOfWeekFromDateStr, fetchAllRows } from "./core.js";
import { fetchSpecialLeaveRules } from "./leaveRules.js";
import { buildDailyRows } from "./laporanHarian.js";

// Melempar error kalau data utama gagal dimuat (profil/absensi); tabel opsional
// (tukar shift, riwayat jadwal) yang belum ada dianggap kosong.
export async function fetchDailyContext(date, today) {
  const dow = dayOfWeekFromDateStr(date);
  const [emps, att, daysRes, leavesRes, ovrRes, holRes, histRes, schedRes, rules] = await Promise.all([
    fetchAllRows(() => supabase.from("profiles")
      .select("id, full_name, employee_code, department, position, jenis_hubungan_kerja, unit_pt, schedule_id, join_date, resign_date")
      .eq("is_active", true).order("full_name")),
    fetchAllRows(() => supabase.from("attendance")
      .select("user_id, check_in, check_out, check_in_status, work_mode, notes").eq("date", date).order("user_id")),
    supabase.from("work_schedule_days").select("schedule_id, is_working_day, start_time, end_time, crosses_midnight").eq("day_of_week", dow),
    supabase.from("leave_requests")
      .select("user_id, type, leave_category, special_leave_code, status")
      .in("status", ["pending", "approved"]).lte("start_date", date).gte("end_date", date),
    supabase.from("schedule_overrides").select("user_id, schedule_id").eq("work_date", date),   // tukar shift (opsional)
    supabase.from("holidays").select("name").eq("date", date).eq("is_active", true).limit(1),
    supabase.from("employee_schedule_history").select("user_id, schedule_id, effective_from").order("effective_from", { ascending: true }), // opsional
    supabase.from("work_schedules").select("id, name"),
    fetchSpecialLeaveRules().catch(() => []),
  ]);

  const days = new Map((daysRes.data || []).map(d => [d.schedule_id, d]));
  const hist = {};
  (histRes.error ? [] : histRes.data || []).forEach(h => { (hist[h.user_id] ||= []).push(h); });
  const ovr = new Map((ovrRes.error ? [] : ovrRes.data || []).map(o => [o.user_id, o.schedule_id]));
  const holiday = holRes.data?.[0] || null;

  const { rows, tanpaJadwal } = buildDailyRows({ date, today, emps, att, leaves: leavesRes.error ? [] : leavesRes.data || [], hist, ovr, days, holiday });
  return {
    rows, tanpaJadwal, holiday, emps, rules: rules || [],
    scheduleName: Object.fromEntries((schedRes.data || []).map(s => [s.id, s.name])),
  };
}
