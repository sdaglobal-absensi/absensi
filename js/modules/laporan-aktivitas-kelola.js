import { supabase } from "../supabaseClient.js";
import { toast, todayISO, escapeHtml, confirmDialog, exportXLSX, fetchAllRows } from "../core.js";
import { addDaysISO } from "../laporanHarian.js";
import { fetchDailyContext } from "../dailyAttendanceData.js";
import { printSlip } from "./admin-slip-gaji.js";
import {
  SECTION_KINDS, KIND_KEYS, normalizeSections, normalizeData, presetFields,
  completeness, flattenReport, reportStatus, REPORT_STATUS_LABEL, isLateSubmission,
} from "../laporanAktivitas.js";
import { renderReadonlySections } from "../laporanAktivitasView.js";

// =======================================================================
// LAPORAN AKTIVITAS (pengelola) — tiga hal:
//   Rekap     : siapa yang sudah / belum mengisi pada satu tanggal, baca laporan,
//               tandai "Ditinjau" + catatan, ekspor Excel.
//   Template  : HR membuat/mengubah template laporan per jabatan sendiri (pilih bagian,
//               tulis baris bawaan). Tidak ada isi template yang ditentukan oleh sistem.
//   Penugasan : pilih karyawan pemakai tiap template (1 karyawan = 1 template).
// "Wajib lapor" pada rekap = karyawan bertemplate wajib yang TERJADWAL hari itu
// dan tidak sedang izin/cuti yang disetujui (aturan sama dengan Laporan Harian).
// =======================================================================

const esc = escapeHtml;
const $ = id => document.getElementById(id);
const fmtDateTime = iso => new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtLong = iso => new Date(iso + "T00:00:00Z").toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

