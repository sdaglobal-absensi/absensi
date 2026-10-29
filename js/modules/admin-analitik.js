import { supabase } from "../supabaseClient.js";
import { dateOnlyISO, dayOfWeekFromDateStr, exportXLSX, toast } from "../core.js";

// =======================================================================
// Dashboard Analitik HR (Prioritas Menengah #7)
// Hanya MENAMPILKAN data yang sudah ada: attendance, leave_requests,
// overtime_requests, leave_balances, holidays, profiles, work_schedule_days,
// employee_schedule_history, schedule_overrides. Tidak ada tabel baru.
// Hari yang DIHARAPKAN hadir dihitung per karyawan dari jadwal kerjanya (riwayat
// jadwal + tukar shift), mulai tanggal masuk, di luar hari libur dan izin/cuti
// yang disetujui. Karyawan tanpa jadwal pada bulan itu tidak dihitung.
// Yang bisa dilihat mengikuti RLS yang sudah ada (staf HR melihat seluruh
// karyawan; role lain hanya melihat datanya sendiri).
// =======================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTHS_FULL = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString("id-ID");

let state = { profiles: [], holidays: new Set(), working: {}, hist: {}, month: "", dept: "", pt: "", loc: "", exportRows: [], view: null };
let reqToken = 0;

export async function render(container) {
  const nowISO = dateOnlyISO(new Date());
  state.month = nowISO.slice(0, 7);
  state.dept = ""; state.pt = ""; state.loc = "";

  container.innerHTML = `
    <style>
      .an-bars { display: flex; align-items: flex-end; gap: 10px; height: 150px; padding: 8px 4px 0; }
      .an-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 0; }
      .an-bar { width: 100%; max-width: 44px; border-radius: 6px 6px 0 0; background: var(--primary-light, #5b8def); min-height: 2px; transition: height .3s; }
      .an-bar.cur { background: var(--primary, #2f5fd0); }
      .an-bar-val { font-size: .74rem; font-weight: 600; margin-bottom: 4px; }
      .an-bar-lbl { font-size: .72rem; color: var(--muted); margin-top: 6px; }
      .an-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
      .an-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px 18px; box-shadow: var(--shadow-xs); }
      .an-panel h3 { margin: 0 0 4px; font-size: .98rem; }
      .an-meter { display: inline-block; width: 70px; height: 7px; border-radius: 4px; background: #E8E6E0; vertical-align: middle; margin-right: 6px; overflow: hidden; }
      .an-meter > i { display: block; height: 100%; background: var(--ok, #2e9b5f); }
      .an-meter.warn > i { background: var(--warn, #d9922b); }
      .an-meter.danger > i { background: var(--danger, #d64545); }
      .an-note { font-size: .8rem; color: var(--muted); margin: 6px 0 16px; }
      .an-tbl { min-width: 780px; }
      .an-tbl th, .an-tbl td { white-space: nowrap; }
      .an-tbl th.num, .an-tbl td.num { text-align: right; }
      .an-tbl tfoot td { font-weight: 700; background: var(--surface-2, #F7F6F2); border-top: 2px solid var(--border); }
      .an-delta { display: inline-block; font-size: .74rem; font-weight: 600; }
      .an-delta.good { color: var(--ok, #2e9b5f); }
      .an-delta.bad { color: var(--danger, #d64545); }
      .an-delta.flat { color: var(--muted); }
      .an-lowdata { color: var(--warn, #d9922b); font-weight: 600; }
      .an-info { cursor: help; color: var(--muted); font-size: .72rem; margin-left: 2px; }
      .an-def { margin: 0 0 18px; font-size: .82rem; color: var(--muted); }
      .an-def summary { cursor: pointer; font-weight: 600; color: var(--ink, inherit); }
      .an-def ul { margin: 8px 0 0; padding-left: 18px; line-height: 1.6; }
      .an-tbl tbody tr.an-click { cursor: pointer; }
      .an-tbl tbody tr.an-click:hover { background: var(--surface-2, #F7F6F2); }
      .an-hint { font-size: .78rem; color: var(--muted); padding: 8px 16px 12px; margin: 0; }
      .an-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 14px; }
      .an-chip { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 4px 10px; font-size: .78rem; cursor: pointer; color: var(--ink, inherit); }
      .an-chip:hover { border-color: var(--primary, #2f5fd0); color: var(--primary, #2f5fd0); }
      .an-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      .an-modal-head h3 { margin: 0; }
      .an-modal-x { flex-shrink: 0; width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); font-size: 1.4rem; line-height: 1; cursor: pointer; color: var(--ink, inherit); }
      .an-sum { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: .84rem; margin-bottom: 12px; }
      .an-chart { width: 100%; height: auto; display: block; }
      .an-chart text { font-family: inherit; fill: var(--muted); font-size: 10px; }
      .an-chart .an-val { fill: var(--ink, #1B1F1D); font-weight: 600; font-size: 10px; }
      .an-chart .an-grid { stroke: var(--border); stroke-width: 1; }
      .an-donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
      .an-donut-wrap svg { width: 168px; height: 168px; flex-shrink: 0; }
      .an-donut-center { font-size: 26px !important; font-weight: 700; fill: var(--ink, #1B1F1D) !important; }
      .an-legend { list-style: none; margin: 0; padding: 0; font-size: .82rem; display: grid; gap: 6px; flex: 1; min-width: 150px; }
      .an-legend li { display: flex; align-items: center; gap: 8px; }
      .an-legend .dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
      .an-legend .n { margin-left: auto; font-weight: 600; white-space: nowrap; }
      .an-legend-inline { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: .78rem; color: var(--muted); margin-top: 6px; }
      .an-legend-inline .dot { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: middle; }
      .an-hrow { display: grid; grid-template-columns: minmax(70px, 130px) 1fr 44px; align-items: center; gap: 10px; margin: 8px 0; font-size: .84rem; }
      .an-hname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .an-hbar { display: flex; height: 16px; border-radius: 5px; overflow: hidden; background: #ECEAE4; }
      .an-hbar i { display: block; height: 100%; }
      .an-hpct { text-align: right; font-weight: 600; }
      .an-empty { padding: 28px 8px; text-align: center; color: var(--muted); font-size: .85rem; }
    </style>

    <div class="pg-head">
      <div>
        <h1>Dashboard Analitik HR</h1>
        <p class="pg-head-sub">Tingkat keterlambatan, tren lembur, absensi per departemen, dan cuti yang belum terpakai.</p>
      </div>
    </div>

    <div class="pg-toolbar">
      <div class="filter-row">
        <input type="month" id="an-month" value="${state.month}" max="${nowISO.slice(0, 7)}">
        <select id="an-dept"><option value="">Semua Departemen</option></select>
        <select id="an-pt" class="hidden"><option value="">Semua PT / Unit</option></select>
        <select id="an-loc" class="hidden"><option value="">Semua Lokasi</option></select>
        <button type="button" id="an-export" class="btn-secondary">⬇ Ekspor Excel</button>
      </div>
    </div>

    <div class="status-grid" id="an-kpi"><p class="muted">Memuat…</p></div>
    <div class="status-grid" id="an-kpi2" style="margin-top:12px"></div>
    <p class="an-note" id="an-meta"></p>
    <details class="an-def">
      <summary>Cara menghitung angka di halaman ini</summary>
      <ul>
        <li><b>Hari terjadwal</b>: hari kerja menurut jadwal masing-masing karyawan (termasuk riwayat jadwal dan tukar shift), mulai tanggal masuk, di luar Master Hari Libur dan izin/cuti/sakit yang disetujui. Bulan berjalan dihitung sampai hari ini.</li>
        <li><b>Tingkat kehadiran</b>: check-in pada hari terjadwal ÷ hari terjadwal. Check-in di luar jadwal tidak dihitung.</li>
        <li><b>Tingkat keterlambatan</b>: check-in berstatus telat ÷ seluruh check-in.</li>
        <li><b>Hari tanpa check-in</b>: hari terjadwal yang sudah lewat, tanpa check-in, izin, atau cuti. Hari ini belum dihitung.</li>
        <li><b>Lupa check-out</b>: check-in pada tanggal yang sudah lewat tetapi belum ada check-out.</li>
        <li><b>Karyawan tanpa jadwal</b> pada bulan terpilih tidak dihitung di angka mana pun, kecuali kuota cuti.</li>
      </ul>
    </details>

    <div class="an-grid2">
      <div class="an-panel"><h3>Komposisi Kehadiran</h3><p class="muted small" id="an-comp-sub"></p><div id="an-donut"></div></div>
      <div class="an-panel"><h3>Kehadiran Harian</h3><p class="muted small" id="an-daily-sub">% karyawan hadir pada hari terjadwal</p><div id="an-daily"></div></div>
    </div>

    <div class="an-grid2">
      <div class="an-panel"><h3>Tren Kehadiran &amp; Keterlambatan</h3><p class="muted small">Per bulan, 6 bulan terakhir</p><div id="an-trend-late"></div></div>
      <div class="an-panel"><h3>Tren Lembur</h3><p class="muted small">Total jam lembur disetujui, 6 bulan terakhir</p><div id="an-trend-ot"></div></div>
    </div>

    <h2 class="dash-section-title">Absensi per Departemen</h2>
    <div class="an-panel" id="an-dept-chart" style="margin-bottom:16px"></div>
    <div id="an-dept-table" class="table-wrap"><p class="muted" style="padding:16px">Memuat…</p></div>

    <div class="an-grid2" style="margin-top:24px">
      <div class="an-panel"><h3>Karyawan Paling Sering Telat</h3><p class="muted small" id="an-late-sub"></p><div id="an-top-late"></div></div>
      <div class="an-panel"><h3>Cuti Tahunan Belum Terpakai</h3><p class="muted small" id="an-leave-sub"></p><div id="an-leave"></div></div>
    </div>

    <div id="an-modal" class="modal hidden"><div class="modal-box modal-box-lg"><div id="an-modal-body"></div></div></div>
  `;

  document.getElementById("an-month").addEventListener("change", e => { if (e.target.value) { state.month = e.target.value; load(); } });
  document.getElementById("an-dept").addEventListener("change", e => { state.dept = e.target.value; load(); });
  document.getElementById("an-pt").addEventListener("change", e => { state.pt = e.target.value; load(); });
  document.getElementById("an-loc").addEventListener("change", e => { state.loc = e.target.value; load(); });
  document.getElementById("an-export").addEventListener("click", onExport);
  document.getElementById("an-dept-table").addEventListener("click", e => {
    const tr = e.target.closest("tr[data-dept]"); if (tr) showDeptDetail(tr.dataset.dept);
  });
  document.getElementById("an-top-late").addEventListener("click", e => {
    const b = e.target.closest("[data-uid]"); if (b) showPersonDetail(b.dataset.uid);
  });
  const modal = document.getElementById("an-modal");
  modal.addEventListener("click", e => {
    if (e.target === modal || e.target.closest("[data-close]")) { modal.classList.add("hidden"); return; }
    const u = e.target.closest("[data-uid]"); if (u) { showPersonDetail(u.dataset.uid, u.dataset.back || ""); return; }
    const bk = e.target.closest("[data-back-dept]"); if (bk) { showDeptDetail(bk.dataset.backDept); return; }
    const g = e.target.closest("[data-go-date]"); if (g) goMonitor(g.dataset.goDate, g.dataset.q || "");
  });

  await loadStatic();
  load();
}

