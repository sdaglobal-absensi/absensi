import { supabase } from "../supabaseClient.js";
import { dateOnlyISO, dayOfWeekFromDateStr, exportXLSX } from "../core.js";

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

let state = { profiles: [], holidays: new Set(), working: {}, hist: {}, month: "", dept: "", exportRows: [] };
let reqToken = 0;

export async function render(container) {
  const nowISO = dateOnlyISO(new Date());
  state.month = nowISO.slice(0, 7);
  state.dept = "";

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
        <button type="button" id="an-export" class="btn-secondary">⬇ Ekspor Excel</button>
      </div>
    </div>

    <div class="status-grid" id="an-kpi"><p class="muted">Memuat…</p></div>
    <p class="an-note" id="an-meta"></p>

    <div class="an-grid2">
      <div class="an-panel"><h3>Tren Keterlambatan</h3><p class="muted small">% check-in yang telat, 6 bulan terakhir</p><div id="an-trend-late"></div></div>
      <div class="an-panel"><h3>Tren Lembur</h3><p class="muted small">Total jam lembur disetujui, 6 bulan terakhir</p><div id="an-trend-ot"></div></div>
    </div>

    <h2 class="dash-section-title">Absensi per Departemen</h2>
    <div id="an-dept-table" class="table-wrap"><p class="muted" style="padding:16px">Memuat…</p></div>

    <div class="an-grid2" style="margin-top:24px">
      <div class="an-panel"><h3>Karyawan Paling Sering Telat</h3><p class="muted small" id="an-late-sub"></p><div id="an-top-late"></div></div>
      <div class="an-panel"><h3>Cuti Tahunan Belum Terpakai</h3><p class="muted small" id="an-leave-sub"></p><div id="an-leave"></div></div>
    </div>
  `;

  document.getElementById("an-month").addEventListener("change", e => { if (e.target.value) { state.month = e.target.value; load(); } });
  document.getElementById("an-dept").addEventListener("change", e => { state.dept = e.target.value; load(); });
  document.getElementById("an-export").addEventListener("click", onExport);

  await loadStatic();
  load();
}

// ---------- data umum (sekali per halaman dibuka) ----------
async function loadStatic() {
  const [{ data: profiles }, { data: holidays }, schedDays, hist] = await Promise.all([
    supabase.from("profiles").select("id, full_name, employee_code, department, join_date, resign_date, schedule_id").eq("is_active", true).order("full_name"),
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
    out.set(p.id, {
      hasSched,
      exp: exp.size,
      izin,
      hadir: mine.length,
      hadirExp: mine.filter(a => exp.has(a.date)).length,
      telat: mine.filter(a => a.check_in_status === "telat").length,
      ot: (otBy.get(p.id) || []).reduce((s, o) => s + otHours(o), 0),
    });
  }
  return out;
}

function totalsOf(stats, scope) {
  const t = { exp: 0, hadir: 0, hadirExp: 0, telat: 0, izin: 0, ot: 0 };
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

  const people = state.profiles.filter(p => !dept || p.department === dept);
  const ids = new Set(people.map(p => p.id));

  let att, leaves, ots, balances, ovrRows;
  try {
    [att, leaves, ots, balances, ovrRows] = await Promise.all([
      fetchAll(() => supabase.from("attendance").select("user_id, date, check_in, check_in_status").gte("date", trendStart).lte("date", cur.end).order("date")),
      fetchAll(() => supabase.from("leave_requests").select("user_id, start_date, end_date").eq("status", "approved").lte("start_date", cur.end).gte("end_date", prev.start)),
      fetchAll(() => supabase.from("overtime_requests").select("user_id, date, start_time, end_time, total_jam").eq("status", "approved").gte("date", trendStart).lte("date", cur.end)),
      fetchAll(() => supabase.from("leave_balances").select("user_id, kuota_hari, terpakai_hari").eq("tahun", year)),
      fetchAll(() => supabase.from("schedule_overrides").select("user_id, work_date, schedule_id").gte("work_date", prev.start).lte("work_date", cur.end).order("work_date")).catch(() => []), // tukar shift (opsional)
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
  const prevTot = totalsOf(analyze(prev, scope, data), scope);
  const prevLabel = MONTHS[prev.m - 1];

  const lowData = tot.hadir > 0 && tot.hadir < 10;
  const otCmp = !isCurrentMonth && (tot.ot > 0 || prevTot.ot > 0) ? deltaChip(tot.ot, prevTot.ot, { unit: " jam", digits: 1, label: prevLabel }) : "";
  const sisaTotal = balances.reduce((s, b) => s + Math.max(0, Number(b.kuota_hari) - Number(b.terpakai_hari)), 0);

  document.getElementById("an-kpi").innerHTML = `
    <div class="status-card ${tot.rate != null && tot.rate >= 90 ? "done" : ""}"><span class="status-label">Tingkat Kehadiran</span><span class="status-value">${tot.rate ?? "–"}${tot.rate != null ? "%" : ""}</span><span class="muted small">${tot.hadirExp} hadir dari ${tot.exp} hari terjadwal</span>${prevTot.exp ? deltaChip(tot.rate, prevTot.rate, { higherBetter: true, unit: " poin", label: prevLabel }) : ""}</div>
    <div class="status-card"><span class="status-label">Tingkat Keterlambatan</span><span class="status-value">${tot.lateRate ?? "–"}${tot.lateRate != null ? "%" : ""}</span><span class="muted small">${tot.telat} dari ${tot.hadir} check-in${lowData ? ` · <span class="an-lowdata">data masih sedikit</span>` : ""}</span>${prevTot.hadir ? deltaChip(tot.lateRate, prevTot.lateRate, { higherBetter: false, unit: " poin", label: prevLabel }) : ""}</div>
    <div class="status-card"><span class="status-label">Total Lembur Disetujui</span><span class="status-value">${fmt1(tot.ot)} jam</span><span class="muted small">${MONTHS_FULL[cur.m - 1]} ${cur.y}</span>${otCmp}</div>
    <div class="status-card"><span class="status-label">Cuti Belum Terpakai</span><span class="status-value">${fmt1(sisaTotal)} hari</span><span class="muted small">Cuti Tahunan ${year}, ${people.length} karyawan</span></div>`;
  document.getElementById("an-meta").textContent =
    `${scope.length} karyawan dipantau${dept ? " di " + dept : ""}${excluded ? ` • ${excluded} karyawan tanpa jadwal kerja pada bulan ini tidak dihitung` : ""}. ` +
    `Hari terjadwal dihitung per karyawan sesuai jadwal kerjanya, di luar Master Hari Libur dan izin/cuti yang disetujui${isCurrentMonth ? ", sampai hari ini" : ""}.`;

  // --- tren 6 bulan ---
  const attScope = att.filter(a => scopeIds.has(a.user_id));
  const otScope = ots.filter(o => scopeIds.has(o.user_id));
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const lateSeries = months.map(ym => {
    const rows = attScope.filter(a => a.date.startsWith(ym));
    return { ym, val: rows.length ? Math.round(rows.filter(a => a.check_in_status === "telat").length / rows.length * 100) : 0, has: rows.length > 0 };
  });
  const otSeries = months.map(ym => ({ ym, val: otScope.filter(o => o.date.startsWith(ym)).reduce((s, o) => s + otHours(o), 0), has: true }));
  document.getElementById("an-trend-late").innerHTML = lateSeries.some(x => x.has) ? bars(lateSeries, "%") : `<p class="an-empty">Belum ada data check-in dalam 6 bulan terakhir.</p>`;
  document.getElementById("an-trend-ot").innerHTML = otSeries.some(x => x.val > 0) ? bars(otSeries, " jam") : `<p class="an-empty">Belum ada lembur disetujui dalam 6 bulan terakhir.</p>`;

  // --- per departemen ---
  const groups = new Map();
  for (const p of scope) {
    const k = p.department || "Tanpa Departemen";
    if (!groups.has(k)) groups.set(k, { name: k, n: 0, exp: 0, hadir: 0, hadirExp: 0, telat: 0, izin: 0, ot: 0 });
    const g = groups.get(k), st = curStats.get(p.id);
    g.n++; for (const f of ["exp", "hadir", "hadirExp", "telat", "izin", "ot"]) g[f] += st[f];
  }
  const rows = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pct = (a, b) => (b ? Math.min(100, Math.round(a / b * 100)) : 0);
  const rowHtml = g => {
    const r = pct(g.hadirExp, g.exp);
    const lr = g.hadir ? Math.round(g.telat / g.hadir * 100) : 0;
    return `<td>${g.n}</td><td class="num">${g.exp}</td><td class="num">${g.hadirExp}</td><td class="num">${g.telat}</td>
      <td class="num"><span class="badge ${lr >= 20 ? "badge-danger" : lr >= 10 ? "badge-warn" : "badge-ok"}">${lr}%</span></td>
      <td class="num">${g.izin}</td><td class="num">${fmt1(g.ot)}</td>
      <td><span class="an-meter ${r < 75 ? "danger" : r < 90 ? "warn" : ""}"><i style="width:${r}%"></i></span>${r}%</td>`;
  };
  document.getElementById("an-dept-table").innerHTML = rows.length ? `
    <table class="table an-tbl">
      <thead><tr><th>Departemen</th><th>Karyawan</th><th class="num">Hari Terjadwal</th><th class="num">Hadir</th><th class="num">Telat</th><th class="num">% Telat</th><th class="num">Izin/Cuti/Sakit (hari)</th><th class="num">Lembur (jam)</th><th>Kehadiran</th></tr></thead>
      <tbody>${rows.map(g => `<tr><td>${esc(g.name)}</td>${rowHtml(g)}</tr>`).join("")}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td>Total</td>${rowHtml(rows.reduce((a, g) => { for (const f of ["n", "exp", "hadir", "hadirExp", "telat", "izin", "ot"]) a[f] += g[f]; return a; }, { n: 0, exp: 0, hadir: 0, hadirExp: 0, telat: 0, izin: 0, ot: 0 }))}</tr></tfoot>` : ""}
    </table>${lowData ? `<p class="an-note" style="padding:0 16px 12px">Catatan: jumlah check-in masih sedikit, jadi persentase telat belum mewakili tren yang sebenarnya.</p>` : ""}`
    : `<p class="an-empty">Belum ada karyawan dengan jadwal kerja pada bulan ini. Atur jadwal di Data Karyawan atau Master Jadwal.</p>`;

  // --- data ekspor (per karyawan) ---
  const perPerson = scope.map(p => {
    const st = curStats.get(p.id);
    return {
      "Kode": p.employee_code || "", "Nama": p.full_name, "Departemen": p.department || "-",
      "Hari Terjadwal": st.exp, "Hadir (hari terjadwal)": st.hadirExp, "Total Check-in": st.hadir,
      "Telat": st.telat, "% Telat": st.hadir ? Math.round(st.telat / st.hadir * 100) : 0,
      "Izin/Cuti/Sakit (hari)": st.izin, "Lembur (jam)": Math.round(st.ot * 10) / 10,
      "% Kehadiran": pct(st.hadirExp, st.exp),
    };
  });
  if (perPerson.length) perPerson.push({
    "Kode": "", "Nama": "TOTAL", "Departemen": "", "Hari Terjadwal": tot.exp, "Hadir (hari terjadwal)": tot.hadirExp,
    "Total Check-in": tot.hadir, "Telat": tot.telat, "% Telat": tot.lateRate ?? 0, "Izin/Cuti/Sakit (hari)": tot.izin,
    "Lembur (jam)": Math.round(tot.ot * 10) / 10, "% Kehadiran": tot.rate ?? 0,
  });
  state.exportRows = perPerson;

  // --- top telat ---
  const nameOf = new Map(people.map(p => [p.id, p]));
  const topLate = scope.map(p => [p.id, curStats.get(p.id).telat]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById("an-late-sub").textContent = `${MONTHS_FULL[cur.m - 1]} ${cur.y}`;
  document.getElementById("an-top-late").innerHTML = topLate.length
    ? `<table class="table"><tbody>${topLate.map(([id, n]) => `<tr><td>${esc(nameOf.get(id)?.full_name || "-")}<div class="muted small">${esc(nameOf.get(id)?.department || "")}</div></td><td style="text-align:right"><span class="badge badge-warn">${n}× telat</span></td></tr>`).join("")}</tbody></table>`
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

function onExport() {
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  exportXLSX(`analitik-hr-${state.month}${state.dept ? "-" + slug(state.dept) : ""}.xlsx`, state.exportRows, `Analitik ${state.month}`);
}

function bars(series, unit) {
  const max = Math.max(...series.map(s => s.val), 1);
  return `<div class="an-bars">${series.map((s, i) => {
    const mm = Number(s.ym.split("-")[1]);
    const h = Math.round(s.val / max * 100);
    return `<div class="an-bar-col"><span class="an-bar-val">${s.has ? fmt1(s.val) + unit.trim() : "-"}</span><div class="an-bar ${i === series.length - 1 ? "cur" : ""}" style="height:${h}%"></div><span class="an-bar-lbl">${MONTHS[mm - 1]}</span></div>`;
  }).join("")}</div>`;
}