let me = null;
let R = null;   // state rekap
let T = null;   // state template

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="pg-head no-print">
      <div>
        <h1>Laporan Aktivitas</h1>
        <p class="pg-head-sub">Pantau laporan aktivitas harian karyawan, kelola template per jabatan, dan tentukan siapa memakai template yang mana.</p>
      </div>
    </div>
    <div class="tabs no-print" role="tablist" style="margin-bottom:16px;">
      <button type="button" class="tab-btn" role="tab" data-tab="rekap">Rekap Harian</button>
      <button type="button" class="tab-btn" role="tab" data-tab="template">Template &amp; Pengguna</button>
    </div>
    <div id="lk-host"></div>
    <div id="lk-modals"></div>`;
  const show = tab => {
    try { sessionStorage.setItem("lapaktivitas_tab", tab); } catch { /* abaikan */ }
    container.querySelectorAll(".tab-btn").forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    return tab === "template" ? renderTemplates() : renderRekap();
  };
  container.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
  let first = "rekap";
  try { first = sessionStorage.getItem("lapaktivitas_tab") === "template" ? "template" : "rekap"; } catch { /* abaikan */ }
  return show(first);
}

// =======================================================================
// REKAP HARIAN
// =======================================================================
async function renderRekap() {
  const today = todayISO();
  R = { today, date: today, rows: [], tplById: new Map(), view: null };
  $("lk-host").innerHTML = `
    <div class="pg-toolbar no-print">
      <div class="filter-row" style="flex-wrap:wrap;">
        <button type="button" id="rk-prev" class="btn-secondary" aria-label="Hari sebelumnya" title="Hari sebelumnya">◀</button>
        <input type="date" id="rk-date" max="${today}" value="${today}">
        <button type="button" id="rk-next" class="btn-secondary" aria-label="Hari berikutnya" title="Hari berikutnya">▶</button>
        <button type="button" id="rk-today" class="btn-secondary">Hari ini</button>
        <select id="rk-dept"><option value="">Semua Departemen</option></select>
        <select id="rk-tpl"><option value="">Semua Template</option></select>
        <select id="rk-status">
          <option value="">Semua Status</option>
          <option value="belum">Belum mengisi</option>
          <option value="draf">Draf</option>
          <option value="terkirim">Terkirim (belum ditinjau)</option>
          <option value="ditinjau">Ditinjau</option>
          <option value="tidak_wajib">Tidak wajib hari ini</option>
        </select>
        <input type="search" id="rk-q" placeholder="Cari nama…" style="max-width:200px;">
        <button type="button" id="rk-xlsx-rekap" class="btn-secondary">Export Rekap</button>
        <button type="button" id="rk-xlsx-detail" class="btn-secondary">Export Isi Laporan</button>
      </div>
    </div>
    <div class="status-grid" id="rk-summary"><p class="muted">Memuat…</p></div>
    <p class="report-meta" id="rk-meta"></p>
    <div id="rk-table" class="table-wrap"><p class="muted">Memuat…</p></div>`;

  const go = iso => { const d = !iso ? R.today : iso > R.today ? R.today : iso; $("rk-date").value = d; loadRekap(); };
  $("rk-date").addEventListener("change", e => go(e.target.value));
  const cur = () => $("rk-date").value || R.date || R.today;
  $("rk-prev").addEventListener("click", () => go(addDaysISO(cur(), -1)));
  $("rk-next").addEventListener("click", () => go(addDaysISO(cur(), 1)));
  $("rk-today").addEventListener("click", () => go(R.today));
  ["rk-dept", "rk-tpl", "rk-status"].forEach(id => $(id).addEventListener("change", () => { renderRekapSummary(); renderRekapTable(); }));
  $("rk-q").addEventListener("input", renderRekapTable);
  $("rk-xlsx-rekap").addEventListener("click", exportRekap);
  $("rk-xlsx-detail").addEventListener("click", exportDetail);
  $("rk-summary").addEventListener("click", e => {
    const c = e.target.closest("[data-filter]");
    if (!c) return;
    const sel = $("rk-status");
    sel.value = sel.value === c.dataset.filter ? "" : c.dataset.filter;
    renderRekapSummary(); renderRekapTable();
  });
  $("rk-table").addEventListener("click", e => {
    const b = e.target.closest("[data-open]");
    if (b) openReport(b.dataset.open);
  });
  await loadRekap();
}

async function loadRekap() {
  const token = (R.token = (R.token || 0) + 1);
  const date = $("rk-date").value || R.today;
  R.date = date;
  $("rk-next").disabled = date >= R.today;
  $("rk-table").innerHTML = `<p class="muted">Memuat…</p>`;
  let ctx, asg, tpls, reps;
  try {
    [ctx, asg, tpls, reps] = await Promise.all([
      fetchDailyContext(date, R.today),
      fetchAllRows(() => supabase.from("daily_report_assignments").select("user_id, template_id").order("user_id")),
      fetchAllRows(() => supabase.from("daily_report_templates").select("*").order("name")),
      fetchAllRows(() => supabase.from("daily_reports").select("*").eq("report_date", date).order("user_id")),
    ]);
  } catch (e) {
    if (token !== R.token) return;
    $("rk-table").innerHTML = `<p class="muted">Gagal memuat rekap: ${esc(e.message || e)}. Pastikan SQL <b>024_laporan_aktivitas.sql</b> sudah dijalankan.</p>`;
    $("rk-summary").innerHTML = "";
    return;
  }
  if (token !== R.token) return;

  R.tplById = new Map(tpls.map(t => [t.id, t]));
  const empById = new Map(ctx.emps.map(e => [e.id, e]));
  const attStatus = new Map(ctx.rows.map(r => [r.emp.id, r.status])); // hanya karyawan terjadwal / yang check-in
  const repBy = new Map(reps.map(r => [r.user_id, r]));
  R.holiday = ctx.holiday;

  R.rows = asg.map(a => {
    const emp = empById.get(a.user_id);
    const tpl = R.tplById.get(a.template_id);
    if (!emp || !tpl) return null;
    const st = attStatus.get(a.user_id);
    const expected = !!tpl.wajib && !!tpl.is_active && !!st && st !== "libur" && st !== "izin";
    const report = repBy.get(a.user_id) || null;
    let pct = null;
    if (report) {
      const sections = normalizeSections(report.template_snapshot?.sections);
      pct = completeness(sections, normalizeData(sections, report.data)).pct;
    }
    return { emp, tpl, report, expected, status: reportStatus(report, expected), pct, late: isLateSubmission(report) };
  }).filter(Boolean).sort((a, b) => a.emp.full_name.localeCompare(b.emp.full_name));
  R.noAssign = ctx.emps.filter(e => !asg.some(a => a.user_id === e.id)).length;

  const fill = (id, label, opts) => {
    const el = $(id), prev = el.value;
    el.innerHTML = `<option value="">${label}</option>` + opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    el.value = opts.some(([v]) => v === prev) ? prev : "";
  };
  fill("rk-dept", "Semua Departemen", [...new Set(R.rows.map(r => r.emp.department).filter(Boolean))].sort().map(d => [d, d]));
  fill("rk-tpl", "Semua Template", tpls.filter(t => R.rows.some(r => r.tpl.id === t.id)).map(t => [t.id, t.name]));
  renderRekapSummary();
  renderRekapTable();
}

const rekapScope = () => {
  const dept = $("rk-dept").value, tpl = $("rk-tpl").value;
  return R.rows.filter(r => (!dept || r.emp.department === dept) && (!tpl || r.tpl.id === tpl));
};
const rekapVisible = () => {
  const st = $("rk-status").value, q = $("rk-q").value.trim().toLowerCase();
  return rekapScope().filter(r => !st || r.status === st).filter(r => !q || r.emp.full_name.toLowerCase().includes(q));
};

function renderRekapSummary() {
  const rows = rekapScope();
  const n = s => rows.filter(r => r.status === s).length;
  const wajib = rows.filter(r => r.expected).length;
  const sudah = rows.filter(r => r.expected && (r.status === "terkirim" || r.status === "ditinjau")).length;
  const active = $("rk-status").value;
  const card = (label, value, filter, sub = "", cls = "") =>
    `<div class="status-card clickable ${cls} ${active === filter ? "active" : ""}" data-filter="${filter}" role="button" tabindex="0" title="Klik untuk menyaring tabel">
      <span class="status-label">${label}</span><span class="status-value">${value}</span>${sub ? `<span class="muted small">${sub}</span>` : ""}</div>`;
  $("rk-summary").innerHTML =
    `<div class="status-card"><span class="status-label">Wajib Lapor</span><span class="status-value">${wajib}</span><span class="muted small">terjadwal & tidak izin/cuti</span></div>` +
    card("Sudah Mengirim", sudah, "terkirim", wajib ? `${Math.round(sudah / wajib * 100)}% dari yang wajib` : "", wajib && sudah === wajib ? "done" : "") +
    card("Belum Mengisi", n("belum"), "belum", R.date < R.today ? "melewati hari laporan" : "") +
    card("Draf", n("draf"), "draf") +
    card("Sudah Ditinjau", n("ditinjau"), "ditinjau");
  const notes = [];
  if (R.holiday) notes.push(`${fmtLong(R.date)} adalah hari libur (${R.holiday.name}).`);
  if (R.noAssign) notes.push(`${R.noAssign} karyawan aktif belum dipasangkan dengan template (atur di tab Template & Pengguna).`);
  $("rk-meta").textContent = notes.join(" ");
}

const STATUS_BADGE = { belum: "badge-danger", draf: "badge-warn", terkirim: "badge-ok", ditinjau: "badge-ok", tidak_wajib: "badge-muted" };

function renderRekapTable() {
  const rows = rekapVisible();
  const el = $("rk-table");
  if (!R.rows.length) { el.innerHTML = `<p class="muted" style="padding:14px;">Belum ada karyawan yang dipasangkan dengan template laporan. Buka tab <b>Template &amp; Pengguna</b> untuk memulai.</p>`; return; }
  if (!rows.length) { el.innerHTML = `<p class="muted" style="padding:14px;">Tidak ada data yang cocok dengan filter.</p>`; return; }
  el.innerHTML = `<table class="table" style="min-width:820px;">
    <thead><tr><th>Karyawan</th><th>Departemen</th><th>Template</th><th>Status</th><th>Dikirim</th><th>Kelengkapan</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(r.emp.full_name)}<div class="muted small">${esc(r.emp.position || r.emp.employee_code || "")}</div></td>
      <td>${esc(r.emp.department || "-")}</td>
      <td class="small">${esc(r.tpl.name)}</td>
      <td><span class="badge ${STATUS_BADGE[r.status]}">${REPORT_STATUS_LABEL[r.status]}</span></td>
      <td class="small">${r.report?.submitted_at ? fmtDateTime(r.report.submitted_at) : "-"}${r.late ? ` <span class="badge badge-warn">Terlambat</span>` : ""}</td>
      <td>${r.pct == null ? (r.report ? "–" : "-") : `<span class="lap-bar" style="display:inline-block;width:70px;vertical-align:middle;"><i style="width:${r.pct}%"></i></span> <span class="small">${r.pct}%</span>`}</td>
      <td>${r.report ? `<button type="button" class="btn-link" data-open="${esc(r.report.id)}">Lihat</button>` : ""}</td>
    </tr>`).join("")}</tbody></table>`;
}