// ---------- data umum (sekali per halaman dibuka) ----------
async function loadStatic() {
  const [{ data: profiles }, { data: holidays }, schedDays, hist] = await Promise.all([
    supabase.from("profiles").select("id, full_name, employee_code, department, unit_pt, lokasi_kerja, join_date, resign_date, schedule_id").eq("is_active", true).order("full_name"),
    supabase.from("holidays").select("date").eq("is_active", true),
    supabase.from("work_schedule_days").select("schedule_id, day_of_week, is_working_day"),
    supabase.from("employee_schedule_history").select("user_id, schedule_id, effective_from").order("effective_from", { ascending: true }),
  ]);
  state.profiles = profiles || [];
  state.holidays = new Set((holidays || []).map(h => h.date));
  state.working = {};
  (schedDays.error ? [] : schedDays.data || []).forEach(d => { state.working[`${d.schedule_id}|${d.day_of_week}`] = d.is_working_day; });
  state.hist = {};
  (hist.error ? [] : hist.data || []).forEach(h => { (state.hist[h.user_id] ||= []).push(h); });
  const depts = [...new Set(state.profiles.map(p => p.department).filter(Boolean))].sort();
  const sel = document.getElementById("an-dept");
  sel.innerHTML = `<option value="">Semua Departemen</option>` + depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  fillFilter("an-pt", "Semua PT / Unit", state.profiles.map(p => p.unit_pt));
  fillFilter("an-loc", "Semua Lokasi", state.profiles.map(p => p.lokasi_kerja));
}

