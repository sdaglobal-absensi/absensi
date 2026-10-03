import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime, todayISO, resolveUserTimezone, zonedMinutesOfDay, hmToMinutes, dayOfWeekFromDateStr } from "../core.js";
import { fetchSpecialLeaveRules, leaveTypeLabel, addDays } from "../leaveRules.js";
import { esc } from "../approvalHelper.js";
import { goToKoreksiCheckout, goToKoreksiMasuk } from "./employee-absensi.js";

// =====================================================================
// RIWAYAT ABSENSI SAYA — menampilkan SEMUA hari dalam satu bulan (sampai
// hari ini), bukan cuma hari yang punya data absen. Tiap hari diberi
// status supaya karyawan langsung paham posisinya:
//   Hadir (tepat waktu / telat) · Sedang bekerja · Lupa check-in ·
//   Lupa check-out · Izin/Cuti/Sakit · Libur nasional · Libur sesuai
//   jadwal · Belum absen (hari ini) · Tidak ada absen.
// Jam kerja/shift hari itu diambil dari Master Jadwal Kerja karyawan
// (termasuk shift lintas hari, mis. 22.00–06.00).
// =====================================================================

const DAY_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const hm = t => (t ? String(t).slice(0, 5).replace(":", ".") : null);

// Klasifikasi tiap tanggal. Fungsi murni (tanpa akses DOM/jaringan) supaya
// mudah diuji.
//   ctx = { today, yesterday, nowMinutes, hasSchedule, sched, att, hol, leaves, koreksi }
//   sched[dow]  = { is_working_day, start_time, end_time, crosses_midnight }
//   att[date]   = baris attendance    hol[date] = { name }
//   leaves      = daftar leave_requests (pending/approved)
//   koreksi     = Set "tanggal|masuk" / "tanggal|pulang" (pengajuan pending)
export function buildDays(dates, ctx) {
  return dates.map(date => {
    const dow = dayOfWeekFromDateStr(date);
    // Jadwal yang berlaku PADA tanggal itu (bukan jadwal sekarang). ctx.scheduleFor
    // opsional supaya pemanggil lama (ctx.sched / ctx.hasSchedule) tetap jalan.
    const sc = ctx.scheduleFor ? ctx.scheduleFor(date) : { has: ctx.hasSchedule, sched: ctx.sched };
    const cfg = sc.sched[dow] || null;
    const row = ctx.att[date] || null;
    const hol = ctx.hol[date] || null;
    const isToday = date === ctx.today;
    const isWorkingDay = sc.has ? cfg?.is_working_day === true : null; // null = tidak diketahui
    const jadwal = cfg?.is_working_day && cfg.start_time && cfg.end_time
      ? `${hm(cfg.start_time)}–${hm(cfg.end_time)}${cfg.crosses_midnight ? " (+1)" : ""}`
      : null;

    const leave = ctx.leaves
      .filter(l => l.start_date <= date && l.end_date >= date)
      .sort((a, b) => (a.status === "approved" ? -1 : 1) - (b.status === "approved" ? -1 : 1))[0] || null;

    const base = { date, dow, row, jadwal, hol, leave, isWorkingDay, isToday };

    // 1) Ada data absen -> itu yang utama.
    if (row && (row.check_in || row.check_out)) {
      if (row.check_in && !row.check_out) {
        // Shift lintas hari kemarin yang belum lewat jam selesainya = masih berjalan, bukan lupa.
        const overnightOngoing = cfg?.crosses_midnight && date === ctx.yesterday && cfg.end_time
          && ctx.nowMinutes < hmToMinutes(cfg.end_time);
        if (isToday || overnightOngoing) return { ...base, kind: "ongoing" };
        return { ...base, kind: "lupa_out", koreksiPending: ctx.koreksi.has(`${date}|pulang`) };
      }
      if (!row.check_in && row.check_out) {
        return { ...base, kind: "lupa_in", koreksiPending: ctx.koreksi.has(`${date}|masuk`) };
      }
      return { ...base, kind: "hadir" };
    }

    // 2) Tidak ada data absen -> tentukan alasannya.
    if (hol) return { ...base, jadwal: null, kind: "libur_nasional" };
    if (isWorkingDay === false) return { ...base, kind: "libur" };
    if (leave) return { ...base, kind: "leave" };
    if (isToday) return { ...base, kind: "belum" };
    if (isWorkingDay === null) return { ...base, kind: "nodata" };
    return { ...base, kind: "absen", koreksiPending: ctx.koreksi.has(`${date}|masuk`) };
  });
}