// --- ekspor ---------------------------------------------------------
function exportRekap() {
  const rows = rekapVisible().map(r => ({
    Tanggal: R.date, Nama: r.emp.full_name, "Kode Karyawan": r.emp.employee_code || "", Departemen: r.emp.department || "-",
    Jabatan: r.emp.position || "", Template: r.tpl.name, "Wajib Lapor": r.expected ? "Ya" : "Tidak",
    Status: REPORT_STATUS_LABEL[r.status], Dikirim: r.report?.submitted_at ? fmtDateTime(r.report.submitted_at) : "",
    Terlambat: r.late ? "Ya" : "", "Kelengkapan (%)": r.pct ?? "", Ditinjau: r.report?.reviewed_at ? fmtDateTime(r.report.reviewed_at) : "",
    "Catatan HR": r.report?.review_note || "",
  }));
  exportXLSX(`rekap-laporan-aktivitas-${R.date}.xlsx`, rows, "Rekap");
}

async function exportDetail() {
  const withReport = rekapVisible().filter(r => r.report);
  if (!withReport.length) { toast("Belum ada laporan pada filter ini.", "error"); return; }
  const out = [];
  for (const r of withReport) {
    const sections = normalizeSections(r.report.template_snapshot?.sections);
    for (const row of flattenReport(sections, normalizeData(sections, r.report.data))) {
      out.push({ Tanggal: R.date, Nama: r.emp.full_name, Departemen: r.emp.department || "-", Template: r.tpl.name, Status: REPORT_STATUS_LABEL[r.status], ...row });
    }
  }
  if (!out.length) { toast("Laporan yang ada belum berisi isian.", "error"); return; }
  exportXLSX(`isi-laporan-aktivitas-${R.date}.xlsx`, out, "Isi Laporan");
}

// --- baca & tinjau laporan -----------------------------------------
async function openReport(reportId) {
  const r = R.rows.find(x => x.report?.id === reportId);
  if (!r) return;
  const rep = r.report;
  const sections = normalizeSections(rep.template_snapshot?.sections);
  const data = normalizeData(sections, rep.data);
  const c = completeness(sections, data);
  const own = rep.user_id === me.id;
  let reviewer = "";
  if (rep.reviewed_by) {
    const { data: p } = await supabase.from("profiles").select("full_name").eq("id", rep.reviewed_by).limit(1);
    reviewer = p?.[0]?.full_name || "";
  }
  const status = reportStatus(rep, true);
  $("lk-modals").innerHTML = `
    <div id="modal-rep" class="modal"><div class="modal-box modal-box-lg">
      <div class="modal-actions no-print" style="justify-content:flex-end; gap:10px; margin-bottom:12px;">
        <button type="button" id="rp-print" class="btn-secondary">🖨️ Cetak / PDF</button>
        <button type="button" id="rp-close" class="btn-primary">Tutup</button>
      </div>
      <div id="slip-content" class="slip-print-area">
        <h2 style="margin:0 0 2px;">${esc(r.tpl.name)}</h2>
        <p class="muted" style="margin:0 0 10px;">${esc(fmtLong(rep.report_date))}</p>
        <div class="slip-emp-grid" style="margin-bottom:12px;">
          <div><span class="label">Nama</span>${esc(r.emp.full_name)}</div>
          <div><span class="label">Jabatan</span>${esc(r.emp.position || "-")}</div>
          <div><span class="label">Departemen</span>${esc(r.emp.department || "-")}</div>
          <div><span class="label">Status</span>${REPORT_STATUS_LABEL[status]}${r.late ? " (terlambat)" : ""}</div>
          <div><span class="label">Dikirim</span>${rep.submitted_at ? fmtDateTime(rep.submitted_at) : "belum dikirim"}</div>
          <div><span class="label">Kelengkapan</span>${c.pct == null ? `${c.filled} baris` : `${c.presetFilled}/${c.presetTotal} bawaan (${c.pct}%)`}${c.extraFilled ? ` + ${c.extraFilled} tambahan` : ""}</div>
        </div>
        ${renderReadonlySections(sections, data)}
        ${rep.review_note ? `<p class="small" style="margin-top:10px;"><b>Catatan HR:</b> ${esc(rep.review_note)}</p>` : ""}
      </div>
      <div class="no-print" style="margin-top:14px; border-top:1px solid var(--border); padding-top:12px;">
        ${rep.reviewed_at
          ? `<p class="small"><b>Ditinjau</b> ${reviewer ? "oleh " + esc(reviewer) : ""} pada ${fmtDateTime(rep.reviewed_at)}.</p>
             <button type="button" id="rp-unreview" class="btn-secondary">Batalkan Tinjauan</button>`
          : own
            ? `<p class="muted small">Ini laporanmu sendiri — ditinjau oleh HR/admin lain.</p>`
            : rep.status !== "submitted"
              ? `<p class="muted small">Laporan masih berstatus draf, belum bisa ditinjau.</p>`
              : `<label>Catatan untuk karyawan (opsional)<textarea id="rp-note" maxlength="1000" rows="3" style="width:100%;"></textarea></label>
                 <div style="margin-top:8px;"><button type="button" id="rp-review" class="btn-primary">Tandai Ditinjau</button>
                 <span class="muted small" style="margin-left:8px;">Setelah ditinjau, laporan terkunci untuk karyawan.</span></div>`}
      </div>
    </div></div>`;
  $("rp-close").addEventListener("click", () => { $("lk-modals").innerHTML = ""; });
  $("modal-rep").addEventListener("click", e => { if (e.target === $("modal-rep")) $("lk-modals").innerHTML = ""; });
  $("rp-print").addEventListener("click", printSlip);
  $("rp-review")?.addEventListener("click", () => setReview(rep.id, true, $("rp-note").value.trim()));
  $("rp-unreview")?.addEventListener("click", () => setReview(rep.id, false, ""));
}