// Filter PT/Unit & Lokasi hanya ditampilkan kalau datanya memang ada.
function fillFilter(id, allLabel, values) {
  const opts = [...new Set(values.filter(Boolean))].sort();
  const el = document.getElementById(id);
  el.innerHTML = `<option value="">${allLabel}</option>` + opts.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  el.classList.toggle("hidden", opts.length === 0);
}

function matchesFilter(p) {
  return (!state.dept || p.department === state.dept) && (!state.pt || p.unit_pt === state.pt) && (!state.loc || p.lokasi_kerja === state.loc);
}

// Supabase membatasi 1000 baris per permintaan, jadi diambil per halaman.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  return { y, m, start: `${ym}-01`, end: dateOnlyISO(new Date(y, m, 0)) };
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Jadwal yang berlaku pada TANGGAL tertentu (riwayat jadwal), bukan jadwal sekarang.
// Belum ada riwayat -> pakai profiles.schedule_id.
function scheduleIdOn(emp, date) {
  const hist = state.hist[emp.id];
  if (!hist || !hist.length) return emp.schedule_id || null;
  let id = null;
  for (const h of hist) { if (h.effective_from <= date) id = h.schedule_id; else break; }
  return id;
}

function isoDays(start, end) {
  const out = [];
  const [y, m, d] = start.split("-").map(Number);
  for (const t = new Date(Date.UTC(y, m - 1, d)); ; t.setUTCDate(t.getUTCDate() + 1)) {
    const iso = t.toISOString().slice(0, 10);
    if (iso > end) break;
    out.push(iso);
  }
  return out;
}

// Statistik per karyawan untuk satu bulan. Bulan berjalan dihitung sampai hari ini.
function analyze(range, people, { att, leaves, ots, ovr }) {
  const today = dateOnlyISO(new Date());
  const last = range.end < today ? range.end : today;
  const days = last >= range.start ? isoDays(range.start, last) : [];
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r.user_id)) m.set(r.user_id, []); m.get(r.user_id).push(r); } return m; };
  const leaveBy = group(leaves);
  const attBy = group(att.filter(a => a.date >= range.start && a.date <= range.end));
  const otBy = group(ots.filter(o => o.date >= range.start && o.date <= range.end));
  const out = new Map();
  for (const p of people) {
    const lv = leaveBy.get(p.id) || [];
    const exp = new Set();
    let hasSched = false, izin = 0;
    for (const date of days) {
      if (p.join_date && date < p.join_date) continue;
      if (p.resign_date && date > p.resign_date) continue;
      const sid = ovr.get(`${p.id}|${date}`) || scheduleIdOn(p, date);
      if (!sid) continue;
      hasSched = true;
      if (state.holidays.has(date)) continue;
      if (state.working[`${sid}|${dayOfWeekFromDateStr(date)}`] !== true) continue;
      if (lv.some(l => l.start_date <= date && l.end_date >= date)) { izin++; continue; }
      exp.add(date);
    }
    const mine = attBy.get(p.id) || [];
    const mineDates = new Set(mine.map(a => a.date));
    const missDates = [...exp].filter(d => d < today && !mineDates.has(d)).sort();
    const lateDates = mine.filter(a => a.check_in_status === "telat").map(a => a.date).sort();
    const telatExp = lateDates.filter(d => exp.has(d)).length;
    const lupaOutDates = mine.filter(a => !a.check_out && a.date < today).map(a => a.date).sort();
    out.set(p.id, {
      hasSched,
      exp: exp.size,
      izin,
      hadir: mine.length,
      hadirExp: mine.filter(a => exp.has(a.date)).length,
      telat: lateDates.length,
      telatExp,
      tanpa: missDates.length,
      lupaOut: lupaOutDates.length,
      ot: (otBy.get(p.id) || []).reduce((s, o) => s + otHours(o), 0),
      missDates, lateDates, lupaOutDates,
      expSet: exp, attSet: mineDates, lateSet: new Set(lateDates),
    });
  }
  return out;
}

function totalsOf(stats, scope) {
  const t = { exp: 0, hadir: 0, hadirExp: 0, telat: 0, telatExp: 0, izin: 0, ot: 0, tanpa: 0, lupaOut: 0 };
  for (const p of scope) { const s = stats.get(p.id); for (const k in t) t[k] += s[k]; }
  t.rate = t.exp ? Math.min(100, Math.round(t.hadirExp / t.exp * 100)) : null;
  t.lateRate = t.hadir ? Math.round(t.telat / t.hadir * 100) : null;
  return t;
}

// Chip pembanding dengan bulan lalu. higherBetter: true/false menentukan warna, null = netral.
function deltaChip(curV, prevV, { higherBetter = null, unit = "", digits = 0, label }) {
  if (curV == null || prevV == null) return "";
  const f = Math.pow(10, digits);
  const d = Math.round((curV - prevV) * f) / f;
  if (d === 0) return `<span class="an-delta flat">• sama dengan ${label}</span>`;
  const up = d > 0;
  const cls = higherBetter === null ? "flat" : (up === higherBetter ? "good" : "bad");
  return `<span class="an-delta ${cls}">${up ? "▲" : "▼"} ${fmt1(Math.abs(d))}${unit} vs ${label}</span>`;
}

