import { supabase } from "../supabaseClient.js";
import { dateOnlyISO } from "../core.js";

// =======================================================================
// Dashboard Analitik HR (Prioritas Menengah #7)
// Hanya MENAMPILKAN data yang sudah ada: attendance, leave_requests,
// overtime_requests, leave_balances, holidays, profiles. Tidak ada tabel baru.
// Yang bisa dilihat mengikuti RLS yang sudah ada (staf HR melihat seluruh
// karyawan; role lain hanya melihat datanya sendiri).
// =======================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTHS_FULL = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString("id-ID");

let state = { profiles: [], holidays: new Set(), month: "", dept: "" };
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

  await loadStatic();
  load();
}

// ---------- data umum (sekali per halaman dibuka) ----------
async function loadStatic() {
  const [{ data: profiles }, { data: holidays }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, department").eq("is_active", true).order("full_name"),
    supabase.from("holidays").select("date").eq("is_active", true),
  ]);
  state.profiles = profiles || [];
  state.holidays = new Set((holidays || []).map(h => h.date));
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

// Hari kerja (Senin–Sabtu, di luar Master Hari Libur). Untuk bulan berjalan
// hanya dihitung sampai hari ini supaya persentase tidak terlihat rendah.
function workingDays(ym) {
  const { y, m, end } = monthRange(ym);
  const todayISO = dateOnlyISO(new Date());
  const last = end < todayISO ? end : todayISO;
  let n = 0;
  for (let d = new Date(y, m - 1, 1); dateOnlyISO(d) <= last; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0) continue;
    if (state.holidays.has(dateOnlyISO(d))) continue;
    n++;
  }
  return n;
}