async function setReview(id, reviewed, note) {
  const payload = reviewed
    ? { reviewed_by: me.id, reviewed_at: new Date().toISOString(), review_note: note || null }
    : { reviewed_by: null, reviewed_at: null, review_note: null };
  const { error } = await supabase.from("daily_reports").update(payload).eq("id", id);
  if (error) { toast("Gagal menyimpan tinjauan: " + error.message, "error"); return; }
  toast(reviewed ? "Laporan ditandai ditinjau." : "Tinjauan dibatalkan.", "success");
  $("lk-modals").innerHTML = "";
  await loadRekap();
}

// =======================================================================
// TEMPLATE & PENGGUNA
// =======================================================================
async function renderTemplates() {
  T = { templates: [], counts: {}, emps: [], editing: null, draft: null };
  $("lk-host").innerHTML = `
    <div class="pg-toolbar no-print">
      <div class="filter-row" style="flex-wrap:wrap;">
        <button type="button" id="tp-new" class="btn-primary">+ Template Baru</button>
      </div>
    </div>
    <p class="muted small">Template menentukan bagian & baris bawaan laporan. Karyawan memakai satu template sesuai jabatannya; laporan lama tidak berubah kalau template diubah.</p>
    <div id="tp-table" class="table-wrap"><p class="muted">Memuat…</p></div>`;
  $("tp-new").addEventListener("click", () => openTemplateEditor(null));
  $("tp-table").addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const t = T.templates.find(x => x.id === b.dataset.id);
    if (!t) return;
    ({ edit: () => openTemplateEditor(t), users: () => openAssign(t), dup: () => duplicateTemplate(t), del: () => deleteTemplate(t) })[b.dataset.act]?.();
  });
  await loadTemplates();
}

async function loadTemplates() {
  try {
    const [tpls, asg] = await Promise.all([
      fetchAllRows(() => supabase.from("daily_report_templates").select("*").order("name")),
      fetchAllRows(() => supabase.from("daily_report_assignments").select("user_id, template_id").order("user_id")),
    ]);
    T.templates = tpls;
    T.counts = {};
    asg.forEach(a => { T.counts[a.template_id] = (T.counts[a.template_id] || 0) + 1; });
    T.assign = new Map(asg.map(a => [a.user_id, a.template_id]));
  } catch (e) {
    $("tp-table").innerHTML = `<p class="muted" style="padding:14px;">Gagal memuat template: ${esc(e.message || e)}. Pastikan SQL <b>024_laporan_aktivitas.sql</b> sudah dijalankan.</p>`;
    return;
  }
  if (!T.templates.length) { $("tp-table").innerHTML = `<p class="muted" style="padding:14px;">Belum ada template. Klik <b>+ Template Baru</b>, pilih bagian laporan yang dibutuhkan, lalu tulis aktivitas/indikator bawaannya. Template yang sudah jadi bisa diduplikat untuk jabatan lain.</p>`; return; }
  $("tp-table").innerHTML = `<table class="table" style="min-width:720px;">
    <thead><tr><th>Template</th><th style="text-align:right">Bagian</th><th style="text-align:right">Pengguna</th><th>Wajib</th><th>Status</th><th></th></tr></thead>
    <tbody>${T.templates.map(t => `<tr>
      <td><b>${esc(t.name)}</b>${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ""}</td>
      <td style="text-align:right">${(t.sections || []).length}</td>
      <td style="text-align:right">${T.counts[t.id] || 0}</td>
      <td>${t.wajib ? "Ya" : "Tidak"}</td>
      <td><span class="badge ${t.is_active ? "badge-ok" : "badge-muted"}">${t.is_active ? "Aktif" : "Nonaktif"}</span></td>
      <td style="white-space:nowrap;">
        <button type="button" class="btn-link" data-act="users" data-id="${t.id}">Pengguna</button>
        <button type="button" class="btn-link" data-act="edit" data-id="${t.id}">Ubah</button>
        <button type="button" class="btn-link" data-act="dup" data-id="${t.id}">Duplikat</button>
        <button type="button" class="btn-link" style="color:var(--danger);" data-act="del" data-id="${t.id}">Hapus</button>
      </td></tr>`).join("")}</tbody></table>`;
}

async function duplicateTemplate(t) {
  const names = new Set(T.templates.map(x => x.name.toLowerCase()));
  let name = `${t.name} (salinan)`.slice(0, 100), i = 2;
  while (names.has(name.toLowerCase())) name = `${t.name} (salinan ${i++})`.slice(0, 100);
  const { error } = await supabase.from("daily_report_templates").insert({ name, description: t.description, wajib: t.wajib, is_active: t.is_active, sections: t.sections });
  if (error) { toast("Gagal menduplikat: " + error.message, "error"); return; }
  toast("Template diduplikat.", "success");
  await loadTemplates();
}

async function deleteTemplate(t) {
  const n = T.counts[t.id] || 0;
  const ok = await confirmDialog({
    title: "Hapus Template",
    message: `Hapus template "${t.name}"?${n ? ` ${n} karyawan akan kehilangan template dan tidak bisa mengisi laporan sampai dipasangkan template lain.` : ""} Laporan yang sudah dibuat tetap tersimpan.`,
    confirmLabel: "Hapus", confirmClass: "btn-danger",
  });
  if (!ok) return;
  const { error } = await supabase.from("daily_report_templates").delete().eq("id", t.id);
  if (error) { toast("Gagal menghapus: " + error.message, "error"); return; }
  toast("Template dihapus.", "success");
  await loadTemplates();
}