function otHours(r) {
  if (r.total_jam != null) return Number(r.total_jam) || 0;
  const [h1, m1] = String(r.start_time).split(":").map(Number);
  const [h2, m2] = String(r.end_time).split(":").map(Number);
  let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (mins < 0) mins += 1440;
  return mins / 60;
}

// ---------- muat & tampilkan ----------
async function load() {
  const token = ++reqToken;
  const { month, dept } = state;
  const cur = monthRange(month);
  const prev = monthRange(shiftMonth(month, -1));
  const trendStart = monthRange(shiftMonth(month, -5)).start;
  const year = cur.y;
  const isCurrentMonth = month === dateOnlyISO(new Date()).slice(0, 7);

  const people = state.profiles.filter(matchesFilter);
  const ids = new Set(people.map(p => p.id));

  let att, leaves, ots, balances, ovrRows, resignRows;
  try {
    [att, leaves, ots, balances, ovrRows, resignRows] = await Promise.all([
      fetchAll(() => supabase.from("attendance").select("user_id, date, check_in, check_out, check_in_status").gte("date", trendStart).lte("date", cur.end).order("date")),
      fetchAll(() => supabase.from("leave_requests").select("user_id, start_date, end_date").eq("status", "approved").lte("start_date", cur.end).gte("end_date", trendStart)),
      fetchAll(() => supabase.from("overtime_requests").select("user_id, date, start_time, end_time, total_jam").eq("status", "approved").gte("date", trendStart).lte("date", cur.end)),
      fetchAll(() => supabase.from("leave_balances").select("user_id, kuota_hari, terpakai_hari").eq("tahun", year)),
      fetchAll(() => supabase.from("schedule_overrides").select("user_id, work_date, schedule_id").gte("work_date", trendStart).lte("work_date", cur.end).order("work_date")).catch(() => []), // tukar shift (opsional)
      supabase.from("profiles").select("id, department, unit_pt, lokasi_kerja").gte("resign_date", cur.start).lte("resign_date", cur.end).then(r => (r.error ? [] : r.data || [])), // yang resign bulan ini (akun sudah nonaktif)
    ]);
  } catch (e) {
    if (token !== reqToken) return;
    document.getElementById("an-kpi").innerHTML = `<p class="muted">Gagal memuat data: ${esc(e.message || e)}</p>`;
    return;
  }
  if (token !== reqToken) return; // pengguna sudah ganti filter, abaikan hasil lama

  att = att.filter(a => ids.has(a.user_id) && a.check_in);
  leaves = leaves.filter(l => ids.has(l.user_id));
  ots = ots.filter(o => ids.has(o.user_id));
  balances = balances.filter(b => ids.has(b.user_id));
  const ovr = new Map(ovrRows.map(o => [`${o.user_id}|${o.work_date}`, o.schedule_id]));
  const data = { att, leaves, ots, ovr };

  // Karyawan yang dipantau = punya jadwal kerja pada bulan terpilih.
  const curStats = analyze(cur, people, data);
  const scope = people.filter(p => curStats.get(p.id).hasSched);
  const scopeIds = new Set(scope.map(p => p.id));
  const excluded = people.length - scope.length;
  const tot = totalsOf(curStats, scope);
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const trend = months.map((ym, i) => (i === 5 ? { ym, ...tot } : { ym, ...totalsOf(analyze(monthRange(ym), scope, data), scope) }));
  const prevTot = trend[4];
  const prevLabel = MONTHS[prev.m - 1];

  const lowData = tot.hadir > 0 && tot.hadir < 10;
  const otCmp = !isCurrentMonth && (tot.ot > 0 || prevTot.ot > 0) ? deltaChip(tot.ot, prevTot.ot, { unit: " jam", digits: 1, label: prevLabel }) : "";
  const sisaTotal = balances.reduce((s, b) => s + Math.max(0, Number(b.kuota_hari) - Number(b.terpakai_hari)), 0);

  const lbl = (text, tip) => `<span class="status-label">${text} <span class="an-info" title="${esc(tip)}">ⓘ</span></span>`;
  document.getElementById("an-kpi").innerHTML = `
    <div class="status-card ${tot.rate != null && tot.rate >= 90 ? "done" : ""}">${lbl("Tingkat Kehadiran", "Check-in pada hari terjadwal ÷ hari terjadwal. Di luar hari libur dan izin/cuti disetujui.")}<span class="status-value">${tot.rate ?? "–"}${tot.rate != null ? "%" : ""}</span><span class="muted small">${tot.hadirExp} hadir dari ${tot.exp} hari terjadwal</span>${prevTot.hadir && prevTot.exp ? deltaChip(tot.rate, prevTot.rate, { higherBetter: true, unit: " poin", label: prevLabel }) : ""}</div>
    <div class="status-card">${lbl("Tingkat Keterlambatan", "Check-in berstatus telat ÷ seluruh check-in pada bulan ini.")}<span class="status-value">${tot.lateRate ?? "–"}${tot.lateRate != null ? "%" : ""}</span><span class="muted small">${tot.telat} dari ${tot.hadir} check-in${lowData ? ` · <span class="an-lowdata">data masih sedikit</span>` : ""}</span>${prevTot.hadir ? deltaChip(tot.lateRate, prevTot.lateRate, { higherBetter: false, unit: " poin", label: prevLabel }) : ""}</div>
    <div class="status-card">${lbl("Total Lembur Disetujui", "Jumlah jam lembur berstatus disetujui pada bulan ini.")}<span class="status-value">${fmt1(tot.ot)} jam</span><span class="muted small">${MONTHS_FULL[cur.m - 1]} ${cur.y}</span>${otCmp}</div>
    <div class="status-card">${lbl("Cuti Belum Terpakai", "Sisa kuota Cuti Tahunan (kuota − terpakai) seluruh karyawan pada filter ini.")}<span class="status-value">${fmt1(sisaTotal)} hari</span><span class="muted small">Cuti Tahunan ${year}, ${people.length} karyawan</span></div>`;

  const masuk = people.filter(p => p.join_date && p.join_date >= cur.start && p.join_date <= cur.end).length;
  const keluar = resignRows.filter(matchesFilter).length;
  document.getElementById("an-kpi2").innerHTML = `
    <div class="status-card">${lbl("Karyawan Aktif", "Jumlah karyawan aktif pada filter ini. Masuk/keluar dihitung dari tanggal masuk dan tanggal resign di bulan terpilih.")}<span class="status-value">${people.length}</span><span class="muted small">${masuk} masuk · ${keluar} keluar di ${MONTHS_FULL[cur.m - 1]}</span></div>
    <div class="status-card">${lbl("Hari Tanpa Check-in", "Hari terjadwal yang sudah lewat tanpa check-in, izin, atau cuti. Hari ini belum dihitung.")}<span class="status-value">${tot.tanpa}</span><span class="muted small">hari terjadwal tanpa absen/keterangan</span></div>
    <div class="status-card">${lbl("Lupa Check-out", "Check-in pada tanggal yang sudah lewat, tetapi belum ada check-out.")}<span class="status-value">${tot.lupaOut}</span><span class="muted small">sesi lama belum check-out</span></div>
    <div class="status-card">${lbl("Belum Punya Jadwal", "Karyawan aktif yang tidak punya jadwal kerja pada bulan ini, sehingga tidak dihitung di angka kehadiran. Lengkapi jadwalnya di Data Karyawan.")}<span class="status-value">${excluded}</span><span class="muted small">${excluded ? "tidak dihitung di analitik ini" : "semua karyawan sudah berjadwal"}</span></div>`;
  const filterText = [dept, state.pt, state.loc].filter(Boolean).join(" · ");
  document.getElementById("an-meta").textContent =
    `${scope.length} karyawan dipantau${filterText ? " (" + filterText + ")" : ""}${excluded ? ` • ${excluded} karyawan tanpa jadwal kerja pada bulan ini tidak dihitung` : ""}. ` +
    `Hari terjadwal dihitung per karyawan sesuai jadwal kerjanya, di luar Master Hari Libur dan izin/cuti yang disetujui${isCurrentMonth ? ", sampai hari ini" : ""}.`;

  // --- tren 6 bulan ---
  const otScope = ots.filter(o => scopeIds.has(o.user_id));
  const otSeries = months.map(ym => ({ ym, val: otScope.filter(o => o.date.startsWith(ym)).reduce((s, o) => s + otHours(o), 0), has: true }));
  // --- grafik ---
  const mLabel = ym => MONTHS[Number(ym.split("-")[1]) - 1];
  document.getElementById("an-trend-late").innerHTML = trend.some(t => t.hadir > 0)
    ? lineChart({
        labels: trend.map(t => mLabel(t.ym)), valueLabels: true,
        series: [
          { name: "Kehadiran", color: C.tepat, area: true, values: trend.map(t => (t.hadir && t.exp ? t.rate : null)) },
          { name: "Keterlambatan", color: C.telat, values: trend.map(t => (t.hadir ? t.lateRate : null)) },
        ],
      })
    : `<p class="an-empty">Belum ada data absensi dalam 6 bulan terakhir.</p>`;

  // komposisi (donat): seluruh hari terjadwal + hari izin/cuti
  const seg = { tepat: tot.hadirExp - tot.telatExp, telat: tot.telatExp, izin: tot.izin, tanpa: tot.tanpa, belum: Math.max(0, tot.exp - tot.hadirExp - tot.tanpa) };
  document.getElementById("an-comp-sub").textContent = `${tot.exp + tot.izin} hari terjadwal (termasuk izin/cuti) • ${MONTHS_FULL[cur.m - 1]} ${cur.y}`;
  document.getElementById("an-donut").innerHTML = donut([
    { l: "Hadir tepat waktu", v: seg.tepat, c: C.tepat },
    { l: "Hadir terlambat", v: seg.telat, c: C.telat },
    { l: "Izin / cuti / sakit", v: seg.izin, c: C.izin },
    { l: "Tanpa check-in", v: seg.tanpa, c: C.tanpa },
    { l: "Belum (hari ini)", v: seg.belum, c: C.belum },
  ], tot.rate != null ? tot.rate + "%" : "–", "kehadiran");

  // harian: % hadir & % telat per hari terjadwal (hari ini belum dihitung, masih berjalan)
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const lastDay = cur.end < dateOnlyISO(yest) ? cur.end : dateOnlyISO(yest);
  const dayRows = [];
  for (const d of lastDay >= cur.start ? isoDays(cur.start, lastDay) : []) {
    let e = 0, h = 0, t = 0;
    for (const p of scope) { const st = curStats.get(p.id); if (!st.expSet.has(d)) continue; e++; if (st.attSet.has(d)) { h++; if (st.lateSet.has(d)) t++; } }
    if (e) dayRows.push({ d, rate: Math.round(h / e * 100), late: h ? Math.round(t / h * 100) : null, e, h });
  }
  const avgDaily = dayRows.length ? Math.round(dayRows.reduce((a, r) => a + r.rate, 0) / dayRows.length) : null;
  document.getElementById("an-daily-sub").textContent = dayRows.length ? `Rata-rata ${avgDaily}% per hari terjadwal${isCurrentMonth ? " • hari ini belum dihitung" : ""}` : "% karyawan hadir pada hari terjadwal";
  document.getElementById("an-daily").innerHTML = dayRows.length
    ? lineChart({
        labels: dayRows.map(r => String(Number(r.d.slice(8)))), tickEvery: Math.ceil(dayRows.length / 12),
        series: [
          { name: "Kehadiran", color: C.tepat, area: true, values: dayRows.map(r => r.rate), tips: dayRows.map(r => `${fmtDay(r.d)}: ${r.h} dari ${r.e} hadir (${r.rate}%)`) },
          { name: "Terlambat", color: C.telat, values: dayRows.map(r => r.late), tips: dayRows.map(r => `${fmtDay(r.d)}: ${r.late ?? 0}% dari yang hadir telat`) },
        ],
      })
    : `<p class="an-empty">Belum ada hari terjadwal yang sudah lewat pada bulan ini.</p>`;
  document.getElementById("an-trend-ot").innerHTML = otSeries.some(x => x.val > 0) ? bars(otSeries, " jam") : `<p class="an-empty">Belum ada lembur disetujui dalam 6 bulan terakhir.</p>`;

  // --- per departemen ---
  const FIELDS = ["exp", "hadir", "hadirExp", "telat", "telatExp", "tanpa", "izin", "ot"];
  const blank = () => ({ n: 0, exp: 0, hadir: 0, hadirExp: 0, telat: 0, telatExp: 0, tanpa: 0, izin: 0, ot: 0 });
  const groups = new Map();
  for (const p of scope) {
    const k = p.department || "Tanpa Departemen";
    if (!groups.has(k)) groups.set(k, { name: k, ...blank() });
    const g = groups.get(k), st = curStats.get(p.id);
    g.n++; for (const f of FIELDS) g[f] += st[f];
  }
  const rows = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pct = (a, b) => (b ? Math.min(100, Math.round(a / b * 100)) : 0);
  const rowHtml = g => {
    const r = pct(g.hadirExp, g.exp);
    const lr = g.hadir ? Math.round(g.telat / g.hadir * 100) : 0;
    return `<td class="num">${g.n}</td><td class="num">${g.exp}</td><td class="num">${g.hadirExp}</td><td class="num">${g.telat}</td>
      <td class="num"><span class="badge ${lr >= 20 ? "badge-danger" : lr >= 10 ? "badge-warn" : "badge-ok"}">${lr}%</span></td>
      <td class="num">${g.tanpa}</td><td class="num">${g.izin}</td><td class="num">${fmt1(g.ot)}</td>
      <td><span class="an-meter ${r < 75 ? "danger" : r < 90 ? "warn" : ""}"><i style="width:${r}%"></i></span>${r}%</td>`;
  };
  document.getElementById("an-dept-table").innerHTML = rows.length ? `
    <table class="table an-tbl">
      <thead><tr><th>Departemen</th><th class="num">Karyawan</th><th class="num">Hari Terjadwal</th><th class="num">Hadir</th><th class="num">Telat</th><th class="num">% Telat</th><th class="num">Tanpa Check-in</th><th class="num">Izin/Cuti/Sakit (hari)</th><th class="num">Lembur (jam)</th><th>Kehadiran</th></tr></thead>
      <tbody>${rows.map(g => `<tr class="an-click" data-dept="${esc(g.name)}" title="Klik untuk rincian per karyawan"><td>${esc(g.name)}</td>${rowHtml(g)}</tr>`).join("")}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td>Total</td>${rowHtml(rows.reduce((a, g) => { for (const f of [...FIELDS, "n"]) a[f] += g[f]; return a; }, blank()))}</tr></tfoot>` : ""}
    </table>
    <p class="an-hint">Klik baris departemen untuk melihat rincian per karyawan.${lowData ? " Jumlah check-in masih sedikit, jadi persentase telat belum mewakili tren yang sebenarnya." : ""}</p>`
    : `<p class="an-empty">Belum ada karyawan dengan jadwal kerja pada bulan ini. Atur jadwal di Data Karyawan atau Master Jadwal.</p>`;

  document.getElementById("an-dept-chart").innerHTML = rows.length ? `
    <h3 style="margin:0 0 2px">Komposisi Kehadiran per Departemen</h3>
    <p class="muted small" style="margin:0 0 8px">Porsi dari seluruh hari terjadwal (termasuk izin/cuti). Angka di kanan = tingkat kehadiran.</p>
    <div class="an-legend-inline">${[["Tepat waktu", C.tepat], ["Terlambat", C.telat], ["Izin/cuti", C.izin], ["Tanpa check-in", C.tanpa], ["Belum", C.belum]].map(([l, c]) => `<span><i class="dot" style="background:${c}"></i>${l}</span>`).join("")}</div>
    <div style="margin-top:8px">${rows.map(g => {
      const parts = [["Tepat waktu", g.hadirExp - g.telatExp, C.tepat], ["Terlambat", g.telatExp, C.telat], ["Izin/cuti", g.izin, C.izin], ["Tanpa check-in", g.tanpa, C.tanpa], ["Belum", Math.max(0, g.exp - g.hadirExp - g.tanpa), C.belum]];
      const total = g.exp + g.izin || 1;
      return `<div class="an-hrow"><span class="an-hname" title="${esc(g.name)}">${esc(g.name)}</span>
        <div class="an-hbar" role="img" aria-label="${esc(g.name)}: ${parts.map(([l, v]) => `${l} ${v}`).join(", ")}">${parts.filter(([, v]) => v > 0).map(([l, v, c]) => `<i style="width:${v / total * 100}%;background:${c}" title="${l}: ${v} hari (${Math.round(v / total * 100)}%)"></i>`).join("")}</div>
        <span class="an-hpct">${pct(g.hadirExp, g.exp)}%</span></div>`;
    }).join("")}</div>` : "";

  state.view = { scope, curStats, cur, month };

  // --- data ekspor (per karyawan) ---
  const perPerson = scope.map(p => {
    const st = curStats.get(p.id);
    return {
      "Kode": p.employee_code || "", "Nama": p.full_name, "Departemen": p.department || "-",
      "Hari Terjadwal": st.exp, "Hadir (hari terjadwal)": st.hadirExp, "Total Check-in": st.hadir,
      "Telat": st.telat, "% Telat": st.hadir ? Math.round(st.telat / st.hadir * 100) : 0,
      "Tanpa Check-in (hari)": st.tanpa, "Lupa Check-out": st.lupaOut, "Izin/Cuti/Sakit (hari)": st.izin, "Lembur (jam)": Math.round(st.ot * 10) / 10,
      "% Kehadiran": pct(st.hadirExp, st.exp),
    };
  });
  if (perPerson.length) perPerson.push({
    "Kode": "", "Nama": "TOTAL", "Departemen": "", "Hari Terjadwal": tot.exp, "Hadir (hari terjadwal)": tot.hadirExp,
    "Total Check-in": tot.hadir, "Telat": tot.telat, "% Telat": tot.lateRate ?? 0, "Tanpa Check-in (hari)": tot.tanpa, "Lupa Check-out": tot.lupaOut, "Izin/Cuti/Sakit (hari)": tot.izin,
    "Lembur (jam)": Math.round(tot.ot * 10) / 10, "% Kehadiran": tot.rate ?? 0,
  });
  state.exportRows = perPerson;

  // --- top telat ---
  const nameOf = new Map(people.map(p => [p.id, p]));
  const topLate = scope.map(p => [p.id, curStats.get(p.id).telat]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById("an-late-sub").textContent = `${MONTHS_FULL[cur.m - 1]} ${cur.y}`;
  document.getElementById("an-top-late").innerHTML = topLate.length
    ? `<table class="table"><tbody>${topLate.map(([id, n]) => `<tr><td><button type="button" class="btn-link" data-uid="${esc(id)}">${esc(nameOf.get(id)?.full_name || "-")}</button><div class="muted small">${esc(nameOf.get(id)?.department || "")}</div></td><td style="text-align:right"><span class="badge badge-warn">${n}× telat</span></td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">Tidak ada keterlambatan pada periode ini. 🎉</p>`;

  // --- cuti belum terpakai ---
  const balOf = new Map(balances.map(b => [b.user_id, Math.max(0, Number(b.kuota_hari) - Number(b.terpakai_hari))]));
  const topLeave = [...balOf.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const noQuota = people.filter(p => !balances.some(b => b.user_id === p.id)).length;
  document.getElementById("an-leave-sub").textContent = `Tahun ${year} • ${noQuota} karyawan belum punya kuota`;
  document.getElementById("an-leave").innerHTML = topLeave.length
    ? `<table class="table"><tbody>${topLeave.map(([id, v]) => `<tr><td>${esc(nameOf.get(id)?.full_name || "-")}<div class="muted small">${esc(nameOf.get(id)?.department || "")}</div></td><td style="text-align:right"><span class="badge badge-ok">${fmt1(v)} hari</span></td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">Belum ada data kuota cuti untuk tahun ${year}. Isi lewat menu Kuota Cuti Tahunan.</p>`;
}

const fmtDay = iso => new Date(iso + "T00:00:00Z").toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function openModal(html) {
  const m = document.getElementById("an-modal");
  document.getElementById("an-modal-body").innerHTML = html;
  m.classList.remove("hidden");
  m.querySelector(".modal-box")?.scrollTo?.({ top: 0 });
}
const modalHead = (title, sub = "") => `<div class="an-modal-head"><div><h3>${title}</h3>${sub ? `<div class="muted small">${sub}</div>` : ""}</div><button type="button" class="an-modal-x" data-close aria-label="Tutup" title="Tutup">&times;</button></div>`;

function showDeptDetail(name) {
  const v = state.view; if (!v) return;
  const members = v.scope.filter(p => (p.department || "Tanpa Departemen") === name);
  const body = members.map(p => {
    const st = v.curStats.get(p.id);
    const r = st.exp ? Math.min(100, Math.round(st.hadirExp / st.exp * 100)) : 0;
    return `<tr><td><button type="button" class="btn-link" data-uid="${esc(p.id)}" data-back="${esc(name)}">${esc(p.full_name)}</button></td>
      <td class="num">${st.exp}</td><td class="num">${st.hadirExp}</td><td class="num">${st.telat}</td><td class="num">${st.tanpa}</td><td class="num">${st.izin}</td><td class="num">${fmt1(st.ot)}</td>
      <td><span class="an-meter ${r < 75 ? "danger" : r < 90 ? "warn" : ""}"><i style="width:${r}%"></i></span>${r}%</td></tr>`;
  }).join("");
  openModal(`${modalHead("Rincian " + esc(name), `${MONTHS_FULL[v.cur.m - 1]} ${v.cur.y} • ${members.length} karyawan`)}
    <div class="table-wrap"><table class="table an-tbl" style="min-width:560px"><thead><tr><th>Karyawan</th><th class="num">Hari Terjadwal</th><th class="num">Hadir</th><th class="num">Telat</th><th class="num">Tanpa Check-in</th><th class="num">Izin/Cuti</th><th class="num">Lembur (jam)</th><th>Kehadiran</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="an-hint">Klik nama untuk melihat tanggal-tanggalnya.</p>`);
}

function showPersonDetail(id, backDept = "") {
  const v = state.view; if (!v) return;
  const p = v.scope.find(x => x.id === id); if (!p) return;
  const st = v.curStats.get(id);
  const r = st.exp ? Math.min(100, Math.round(st.hadirExp / st.exp * 100)) : 0;
  const chips = (dates, empty) => dates.length
    ? `<div class="an-chips">${dates.map(d => `<button type="button" class="an-chip" data-go-date="${d}" data-q="${esc(p.full_name)}" title="Buka di Monitor Absensi">${fmtDay(d)}</button>`).join("")}</div>`
    : `<p class="muted small" style="margin:6px 0 14px">${empty}</p>`;
  openModal(`${backDept ? `<button type="button" class="btn-link" data-back-dept="${esc(backDept)}" style="margin-bottom:6px">← Rincian ${esc(backDept)}</button>` : ""}
    ${modalHead(esc(p.full_name), `${esc(p.department || "Tanpa Departemen")} • ${MONTHS_FULL[v.cur.m - 1]} ${v.cur.y}`)}
    <div class="an-sum"><span><b>${st.exp}</b> hari terjadwal</span><span><b>${st.hadirExp}</b> hadir (${r}%)</span><span><b>${st.telat}</b> telat</span><span><b>${st.tanpa}</b> tanpa check-in</span><span><b>${st.izin}</b> izin/cuti</span><span><b>${fmt1(st.ot)}</b> jam lembur</span></div>
    <h4 style="margin:10px 0 0">Tanggal terlambat</h4>${chips(st.lateDates, "Tidak ada keterlambatan.")}
    <h4 style="margin:10px 0 0">Tanggal tanpa check-in</h4>${chips(st.missDates, "Tidak ada hari terjadwal yang terlewat.")}
    <h4 style="margin:10px 0 0">Lupa check-out</h4>${chips(st.lupaOutDates, "Tidak ada.")}
    <p class="an-hint" style="padding-left:0">Klik tanggal untuk membukanya di Monitor Absensi.</p>`);
}

// Buka Monitor Absensi pada tanggal tertentu (pola yang sama dengan "koreksi_prefill").
function goMonitor(date, q) {
  const nav = document.querySelector('.nav-item[data-target="absensi-monitor"]');
  if (!nav) { toast("Menu Monitor Absensi tidak tersedia untuk akun ini.", "error"); return; }
  sessionStorage.setItem("monitor_prefill", JSON.stringify({ date, q }));
  document.getElementById("an-modal")?.classList.add("hidden");
  nav.click();
}

function onExport() {
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  exportXLSX(`analitik-hr-${state.month}${state.dept ? "-" + slug(state.dept) : ""}.xlsx`, state.exportRows, `Analitik ${state.month}`);
}

// ---------- grafik SVG tanpa pustaka ----------
const C = { tepat: "#2E7D4F", telat: "#C98A3E", izin: "#6C8EBF", tanpa: "#B3402A", belum: "#CFCBC0" };

function donut(segs, centerMain, centerSub) {
  const total = segs.reduce((a, x) => a + x.v, 0);
  if (!total) return `<p class="an-empty">Belum ada hari terjadwal pada bulan ini.</p>`;
  const R = 68, SW = 26, CIRC = 2 * Math.PI * R;
  let off = 0;
  const arcs = segs.filter(x => x.v > 0).map(x => {
    const len = x.v / total * CIRC, gap = segs.filter(y => y.v > 0).length > 1 ? 1.5 : 0;
    const el = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${x.c}" stroke-width="${SW}" stroke-dasharray="${Math.max(0, len - gap)} ${CIRC - Math.max(0, len - gap)}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(x.l)}: ${x.v} hari (${Math.round(x.v / total * 100)}%)</title></circle>`;
    off += len;
    return el;
  }).join("");
  return `<div class="an-donut-wrap">
    <svg viewBox="0 0 200 200" role="img" aria-label="Komposisi kehadiran: ${segs.filter(x => x.v > 0).map(x => `${x.l} ${x.v}`).join(", ")}">
      <circle cx="100" cy="100" r="${R}" fill="none" stroke="#ECEAE4" stroke-width="${SW}"/>${arcs}
      <text x="100" y="104" text-anchor="middle" class="an-donut-center">${esc(centerMain)}</text>
      <text x="100" y="124" text-anchor="middle" style="font-size:12px">${esc(centerSub)}</text>
    </svg>
    <ul class="an-legend">${segs.map(x => `<li><i class="dot" style="background:${x.c}"></i>${esc(x.l)}<span class="n">${x.v} <span class="muted">(${Math.round(x.v / total * 100)}%)</span></span></li>`).join("")}</ul>
  </div>`;
}

// series: [{ name, color, values (null = tidak ada data), area?, tips? }], skala 0–100 (%).
function lineChart({ labels, series, valueLabels = false, tickEvery = 1 }) {
  const W = 420, H = 210, L = 32, Rr = 12, T = 16, B = 26;
  const iw = W - L - Rr, ih = H - T - B, n = labels.length;
  const x = i => L + (n === 1 ? iw / 2 : i * iw / (n - 1));
  const y = v => T + ih - Math.min(Math.max(v, 0), 100) / 100 * ih;
  const grid = [0, 25, 50, 75, 100].map(v => `<line class="an-grid" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`).join("");
  const xl = labels.map((l, i) => (i % tickEvery === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : "")).join("");
  const body = series.map((sr, si) => {
    const segs = []; let cur = [];
    sr.values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([i, v]); });
    if (cur.length) segs.push(cur);
    const lines = segs.map(sg => sg.length > 1 ? `<polyline fill="none" stroke="${sr.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${sg.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")}"/>` : "").join("");
    const areas = sr.area ? segs.filter(sg => sg.length > 1).map(sg => `<path d="M${x(sg[0][0])},${y(0)} ${sg.map(([i, v]) => `L${x(i)},${y(v)}`).join(" ")} L${x(sg[sg.length - 1][0])},${y(0)} Z" fill="${sr.color}" opacity=".12"/>`).join("") : "";
    const dots = sr.values.map((v, i) => v == null ? "" : `<circle cx="${x(i)}" cy="${y(v)}" r="${n > 14 ? 2 : 3.2}" fill="${sr.color}" stroke="#fff" stroke-width="1"><title>${esc(sr.tips?.[i] || `${labels[i]} • ${sr.name}: ${v}%`)}</title></circle>`).join("");
    const vals = valueLabels ? sr.values.map((v, i) => v == null ? "" : `<text class="an-val" x="${x(i)}" y="${y(v) + (si === 0 ? -8 : 14)}" text-anchor="middle">${v}%</text>`).join("") : "";
    return areas + lines + dots + vals;
  }).join("");
  return `<svg class="an-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(" dan "))} per periode">${grid}${xl}${body}</svg>
    <div class="an-legend-inline">${series.map(sr => `<span><i class="dot" style="background:${sr.color}"></i>${esc(sr.name)}</span>`).join("")}</div>`;
}

function bars(series, unit) {
  const max = Math.max(...series.map(s => s.val), 1);
  return `<div class="an-bars">${series.map((s, i) => {
    const mm = Number(s.ym.split("-")[1]);
    const h = Math.round(s.val / max * 100);
    return `<div class="an-bar-col"><span class="an-bar-val">${s.has ? fmt1(s.val) + unit.trim() : "-"}</span><div class="an-bar ${i === series.length - 1 ? "cur" : ""}" style="height:${h}%"></div><span class="an-bar-lbl">${MONTHS[mm - 1]}</span></div>`;
  }).join("")}</div>`;
}