export async function render(container, user) {
  const tz = await resolveUserTimezone(user);
  container.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>Riwayat Absensi Saya</h1>
        <p class="pg-head-sub">Rekap kehadiran, libur, dan izin kamu per bulan — semua hari, bukan cuma yang ada absennya.</p>
      </div>
      <div class="rw-controls">
        <label class="inline-field">Bulan
          <input type="month" id="filter-month" value="${todayISO(tz).slice(0, 7)}">
        </label>
        <label class="inline-field">Tampilkan
          <select id="filter-view">
            <option value="semua">Semua hari</option>
            <option value="kerja">Hari kerja saja</option>
            <option value="tindak">Perlu tindak lanjut</option>
          </select>
        </label>
      </div>
    </div>
    <div id="summary-cards" class="dash-stats rw-stats"></div>
    <p id="riwayat-caption" class="muted small rw-caption"></p>
    <div id="riwayat-table" class="table-wrap riwayat-table"><p class="muted" style="padding:18px 20px;">Memuat…</p></div>
  `;

  const state = { days: [] };
  const draw = () => renderTable(state.days, document.getElementById("filter-view").value);

  document.getElementById("filter-month").addEventListener("change", async () => { state.days = await load(user, tz); draw(); });
  document.getElementById("filter-view").addEventListener("change", draw);

  state.days = await load(user, tz);
  draw();
}

async function load(user, tz) {
  const table = document.getElementById("riwayat-table");
  const month = document.getElementById("filter-month").value; // "2026-09"
  if (!month) return [];
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const start = `${month}-01`;
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  const today = todayISO(tz);

  // Riwayat penggantian jadwal (supabase-riwayat-jadwal.sql). Kalau tabelnya belum ada,
  // jatuh balik ke jadwal karyawan saat ini seperti sebelumnya.
  const histR = await supabase.from("employee_schedule_history")
    .select("schedule_id, effective_from").eq("user_id", user.id).order("effective_from", { ascending: true });
  const history = !histR.error && histR.data?.length
    ? histR.data
    : ((user.base_schedule_id ?? user.schedule_id) ? [{ schedule_id: user.base_schedule_id ?? user.schedule_id, effective_from: "1900-01-01" }] : []);

  // Tukar shift (SQL 013): jadwal penimpa per tanggal. Tabel belum ada -> diabaikan.
  const ovR = await supabase.from("schedule_overrides")
    .select("work_date, schedule_id").eq("user_id", user.id).gte("work_date", start).lte("work_date", end);
  const overrides = ovR.error ? {} : Object.fromEntries((ovR.data || []).map(o => [o.work_date, o.schedule_id]));

  const scheduleIdOn = date => {
    if (overrides[date]) return overrides[date];
    let id = null;
    for (const h of history) { if (h.effective_from <= date) id = h.schedule_id; else break; }
    return id;
  };
  // Jadwal yang terpakai selama bulan ini (tanggal 1 sampai akhir bulan).
  const usedIds = new Set();
  usedIds.add(scheduleIdOn(start));
  history.forEach(h => { if (h.effective_from > start && h.effective_from <= end) usedIds.add(h.schedule_id); });
  Object.values(overrides).forEach(id => usedIds.add(id));
  const idList = [...usedIds].filter(Boolean);

  const [attR, holR, leaveR, korR, schedR, nameR, rules] = await Promise.all([
    supabase.from("attendance").select("*").eq("user_id", user.id).gte("date", start).lte("date", end),
    supabase.from("holidays").select("date, name").eq("is_active", true).gte("date", start).lte("date", end),
    supabase.from("leave_requests")
      .select("type, leave_category, special_leave_code, status, start_date, end_date")
      .eq("user_id", user.id).in("status", ["pending", "approved"]).lte("start_date", end).gte("end_date", start),
    supabase.from("attendance_correction_requests")
      .select("attendance_date, correction_type")
      .eq("user_id", user.id).eq("status", "pending").gte("attendance_date", start).lte("attendance_date", end),
    idList.length
      ? supabase.from("work_schedule_days").select("schedule_id, day_of_week, is_working_day, start_time, end_time, crosses_midnight").in("schedule_id", idList)
      : Promise.resolve({ data: [], error: null }),
    idList.length
      ? supabase.from("work_schedules").select("id, name").in("id", idList)
      : Promise.resolve({ data: [], error: null }),
    fetchSpecialLeaveRules(),
  ]);

  // Data inti gagal -> jangan tampilkan riwayat setengah benar (hari libur bisa salah tertandai "tidak ada absen").
  if (attR.error || holR.error || schedR.error) {
    table.innerHTML = `<p class="muted" style="padding:18px 20px;">Gagal memuat data.</p>`;
    document.getElementById("summary-cards").innerHTML = "";
    return [];
  }

  const schedById = {};
  (schedR.data || []).forEach(d => { (schedById[d.schedule_id] ||= {})[d.day_of_week] = d; });
  const nameById = Object.fromEntries((nameR.data || []).map(n => [n.id, n.name]));
  const scheduleFor = date => {
    const id = scheduleIdOn(date);
    return { has: !!id, sched: (id && schedById[id]) || {} };
  };
  const att = {};
  (attR.data || []).forEach(r => { att[r.date] = r; });
  const hol = {};
  (holR.data || []).forEach(h => { hol[h.date] = h; });
  const koreksi = new Set((korR.error ? [] : korR.data || []).map(k => `${k.attendance_date}|${k.correction_type}`));

  // Hari terbaru di atas; hari setelah "hari ini" tidak ditampilkan (belum terjadi).
  const dates = [];
  for (let d = lastDay; d >= 1; d--) {
    const ds = `${month}-${String(d).padStart(2, "0")}`;
    if (ds <= today) dates.push(ds);
  }

  const days = buildDays(dates, {
    today,
    yesterday: addDays(today, -1),
    nowMinutes: zonedMinutesOfDay(new Date(), tz),
    scheduleFor,
    att, hol, koreksi,
    leaves: leaveR.error ? [] : (leaveR.data || []),
  });
  days.forEach(d => { d.rules = rules; });

  renderSummary(days);

  const caption = document.getElementById("riwayat-caption");
  const hint = "Kolom Jadwal menampilkan jam kerja hari itu; (+1) berarti shift berakhir keesokan harinya.";
  // Urutan jadwal yang berlaku di bulan ini (tanggal mulai dipotong ke awal bulan).
  const segments = [];
  for (const h of history) {
    if (h.effective_from > end) break;
    if (h.effective_from <= start) segments.length = 0; // hanya jadwal terakhir sebelum bulan ini yang relevan
    segments.push({ from: h.effective_from < start ? start : h.effective_from, id: h.schedule_id });
  }
  const fmtShort = d => fmtDate(d);
  if (!segments.some(x => x.id)) {
    caption.textContent = "Kamu belum punya jadwal kerja, jadi hari tanpa absen tidak bisa dikategorikan sebagai libur atau tidak hadir. Hubungi HR untuk mengatur jadwalmu.";
  } else if (segments.length === 1) {
    caption.textContent = `Jadwal kerja: ${nameById[segments[0].id] || "-"}. ${hint}`;
  } else {
    const parts = segments.map(x => `${x.id ? (nameById[x.id] || "-") : "Tanpa jadwal"} (mulai ${fmtShort(x.from)})`);
    caption.textContent = `Jadwal berganti bulan ini: ${parts.join(" → ")}. Tiap hari dinilai sesuai jadwal yang berlaku saat itu. ${hint}`;
  }
  return days;
}

function renderSummary(days) {
  const count = k => days.filter(d => k.includes(d.kind)).length;
  const hadir = days.filter(d => d.row?.check_in).length;
  const telat = days.filter(d => d.row?.check_in_status === "telat").length;
  const izin = days.filter(d => d.kind === "leave" && d.leave?.status === "approved").length;
  const absen = count(["absen"]);
  const lupa = count(["lupa_in", "lupa_out"]);

  const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons = {
    check: svg('<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>'),
    clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    file: svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6"/>'),
    alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  };
  const card = (label, value, icon, tone) => `
    <div class="dash-stat ${tone}">
      <div class="dash-stat-top"><span class="dash-stat-icon">${icons[icon]}</span><span class="dash-stat-label">${label}</span></div>
      <div class="dash-stat-value ${value ? "" : "empty"}">${value}<span class="dash-stat-unit">hari</span></div>
    </div>`;

  document.getElementById("summary-cards").innerHTML =
    card("Hadir", hadir, "check", hadir ? "ok" : "") +
    card("Telat", telat, "clock", telat ? "warn" : "") +
    card("Izin / Cuti / Sakit", izin, "file", izin ? "ok" : "") +
    card("Tidak ada absen", absen, "alert", absen ? "warn" : "") +
    card("Lupa check-in/out", lupa, "alert", lupa ? "warn" : "");
}

const VIEW_FILTERS = {
  semua: () => true,
  kerja: d => !["libur", "libur_nasional"].includes(d.kind),
  tindak: d => ["lupa_in", "lupa_out", "absen"].includes(d.kind),
};

function renderTable(days, view) {
  const table = document.getElementById("riwayat-table");
  if (!table || !days.length) {
    if (table && !days.length && !table.textContent.includes("Gagal")) {
      table.innerHTML = `<p class="muted" style="padding:18px 20px;">Belum ada hari yang bisa ditampilkan untuk bulan ini.</p>`;
    }
    return;
  }
  const list = days.filter(VIEW_FILTERS[view] || VIEW_FILTERS.semua);
  if (!list.length) {
    table.innerHTML = `<p class="muted" style="padding:18px 20px;">${view === "tindak" ? "Tidak ada yang perlu ditindaklanjuti bulan ini. 👍" : "Tidak ada data untuk tampilan ini."}</p>`;
    return;
  }

  const rowClass = { libur: "rw-off", libur_nasional: "rw-off", lupa_in: "rw-warn", lupa_out: "rw-warn", absen: "rw-bad" };
  const dash = `<span class="muted">-</span>`;

  table.innerHTML = `
    <table class="table rw-desktop-table">
      <thead><tr><th>Tanggal</th><th>Jadwal</th><th>Check-in</th><th>Status</th><th>Check-out</th><th>Keterangan</th></tr></thead>
      <tbody>
        ${list.map(d => {
          const r = d.row;
          const hasIn = !!r?.check_in;
          const hasOut = !!r?.check_out;
          const status = r?.check_in_status
            ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>`
            : dash;
          const outCell = hasOut ? fmtTime(r.check_out) : (hasIn ? `<span class="muted">Belum</span>` : dash);
          return `
            <tr class="${rowClass[d.kind] || ""} ${d.isToday ? "rw-today" : ""}">
              <td data-label="Tanggal"><span class="rw-date-day">${DAY_SHORT[d.dow]}</span>${fmtDate(d.date)}${d.isToday ? ` <span class="badge badge-muted">Hari ini</span>` : ""}</td>
              <td data-label="Jadwal" class="rw-jadwal ${d.jadwal ? "" : "rw-empty"}">${d.jadwal || dash}</td>
              <td data-label="Check-in" class="${hasIn ? "" : "rw-empty"}">${hasIn ? fmtTime(r.check_in) : dash}</td>
              <td data-label="Status" class="${r?.check_in_status ? "" : "rw-empty"}">${status}</td>
              <td data-label="Check-out" class="${hasIn || hasOut ? "" : "rw-empty"}">${outCell}</td>
              <td data-label="Keterangan" class="${(d.kind === "hadir" && !d.hol) || d.kind === "nodata" ? "rw-empty" : ""}"><div class="rw-note">${noteHTML(d)}</div></td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>
    <div class="rw-cards">${list.map(cardHTML).join("")}</div>
  `;

  table.querySelectorAll(".btn-rw-koreksi").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.type === "pulang") goToKoreksiCheckout({ date: btn.dataset.date });
      else goToKoreksiMasuk(btn.dataset.date);
    });
  });
}

function koreksiAction(d, type, cls = "org-mini-btn") {
  if (d.koreksiPending) return `<span class="badge badge-warn">Koreksi diajukan</span>`;
  return `<button type="button" class="${cls} btn-rw-koreksi" data-date="${d.date}" data-type="${type}">Ajukan koreksi</button>`;
}

function noteHTML(d) {
  switch (d.kind) {
    case "hadir":
      return d.hol ? `<span class="badge badge-muted">Masuk di hari libur: ${esc(d.hol.name)}</span>` : `<span class="muted">-</span>`;
    case "ongoing":
      return `<span class="badge badge-muted">Sedang bekerja</span>`;
    case "lupa_out":
      return `<span class="badge badge-danger">Lupa check-out</span>${koreksiAction(d, "pulang")}`;
    case "lupa_in":
      return `<span class="badge badge-danger">Lupa check-in</span>${koreksiAction(d, "masuk")}`;
    case "libur_nasional":
      return `<span class="badge badge-muted">Libur nasional — ${esc(d.hol.name)}</span>`;
    case "libur":
      return `<span class="badge badge-muted">Libur (sesuai jadwal)</span>`;
    case "leave": {
      const label = leaveTypeLabel(d.leave, d.rules);
      return d.leave.status === "approved"
        ? `<span class="badge badge-ok">${esc(label)}</span>`
        : `<span class="badge badge-warn">${esc(label)} — menunggu approval</span>`;
    }
    case "belum":
      return `<span class="badge badge-muted">Belum absen</span>`;
    case "absen":
      return `<span class="badge badge-danger">Tidak ada absen</span>${koreksiAction(d, "masuk")}`;
    default: // nodata
      return `<span class="muted">-</span>`;
  }
}

// ---------------------------------------------------------------------
// Tampilan HP: satu kartu per hari (tabel 6 kolom tidak muat di layar kecil).
// Kiri = tanggal, kanan = jadwal + jam masuk/pulang + status + aksi.
// Warna garis kiri menunjukkan kondisi hari itu sekilas.
// ---------------------------------------------------------------------
const CARD_TONE = {
  hadir: "ok", ongoing: "info", belum: "info",
  lupa_in: "warn", lupa_out: "warn", absen: "danger",
  libur: "off", libur_nasional: "off", nodata: "off",
};

function cardHTML(d) {
  const r = d.row;
  const tone = d.kind === "leave"
    ? (d.leave?.status === "approved" ? "ok" : "warn")
    : (d.kind === "hadir" && r?.check_in_status === "telat" ? "warn" : CARD_TONE[d.kind] || "off");

  const showTimes = ["hadir", "ongoing", "lupa_in", "lupa_out"].includes(d.kind);
  const inVal = r?.check_in ? fmtTime(r.check_in) : "--.--";
  const outVal = r?.check_out ? fmtTime(r.check_out) : "--.--";
  const statusBadge = r?.check_in_status
    ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>`
    : "";

  const times = showTimes ? `
    <div class="rw-times">
      <div class="rw-time">
        <span class="rw-time-label">Masuk</span>
        <span class="rw-time-val ${r?.check_in ? "" : "is-empty"}">${inVal}</span>
        ${statusBadge}
      </div>
      <div class="rw-time">
        <span class="rw-time-label">Pulang</span>
        <span class="rw-time-val ${r?.check_out ? "" : "is-empty"}">${outVal}</span>
      </div>
    </div>` : "";

  // Tombol koreksi dipisah dari badge supaya bisa dibuat selebar kartu.
  const actionKinds = { lupa_out: "pulang", lupa_in: "masuk", absen: "masuk" };
  const actionType = actionKinds[d.kind];
  const label = noteHTML(d).replace(/<button[\s\S]*?<\/button>/, "");
  const action = actionType ? koreksiAction({ ...d, koreksiPending: false }, actionType, "rw-card-btn") : "";
  const actionHTML = actionType ? (d.koreksiPending ? "" : action) : "";

  return `
    <article class="rw-card rw-t-${tone} ${d.isToday ? "is-today" : ""}">
      <div class="rw-card-date" aria-hidden="true">
        <span class="rw-cd-dow">${DAY_SHORT[d.dow]}</span>
        <span class="rw-cd-day">${d.date.slice(8, 10).replace(/^0/, "")}</span>
        <span class="rw-cd-mon">${MONTH_SHORT[Number(d.date.slice(5, 7)) - 1]}</span>
      </div>
      <div class="rw-card-body">
        <div class="rw-card-head">
          <span class="rw-card-title">${fmtDate(d.date)}${d.isToday ? ` <span class="badge badge-muted">Hari ini</span>` : ""}</span>
          ${d.jadwal ? `<span class="rw-card-sched"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${d.jadwal}</span>` : ""}
        </div>
        ${times}
        ${d.kind === "hadir" && !d.hol ? "" : `<div class="rw-card-note">${label}</div>`}
        ${actionHTML}
      </div>
    </article>`;
}