// --- editor template -------------------------------------------------
// Tampilan: kepala & tombol simpan menempel (tidak perlu scroll ke bawah untuk menyimpan),
// tiap bagian bisa dilipat, poin bawaan ditulis per baris (bukan teks dengan tanda "|").
const MAX_PRESET_ROWS = 40;   // sama dengan batas di laporanAktivitas.js
const MAX_SECTIONS_UI = 10;
let escHandler = null;
let editorSnapshot = "";

const draftKey = d => JSON.stringify({ n: d.name, d: d.description, w: d.wajib, a: d.is_active, s: d.sections.map(({ open, ...s }) => s) });
const countPreset = s => s.preset.filter(r => Object.values(r).some(v => String(v).trim())).length;
const sectionSummary = s => {
  const parts = [];
  const n = countPreset(s);
  if (presetFields(s.kind).length) parts.push(n ? `${n} poin bawaan` : "diisi sendiri oleh karyawan");
  if (s.blank_rows) parts.push(`${s.blank_rows} baris kosong`);
  return parts.join(" · ") || "tanpa baris";
};

function openTemplateEditor(t) {
  T.editing = t;
  const sections = normalizeSections(t ? t.sections : [{ kind: "aktivitas" }, { kind: "kendala" }, { kind: "outstanding" }, { kind: "rencana" }]);
  T.draft = {
    name: t?.name || "", description: t?.description || "", wajib: t ? !!t.wajib : true, is_active: t ? !!t.is_active : true,
    sections: sections.map((s, i) => ({ ...s, preset: s.preset.map(r => ({ ...r })), open: i === 0 })),
    nameError: false,
  };
  editorSnapshot = draftKey(T.draft);
  renderEditor();
  setTimeout(() => $("te-name")?.focus(), 30);
}

const presetEditorHtml = (s, i) => {
  const fields = presetFields(s.kind);
  const cols = SECTION_KINDS[s.kind].columns;
  if (!fields.length) {
    return `<p class="tpl-note">Bagian ini diisi sendiri oleh karyawan, jadi tidak ada poin bawaan.</p>`;
  }
  const label = f => cols.find(c => c.key === f).label;
  const example = (SECTION_KINDS[s.kind].presetExample || "").split("\n")[0].split("|").map(x => x.trim());
  const rows = s.preset.length ? s.preset : [];
  return `<div class="tpl-preset">
    <div class="tpl-field-label">Poin dari HR <span class="muted">— karyawan tinggal mengisi hasilnya. Kosongkan jika karyawan menulis sendiri.</span></div>
    ${fields.length > 1 ? `<div class="tpl-prow tpl-prow-head" style="--n:${fields.length}"><span></span>${fields.map(f => `<span>${esc(label(f))}</span>`).join("")}<span></span></div>` : ""}
    <div class="tpl-prows">${rows.map((r, ri) => `
      <div class="tpl-prow ${fields.length > 1 ? "tpl-prow-multi" : ""}" style="--n:${fields.length}">
        <span class="tpl-pno">${ri + 1}</span>
        ${fields.map((f, fi) => `<input data-pr="${ri}" data-pf="${f}" maxlength="500" value="${esc(r[f] || "")}" aria-label="${esc(label(f))} poin ${ri + 1}" placeholder="${esc(fields.length > 1 ? label(f) : (example[fi] || "Tulis satu poin"))}">`).join("")}
        <button type="button" class="tpl-icon-btn" data-rmrow="${ri}" aria-label="Hapus poin ${ri + 1}" title="Hapus poin">×</button>
      </div>`).join("")}</div>
    <button type="button" class="btn-secondary tpl-add-row" data-addrow ${rows.length >= MAX_PRESET_ROWS ? "disabled" : ""}>+ Tambah poin</button>
  </div>`;
};

function sectionHtml(s, i, total, kindOpts) {
  const cols = SECTION_KINDS[s.kind].columns;
  const hr = new Set(presetFields(s.kind));
  return `<div class="tpl-sec ${s.open ? "open" : ""}" data-i="${i}">
    <div class="tpl-sec-bar">
      <button type="button" class="tpl-sec-toggle" data-toggle aria-expanded="${s.open}" aria-controls="tpl-sec-body-${i}">
        <span class="tpl-sec-no">${i + 1}</span>
        <span class="tpl-sec-text"><b class="tpl-sec-title">${esc(s.title || SECTION_KINDS[s.kind].label)}</b><span class="tpl-sec-sum muted small">${esc(sectionSummary(s))}</span></span>
        <svg class="tpl-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="tpl-sec-tools">
        <button type="button" class="tpl-icon-btn" data-mv="-1" ${i === 0 ? "disabled" : ""} aria-label="Naikkan bagian" title="Naikkan">↑</button>
        <button type="button" class="tpl-icon-btn" data-mv="1" ${i === total - 1 ? "disabled" : ""} aria-label="Turunkan bagian" title="Turunkan">↓</button>
        <button type="button" class="tpl-icon-btn tpl-danger" data-rm aria-label="Hapus bagian" title="Hapus bagian">🗑</button>
      </div>
    </div>
    <div class="tpl-sec-body" id="tpl-sec-body-${i}" ${s.open ? "" : "hidden"}>
      <div class="form-row two-col">
        <label>Jenis bagian <select data-f="kind">${kindOpts(s.kind)}</select></label>
        <label>Judul di laporan <input data-f="title" maxlength="120" value="${esc(s.title)}"></label>
      </div>
      <div class="tpl-cols">
        <span class="tpl-field-label">Kolom di laporan</span>
        ${cols.map(c => `<span class="tpl-chip ${hr.has(c.key) ? "hr" : ""}" title="${hr.has(c.key) ? "Diisi oleh HR lewat poin bawaan" : "Diisi oleh karyawan"}">${esc(c.label)}</span>`).join("")}
        ${hr.size ? `<span class="tpl-legend muted small">Hijau = diisi HR, abu-abu = diisi karyawan</span>` : ""}
      </div>
      ${presetEditorHtml(s, i)}
      <label class="tpl-blank">Baris kosong tambahan <span class="muted small">untuk pekerjaan di luar poin bawaan</span>
        <input type="number" data-f="blank_rows" min="0" max="15" value="${s.blank_rows}" inputmode="numeric"></label>
    </div>
  </div>`;
}

