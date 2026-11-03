// Aturan Laporan Kehadiran HARIAN — fungsi murni (tanpa database/DOM) supaya
// mudah dites. Dipakai oleh js/modules/laporan-harian.js.
//
// Untuk satu tanggal, tiap karyawan aktif mendapat SATU status:
//   hadir_tepat / hadir_telat : ada check-in (status mengikuti kolom check_in_status)
//   izin        : tidak check-in, tapi ada Izin/Cuti/Sakit yang DISETUJUI di hari kerjanya
//   libur       : bukan hari kerja menurut jadwalnya, atau hari libur (Master Hari Libur)
//   belum       : hari kerja, belum check-in, dan tanggalnya hari ini / belum lewat
//   tidak_hadir : hari kerja yang sudah lewat tanpa check-in & tanpa izin yang disetujui
//
// Sama seperti Monitor Absensi & Analitik HR:
//   - jadwal yang dipakai = tukar shift (schedule_overrides) > riwayat jadwal pada
//     TANGGAL itu > jadwal profil; karyawan tanpa jadwal tidak dilaporkan,
//   - karyawan yang belum masuk (join_date) / sudah resign (resign_date) pada tanggal itu
//     tidak dilaporkan.

export const STATUS_LABEL = {
  hadir_tepat: "Tepat waktu",
  hadir_telat: "Terlambat",
  izin: "Izin / Cuti / Sakit",
  libur: "Libur",
  belum: "Belum check-in",
  tidak_hadir: "Tidak hadir",
};

export const WORK_MODE_LABEL = { dinas_luar: "Dinas Luar", wfh: "WFH", kunjungan: "Kunjungan" };

// Jadwal yang berlaku pada TANGGAL tertentu (employee_schedule_history).
// Belum ada riwayat -> pakai profiles.schedule_id.
export function scheduleIdOn(histByUser, emp, date) {
  const hist = histByUser?.[emp.id];
  if (!hist || !hist.length) return emp.schedule_id || null;
  let id = null;
  for (const h of hist) { if (h.effective_from <= date) id = h.schedule_id; else break; } // urut naik
  return id;
}

export function addDaysISO(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function fmtDurasi(minutes) {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return "-";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h}j ${String(m).padStart(2, "0")}m`;
}

const hhmm = t => (t ? String(t).slice(0, 5) : "");

// emps   : profil aktif (id, join_date, resign_date, schedule_id, ...)
// att    : baris attendance untuk `date`
// leaves : leave_requests berstatus pending/approved yang mencakup `date`
// hist   : { [user_id]: [{ schedule_id, effective_from }] } urut naik
// ovr    : Map user_id -> schedule_id (tukar shift pada `date`)
// days   : Map schedule_id -> { is_working_day, start_time, end_time, crosses_midnight } untuk hari itu
// holiday: { name } | null
export function buildDailyRows({ date, today, emps, att = [], leaves = [], hist = {}, ovr = new Map(), days = new Map(), holiday = null }) {
  const attBy = new Map(att.map(a => [a.user_id, a]));
  const leaveBy = new Map();
  for (const l of leaves) {
    const cur = leaveBy.get(l.user_id);
    if (!cur || (cur.status !== "approved" && l.status === "approved")) leaveBy.set(l.user_id, l); // approved menang
  }

  const rows = [];
  let tanpaJadwal = 0;
  for (const emp of emps) {
    if (emp.join_date && date < emp.join_date) continue;
    if (emp.resign_date && date > emp.resign_date) continue;

    const sid = ovr.get(emp.id) || scheduleIdOn(hist, emp, date);
    const a = attBy.get(emp.id) || null;
    const hasCheckIn = !!a?.check_in;
    if (!sid && !hasCheckIn) { tanpaJadwal++; continue; }

    const day = sid ? days.get(sid) || null : null;
    const scheduled = !!day?.is_working_day && !holiday;
    const leave = leaveBy.get(emp.id) || null;

    let status, keterangan = "";
    if (hasCheckIn) {
      status = a.check_in_status === "telat" ? "hadir_telat" : "hadir_tepat";
      if (!sid) keterangan = "Belum punya jadwal kerja";
      else if (!scheduled) keterangan = holiday ? `Masuk di hari libur (${holiday.name})` : "Masuk di luar jadwal kerja";
    } else if (!scheduled) {
      status = "libur";
      keterangan = holiday ? holiday.name : "Libur sesuai jadwal kerja";
    } else if (leave?.status === "approved") {
      status = "izin";
    } else {
      status = date >= today ? "belum" : "tidak_hadir";
      if (leave) keterangan = "Pengajuan menunggu persetujuan";
      else if (a?.check_out) keterangan = "Hanya ada check-out (lupa check-in)";
    }

    const durasi = hasCheckIn && a.check_out ? Math.round((new Date(a.check_out) - new Date(a.check_in)) / 60000) : null;
    rows.push({
      emp, status, scheduled, sid,
      leave,
      checkIn: hasCheckIn ? a.check_in : null,
      checkOut: a?.check_out || null,
      durasiMenit: durasi,
      lupaCheckout: hasCheckIn && !a.check_out && date < today,
      workMode: a?.work_mode || null,
      notes: a?.notes || "",
      jam: day?.is_working_day ? { start: hhmm(day.start_time), end: hhmm(day.end_time), lintasHari: !!day.crosses_midnight } : null,
      keterangan,
    });
  }
  return { rows, tanpaJadwal };
}

export function summarize(rows) {
  const count = pred => rows.filter(pred).length;
  const terjadwal = rows.filter(r => r.scheduled);
  const izin = terjadwal.filter(r => r.status === "izin").length;
  const hadirJadwal = terjadwal.filter(r => r.status.startsWith("hadir")).length;
  const dasar = terjadwal.length - izin; // yang memang diharapkan hadir
  return {
    terjadwal: terjadwal.length,
    hadir: count(r => r.status.startsWith("hadir")),
    tepat: count(r => r.status === "hadir_tepat"),
    telat: count(r => r.status === "hadir_telat"),
    izin: count(r => r.status === "izin"),
    belum: count(r => r.status === "belum"),
    tidakHadir: count(r => r.status === "tidak_hadir"),
    libur: count(r => r.status === "libur"),
    lupaCheckout: count(r => r.lupaCheckout),
    rate: dasar > 0 ? Math.min(100, Math.round(hadirJadwal / dasar * 100)) : null,
  };
}

// Filter baris laporan. status: "" | hadir | hadir_tepat | hadir_telat | izin | absen | libur | lupa_out
export function matchesStatusFilter(row, status) {
  if (!status) return true;
  if (status === "hadir") return row.status.startsWith("hadir");
  if (status === "absen") return row.status === "belum" || row.status === "tidak_hadir";
  if (status === "lupa_out") return row.lupaCheckout;
  return row.status === status;
}