function overlapDays(startStr, endStr, rangeStart, rangeEnd) {
  const s = startStr > rangeStart ? startStr : rangeStart;
  const e = endStr < rangeEnd ? endStr : rangeEnd;
  if (e < s) return 0;
  return Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
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
  const trendStart = monthRange(shiftMonth(month, -5)).start;
  const year = cur.y;

  const people = state.profiles.filter(p => !dept || p.department === dept);
  const ids = new Set(people.map(p => p.id));

  let att, leaves, ots, balances;
  try {
    [att, leaves, ots, balances] = await Promise.all([
      fetchAll(() => supabase.from("attendance").select("user_id, date, check_in, check_in_status").gte("date", trendStart).lte("date", cur.end).order("date")),
      fetchAll(() => supabase.from("leave_requests").select("user_id, start_date, end_date").eq("status", "approved").lte("start_date", cur.end).gte("end_date", cur.start)),
      fetchAll(() => supabase.from("overtime_requests").select("user_id, date, start_time, end_time, total_jam").eq("status", "approved").gte("date", trendStart).lte("date", cur.end)),
      fetchAll(() => supabase.from("leave_balances").select("user_id, kuota_hari, terpakai_hari").eq("tahun", year)),
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

  const wd = workingDays(month);
  const attMonth = att.filter(a => a.date >= cur.start && a.date <= cur.end);

  // --- KPI bulan terpilih ---
  const hadir = attMonth.length;
  const telat = attMonth.filter(a => a.check_in_status === "telat").length;
  const expected = wd * people.length;
  const rate = expected ? Math.min(100, Math.round(hadir / expected * 100)) : 0;
  const lateRate = hadir ? Math.round(telat / hadir * 100) : 0;
  const otMonth = ots.filter(o => o.date >= cur.start && o.date <= cur.end).reduce((s, o) => s + otHours(o), 0);
  const sisaTotal = balances.reduce((s, b) => s + Math.max(0, Number(b.kuota_hari) - Number(b.terpakai_hari)), 0);

  document.getElementById("an-kpi").innerHTML = `
    <div class="status-card ${rate >= 90 ? "done" : ""}"><span class="status-label">Tingkat Kehadiran</span><span class="status-value">${rate}%</span><span class="muted small">${hadir} check-in dari ${expected} hari-orang</span></div>
    <div class="status-card"><span class="status-label">Tingkat Keterlambatan</span><span class="status-value">${lateRate}%</span><span class="muted small">${telat} dari ${hadir} check-in</span></div>
    <div class="status-card"><span class="status-label">Total Lembur Disetujui</span><span class="status-value">${fmt1(otMonth)} jam</span><span class="muted small">${MONTHS_FULL[cur.m - 1]} ${cur.y}</span></div>
    <div class="status-card"><span class="status-label">Cuti Belum Terpakai</span><span class="status-value">${fmt1(sisaTotal)} hari</span><span class="muted small">Cuti Tahunan ${year}, ${people.length} karyawan</span></div>`;
  document.getElementById("an-meta").textContent =
    `${people.length} karyawan aktif${dept ? " di " + dept : ""}. Estimasi hari kerja: ${wd} hari (Senin–Sabtu, di luar Master Hari Libur${month === dateOnlyISO(new Date()).slice(0, 7) ? ", dihitung sampai hari ini" : ""}).`;

  // --- tren 6 bulan ---
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const lateSeries = months.map(ym => {
    const rows = att.filter(a => a.date.startsWith(ym));
    return { ym, val: rows.length ? Math.round(rows.filter(a => a.check_in_status === "telat").length / rows.length * 100) : 0, has: rows.length > 0 };
  });
  const otSeries = months.map(ym => ({ ym, val: ots.filter(o => o.date.startsWith(ym)).reduce((s, o) => s + otHours(o), 0), has: true }));
  document.getElementById("an-trend-late").innerHTML = bars(lateSeries, "%");
  document.getElementById("an-trend-ot").innerHTML = bars(otSeries, " jam");

  // --- per departemen ---
  const groups = new Map();
  for (const p of people) {
    const k = p.department || "Tanpa Departemen";
    if (!groups.has(k)) groups.set(k, { name: k, ids: new Set(), hadir: 0, telat: 0, izin: 0, ot: 0 });
    groups.get(k).ids.add(p.id);
  }
  const deptOf = new Map(people.map(p => [p.id, p.department || "Tanpa Departemen"]));
  for (const a of attMonth) { const g = groups.get(deptOf.get(a.user_id)); if (g) { g.hadir++; if (a.check_in_status === "telat") g.telat++; } }
  for (const l of leaves) { const g = groups.get(deptOf.get(l.user_id)); if (g) g.izin += overlapDays(l.start_date, l.end_date, cur.start, cur.end); }
  for (const o of ots) { if (o.date < cur.start || o.date > cur.end) continue; const g = groups.get(deptOf.get(o.user_id)); if (g) g.ot += otHours(o); }

  const rows = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("an-dept-table").innerHTML = rows.length ? `
    <table>
      <thead><tr><th>Departemen</th><th>Karyawan</th><th>Hadir</th><th>Telat</th><th>% Telat</th><th>Izin/Cuti/Sakit (hari)</th><th>Lembur (jam)</th><th>Kehadiran</th></tr></thead>
      <tbody>${rows.map(g => {
        const exp = wd * g.ids.size;
        const r = exp ? Math.min(100, Math.round(g.hadir / exp * 100)) : 0;
        const lr = g.hadir ? Math.round(g.telat / g.hadir * 100) : 0;
        return `<tr><td>${esc(g.name)}</td><td>${g.ids.size}</td><td>${g.hadir}</td><td>${g.telat}</td>
          <td><span class="badge ${lr >= 20 ? "badge-danger" : lr >= 10 ? "badge-warn" : "badge-ok"}">${lr}%</span></td>
          <td>${g.izin}</td><td>${fmt1(g.ot)}</td>
          <td><span class="an-meter ${r < 75 ? "danger" : r < 90 ? "warn" : ""}"><i style="width:${r}%"></i></span>${r}%</td></tr>`;
      }).join("")}</tbody>
    </table>` : `<p class="muted" style="padding:16px">Tidak ada karyawan.</p>`;

  // --- top telat ---
  const lateBy = new Map();
  for (const a of attMonth) if (a.check_in_status === "telat") lateBy.set(a.user_id, (lateBy.get(a.user_id) || 0) + 1);
  const nameOf = new Map(people.map(p => [p.id, p]));
  const topLate = [...lateBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById("an-late-sub").textContent = `${MONTHS_FULL[cur.m - 1]} ${cur.y}`;
  document.getElementById("an-top-late").innerHTML = topLate.length
    ? `<table><tbody>${topLate.map(([id, n]) => `<tr><td>${esc(nameOf.get(id)?.full_name || "-")}<div class="muted small">${esc(nameOf.get(id)?.department || "")}</div></td><td style="text-align:right"><span class="badge badge-warn">${n}× telat</span></td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">Tidak ada keterlambatan pada periode ini. 🎉</p>`;

  // --- cuti belum terpakai ---
  const balOf = new Map(balances.map(b => [b.user_id, Math.max(0, Number(b.kuota_hari) - Number(b.terpakai_hari))]));
  const topLeave = [...balOf.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const noQuota = people.filter(p => !balances.some(b => b.user_id === p.id)).length;
  document.getElementById("an-leave-sub").textContent = `Tahun ${year} • ${noQuota} karyawan belum punya kuota`;
  document.getElementById("an-leave").innerHTML = topLeave.length
    ? `<table><tbody>${topLeave.map(([id, v]) => `<tr><td>${esc(nameOf.get(id)?.full_name || "-")}<div class="muted small">${esc(nameOf.get(id)?.department || "")}</div></td><td style="text-align:right"><span class="badge badge-ok">${fmt1(v)} hari</span></td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">Belum ada data kuota cuti untuk tahun ${year}. Isi lewat menu Kuota Cuti Tahunan.</p>`;
}

function bars(series, unit) {
  const max = Math.max(...series.map(s => s.val), 1);
  return `<div class="an-bars">${series.map((s, i) => {
    const mm = Number(s.ym.split("-")[1]);
    const h = Math.round(s.val / max * 100);
    return `<div class="an-bar-col"><span class="an-bar-val">${s.has ? fmt1(s.val) + unit.trim() : "-"}</span><div class="an-bar ${i === series.length - 1 ? "cur" : ""}" style="height:${h}%"></div><span class="an-bar-lbl">${MONTHS[mm - 1]}</span></div>`;
  }).join("")}</div>`;
}