function renderEditor(focusSel) {
  const d = T.draft;
  const prevScroll = $("modal-tpl")?.querySelector(".tpl-body")?.scrollTop || 0;
  const kindOpts = sel => KIND_KEYS.map(k => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(SECTION_KINDS[k].label)}</option>`).join("");
  const full = d.sections.length >= MAX_SECTIONS_UI;
  const inner = `
      <div class="tpl-head">
        <div><h3 id="te-title">${T.editing ? "Ubah Template" : "Template Baru"}</h3>
          <p class="muted small">Atur bagian laporan yang diisi karyawan setiap hari.</p></div>
        <button type="button" class="tpl-icon-btn" id="te-x" aria-label="Tutup" title="Tutup">×</button>
      </div>
      <div class="tpl-body">
        <div class="tpl-card">
          <div class="form-row two-col">
            <label><span>Nama template <span class="tpl-req">wajib</span></span>
              <input id="te-name" maxlength="100" required value="${esc(d.name)}" placeholder="Contoh: Laporan Harian HR Admin" class="${d.nameError ? "invalid" : ""}" aria-invalid="${d.nameError}">
              ${d.nameError ? `<span class="tpl-err">Nama template belum diisi.</span>` : ""}</label>
            <label>Deskripsi <input id="te-desc" maxlength="300" value="${esc(d.description)}" placeholder="Opsional, misalnya untuk jabatan apa"></label>
          </div>
          <label class="tpl-switch-row"><span><b>Wajib diisi tiap hari kerja</b><small>Karyawan yang belum mengisi ditandai di Rekap Harian.</small></span>
            <input type="checkbox" role="switch" class="tpl-switch" id="te-wajib" ${d.wajib ? "checked" : ""}></label>
          <label class="tpl-switch-row"><span><b>Template aktif</b><small>Matikan untuk menghentikan sementara tanpa menghapus.</small></span>
            <input type="checkbox" role="switch" class="tpl-switch" id="te-aktif" ${d.is_active ? "checked" : ""}></label>
        </div>

        <div class="tpl-sec-headline">
          <h4>Bagian laporan <span class="muted">(${d.sections.length})</span></h4>
          ${d.sections.length > 1 ? `<button type="button" class="btn-link" id="te-fold">${d.sections.every(s => s.open) ? "Ciutkan semua" : "Buka semua"}</button>` : ""}
        </div>
        <div id="te-sections">${d.sections.map((s, i) => sectionHtml(s, i, d.sections.length, kindOpts)).join("") || `<p class="tpl-note">Belum ada bagian. Pilih salah satu jenis di bawah.</p>`}</div>

        <div class="tpl-add">
          <span class="tpl-field-label">Tambah bagian ${full ? `<span class="muted">(maksimal ${MAX_SECTIONS_UI})</span>` : ""}</span>
          <div class="tpl-add-list">${KIND_KEYS.map(k => `<button type="button" class="tpl-add-btn" data-addkind="${k}" ${full ? "disabled" : ""}>+ ${esc(SECTION_KINDS[k].label)}</button>`).join("")}</div>
        </div>
      </div>
      <div class="tpl-foot">
        <span class="muted small tpl-foot-note">Laporan yang sudah dikirim tidak berubah.</span>
        <div class="tpl-foot-actions">
          <button type="button" id="te-cancel" class="btn-secondary">Batal</button>
          <button type="button" id="te-save" class="btn-primary">Simpan Template</button>
        </div>
      </div>`;

  // Kerangka modal dibuat SEKALI. Setelah itu hanya isi kotaknya yang diganti: core.js mereset scroll
  // setiap elemen .modal baru, jadi menggambar ulang seluruh modal akan melempar posisi scroll ke atas.
  let root = $("modal-tpl");
  if (!root) {
    $("lk-modals").innerHTML = `<div id="modal-tpl" class="modal"><div class="modal-box tpl-box" role="dialog" aria-modal="true" aria-labelledby="te-title"></div></div>`;
    root = $("modal-tpl");
    const box = root.querySelector(".modal-box");
    box.addEventListener("input", syncEditor);
    box.addEventListener("change", onEditorChange);
    box.addEventListener("keydown", onEditorKey);
    box.addEventListener("paste", onEditorPaste);
    let downOnBackdrop = false;
    root.addEventListener("mousedown", e => { downOnBackdrop = e.target === root; });
    root.addEventListener("click", onEditorClick);
    root.addEventListener("click", e => { if (e.target === root && downOnBackdrop) requestCloseEditor(); });
  }
  root.querySelector(".modal-box").innerHTML = inner;
  root.querySelector(".tpl-body").scrollTop = prevScroll;
  if (focusSel) root.querySelector(focusSel)?.focus({ preventScroll: false });

  if (!escHandler) {
    escHandler = e => { if (e.key === "Escape" && $("modal-tpl")) requestCloseEditor(); };
    document.addEventListener("keydown", escHandler);
  }
}

const secOf = el => T.draft.sections[Number(el.closest(".tpl-sec")?.dataset.i)];

function refreshSecHeader(el) {
  const secEl = el.closest(".tpl-sec"); const s = secOf(el);
  if (!secEl || !s) return;
  secEl.querySelector(".tpl-sec-title").textContent = s.title || SECTION_KINDS[s.kind].label;
  secEl.querySelector(".tpl-sec-sum").textContent = sectionSummary(s);
}

function syncEditor(e) {
  const d = T.draft, t = e.target;
  if (t.id === "te-name") { d.name = t.value; if (d.nameError && t.value.trim()) { d.nameError = false; t.classList.remove("invalid"); t.setAttribute("aria-invalid", "false"); t.parentElement.querySelector(".tpl-err")?.remove(); } return; }
  if (t.id === "te-desc") { d.description = t.value; return; }
  if (t.id === "te-wajib") { d.wajib = t.checked; return; }
  if (t.id === "te-aktif") { d.is_active = t.checked; return; }
  const s = t.closest(".tpl-sec") ? secOf(t) : null;
  if (!s) return;
  if (t.dataset.pr !== undefined) { s.preset[Number(t.dataset.pr)][t.dataset.pf] = t.value; refreshSecHeader(t); return; }
  const f = t.dataset.f;
  if (f === "kind") return; // ditangani di onEditorChange
  if (f === "blank_rows") s.blank_rows = Math.min(15, Math.max(0, Math.trunc(Number(t.value) || 0)));
  else if (f === "title") s.title = t.value;
  refreshSecHeader(t);
}

async function onEditorChange(e) {
  const t = e.target;
  if (t.dataset?.f !== "kind") return;
  const s = secOf(t);
  if (countPreset(s)) {
    const ok = await confirmDialog({
      title: "Ganti jenis bagian?",
      message: "Poin bawaan yang sudah ditulis di bagian ini akan dihapus karena kolomnya berbeda.",
      confirmLabel: "Ganti jenis",
    });
    if (!ok) { renderEditor(); return; }
  }
  s.kind = t.value; s.preset = []; s.title = SECTION_KINDS[s.kind].label; s.blank_rows = SECTION_KINDS[s.kind].blankDefault;
  renderEditor();
}

// Enter di poin terakhir = tambah poin baru; ini mempercepat mengetik banyak poin.
function onEditorKey(e) {
  const t = e.target;
  if (t.dataset?.pr === undefined || e.key !== "Enter") return;
  e.preventDefault();
  const s = secOf(t);
  const fields = presetFields(s.kind);
  const ri = Number(t.dataset.pr);
  if (t.dataset.pf !== fields[fields.length - 1]) { t.nextElementSibling?.focus(); return; }
  if (ri === s.preset.length - 1) {
    if (s.preset.length >= MAX_PRESET_ROWS) return;
    s.preset.push(Object.fromEntries(fields.map(f => [f, ""])));
  }
  const i = T.draft.sections.indexOf(s);
  renderEditor(`.tpl-sec[data-i="${i}"] [data-pr="${ri + 1}"][data-pf="${fields[0]}"]`);
}

// Tempel beberapa baris sekaligus (mis. dari Excel/Word) di bagian satu-kolom: otomatis jadi poin terpisah.
function onEditorPaste(e) {
  const t = e.target;
  if (t.dataset?.pr === undefined) return;
  const s = secOf(t);
  const fields = presetFields(s.kind);
  const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return;
  e.preventDefault();
  let ri = Number(t.dataset.pr);
  const startField = fields.indexOf(t.dataset.pf);
  lines.forEach((line, k) => {
    if (ri + k >= MAX_PRESET_ROWS) return;
    if (!s.preset[ri + k]) s.preset[ri + k] = Object.fromEntries(fields.map(f => [f, ""]));
    // satu kolom: satu baris = satu poin. Banyak kolom: baris Excel dipisah tab / "|".
    const cells = fields.length === 1 ? [line] : line.split(/\t|\|/).map(c => c.trim());
    cells.forEach((c, ci) => { const f = fields[startField + ci]; if (f) s.preset[ri + k][f] = c; });
  });
  const i = T.draft.sections.indexOf(s);
  renderEditor(`.tpl-sec[data-i="${i}"] [data-pr="${Math.min(ri + lines.length - 1, MAX_PRESET_ROWS - 1)}"][data-pf="${fields[0]}"]`);
  toast(`${Math.min(lines.length, MAX_PRESET_ROWS - ri)} poin ditempel.`, "success");
}

function onEditorClick(e) {
  const d = T.draft;
  const q = sel => e.target.closest(sel);
  if (q("#te-x") || q("#te-cancel")) { requestCloseEditor(); return; }
  if (q("#te-save")) { saveTemplate(); return; }
  if (q("#te-fold")) { const open = !d.sections.every(s => s.open); d.sections.forEach(s => { s.open = open; }); renderEditor(); return; }
  const add = q("[data-addkind]");
  if (add) {
    if (d.sections.length >= MAX_SECTIONS_UI) return;
    const k = add.dataset.addkind;
    d.sections.forEach(s => { s.open = false; });
    d.sections.push({ key: `s${Date.now()}`, kind: k, title: SECTION_KINDS[k].label, preset: [], blank_rows: SECTION_KINDS[k].blankDefault, open: true });
    renderEditor();
    const last = $("te-sections").lastElementChild;
    last?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const secEl = q(".tpl-sec");
  if (!secEl) return;
  const i = Number(secEl.dataset.i), s = d.sections[i];
  if (q("[data-toggle]")) { s.open = !s.open; renderEditor(); return; }
  if (q("[data-rm]")) { d.sections.splice(i, 1); renderEditor(); return; }
  const mv = q("[data-mv]");
  if (mv) {
    const j = i + Number(mv.dataset.mv);
    if (j >= 0 && j < d.sections.length) { [d.sections[i], d.sections[j]] = [d.sections[j], d.sections[i]]; renderEditor(`.tpl-sec[data-i="${j}"] [data-mv="${mv.dataset.mv}"]`); }
    return;
  }
  const fields = presetFields(s.kind);
  if (q("[data-addrow]")) {
    s.preset.push(Object.fromEntries(fields.map(f => [f, ""])));
    renderEditor(`.tpl-sec[data-i="${i}"] [data-pr="${s.preset.length - 1}"][data-pf="${fields[0]}"]`);
    return;
  }
  const rm = q("[data-rmrow]");
  if (rm) { s.preset.splice(Number(rm.dataset.rmrow), 1); renderEditor(); }
}

let askingClose = false;
async function requestCloseEditor() {
  if (askingClose) return;
  if (T.draft && draftKey(T.draft) !== editorSnapshot) {
    askingClose = true;
    const ok = await confirmDialog({
      title: "Buang perubahan?",
      message: "Perubahan pada template ini belum disimpan.",
      confirmLabel: "Buang", confirmClass: "btn-danger",
    }).finally(() => { askingClose = false; });
    if (!ok) return;
  }
  closeModals();
}

function closeModals() {
  $("lk-modals").innerHTML = "";
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
}

async function saveTemplate() {
  const d = T.draft;
  const name = d.name.trim();
  if (!name) {
    d.nameError = true; renderEditor("#te-name");
    toast("Nama template wajib diisi.", "error");
    return;
  }
  const sections = normalizeSections(d.sections);
  if (!sections.length) { toast("Tambahkan minimal satu bagian laporan.", "error"); return; }
  const row = { name, description: d.description.trim() || null, wajib: d.wajib, is_active: d.is_active, sections };
  const btn = $("te-save");
  if (btn) { btn.disabled = true; btn.textContent = "Menyimpan…"; }
  const q = T.editing
    ? supabase.from("daily_report_templates").update(row).eq("id", T.editing.id)
    : supabase.from("daily_report_templates").insert(row);
  const { error } = await q;
  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = "Simpan Template"; }
    toast(/uq_daily_report_templates_name|duplicate/i.test(error.message) ? "Nama template sudah dipakai." : "Gagal menyimpan template: " + error.message, "error");
    return;
  }
  toast("Template disimpan.", "success");
  closeModals();
  await loadTemplates();
}

// --- penugasan: siapa memakai template ini ---------------------------
async function openAssign(t) {
  let emps;
  try {
    emps = await fetchAllRows(() => supabase.from("profiles").select("id, full_name, employee_code, department, position").eq("is_active", true).order("full_name"));
  } catch (e) { toast("Gagal memuat karyawan: " + (e.message || e), "error"); return; }
  const tplName = id => T.templates.find(x => x.id === id)?.name || "";
  const checked = new Set(emps.filter(e => T.assign.get(e.id) === t.id).map(e => e.id));
  const original = new Set(checked);
  const depts = [...new Set(emps.map(e => e.department).filter(Boolean))].sort();

  $("lk-modals").innerHTML = `
    <div id="modal-asg" class="modal"><div class="modal-box modal-box-lg">
      <h3>Pengguna Template</h3>
      <p class="muted small" style="margin-top:-4px;">${esc(t.name)} — centang karyawan yang memakai template ini. Karyawan yang sudah memakai template lain akan dipindahkan.</p>
      <div class="filter-row" style="flex-wrap:wrap;margin-bottom:8px;">
        <input type="search" id="as-q" placeholder="Cari nama / jabatan…" style="max-width:220px;">
        <select id="as-dept"><option value="">Semua Departemen</option>${depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}</select>
        <button type="button" id="as-all" class="btn-secondary">Pilih semua yang tampil</button>
        <button type="button" id="as-none" class="btn-secondary">Kosongkan yang tampil</button>
      </div>
      <div id="as-list" style="max-height:48vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);"></div>
      <p class="small muted" id="as-count" style="margin:8px 0 0;"></p>
      <div class="modal-actions">
        <button type="button" id="as-cancel" class="btn-secondary">Batal</button>
        <button type="button" id="as-save" class="btn-primary">Simpan</button>
      </div>
    </div></div>`;

  const visible = () => {
    const q = $("as-q").value.trim().toLowerCase(), dept = $("as-dept").value;
    return emps.filter(e => (!dept || e.department === dept) && (!q || `${e.full_name} ${e.position || ""}`.toLowerCase().includes(q)));
  };
  const draw = () => {
    const rows = visible();
    $("as-list").innerHTML = rows.length ? rows.map(e => {
      const other = T.assign.get(e.id);
      const note = other && other !== t.id ? `<span class="badge badge-muted" title="Akan dipindahkan">sekarang: ${esc(tplName(other))}</span>` : "";
      return `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;">
        <input type="checkbox" data-uid="${esc(e.id)}" style="width:auto;" ${checked.has(e.id) ? "checked" : ""}>
        <span style="flex:1;">${esc(e.full_name)}<span class="muted small"> • ${esc(e.position || e.department || "-")}</span></span>${note}</label>`;
    }).join("") : `<p class="muted" style="padding:12px;">Tidak ada karyawan yang cocok.</p>`;
    $("as-count").textContent = `${checked.size} karyawan dipilih.`;
  };
  draw();
  $("as-q").addEventListener("input", draw);
  $("as-dept").addEventListener("change", draw);
  $("as-list").addEventListener("change", e => {
    const id = e.target.dataset?.uid;
    if (!id) return;
    e.target.checked ? checked.add(id) : checked.delete(id);
    $("as-count").textContent = `${checked.size} karyawan dipilih.`;
  });
  $("as-all").addEventListener("click", () => { visible().forEach(e => checked.add(e.id)); draw(); });
  $("as-none").addEventListener("click", () => { visible().forEach(e => checked.delete(e.id)); draw(); });
  $("as-cancel").addEventListener("click", closeModals);
  $("modal-asg").addEventListener("click", e => { if (e.target === $("modal-asg")) closeModals(); });
  $("as-save").addEventListener("click", async () => {
    const add = [...checked].filter(id => !original.has(id)).map(user_id => ({ user_id, template_id: t.id }));
    const remove = [...original].filter(id => !checked.has(id));
    try {
      if (add.length) { const { error } = await supabase.from("daily_report_assignments").upsert(add, { onConflict: "user_id" }); if (error) throw error; }
      if (remove.length) { const { error } = await supabase.from("daily_report_assignments").delete().eq("template_id", t.id).in("user_id", remove); if (error) throw error; }
    } catch (err) { toast("Gagal menyimpan penugasan: " + (err.message || err), "error"); return; }
    toast(`Penugasan disimpan (${add.length} ditambah, ${remove.length} dilepas).`, "success");
    closeModals();
    await loadTemplates();
  });
}
