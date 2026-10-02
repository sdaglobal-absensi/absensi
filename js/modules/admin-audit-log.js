// Audit Log — riwayat perubahan data penting di usaha ini (siapa, kapan, apa).
// Data ditulis otomatis oleh trigger database (003_tahap3_storage_audit.sql);
// halaman ini hanya MEMBACA. Log tidak bisa diubah/dihapus dari aplikasi.
import { supabase } from "../supabaseClient.js";
import { toast, todayISO, exportXLSX, fetchAllRows } from "../core.js";

const PAGE_SIZE = 50;

const TABLE_LABELS = {
  profiles: "Data Karyawan", role_permissions: "Akses Menu", tenants: "Pengaturan Usaha",
  wage_history: "Riwayat Upah", salary_history: "Riwayat Gaji", payroll_periods: "Periode Gaji",
  payroll_slips: "Slip Gaji", payroll_settings: "Pengaturan Gaji", payroll_adjustments: "Penyesuaian Gaji",
  employee_allowances: "Tunjangan Karyawan", allowance_types: "Master Tunjangan", late_penalty_rules: "Master Denda Telat",
  job_levels: "Master Level", departments: "Master Departemen", work_schedules: "Jadwal Kerja",
  work_schedule_days: "Hari Jadwal Kerja", employee_schedule_history: "Riwayat Jadwal Karyawan",
  holidays: "Hari Libur", office_locations: "Lokasi Kantor", org_units: "Unit Organisasi",
  org_unit_members: "Anggota Unit", approval_settings: "Pengaturan Approval", special_leave_rules: "Cuti Khusus",
  leave_balances: "Kuota Cuti", master_pt: "Master PT / Vendor", outsourcing_invoices: "Invoice Outsourcing",
  outsourcing_area_invoices: "Invoice Outsourcing (Area)", leave_requests: "Pengajuan Izin/Cuti",
  overtime_requests: "Pengajuan Lembur", attendance_correction_requests: "Koreksi Absen",
  request_approvals: "Approval", profile_change_requests: "Perubahan Data Karyawan",
  push_settings: "Pengingat Absen", attendance: "Absensi",
};

const ACTION_LABELS = {
  insert: "Tambah", update: "Ubah", delete: "Hapus",
  "account.create": "Buat Akun", "account.reset_pin": "Reset PIN", export: "Ekspor Data",
};
const ACTION_BADGE = { insert: "ok", update: "warn", delete: "danger", "account.create": "ok", "account.reset_pin": "warn", export: "warn" };

const NAME_KEYS = ["full_name", "name", "nama", "title", "kode", "period", "menu_id", "request_type", "employee_code"];

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortVal(v) {
  if (v === null || v === undefined) return "∅";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

// Kalimat ringkas dari satu baris log.
export function describe(r) {
  if (r.summary) return r.summary;
  const label = TABLE_LABELS[r.table_name] || r.table_name || "data";
  const d = r.new_data || r.old_data || {};
  let obj = "";
  for (const k of NAME_KEYS) { if (d[k]) { obj = String(d[k]); break; } }
  const target = obj ? `${label} "${obj}"` : label;
  if (r.action === "insert") return `Menambah ${target}`;
  if (r.action === "delete") return `Menghapus ${target}`;
  const cols = Object.keys(r.new_data || {});
  const colText = cols.length > 4 ? cols.slice(0, 4).join(", ") + ` +${cols.length - 4}` : cols.join(", ");
  return `Mengubah ${target}${colText ? ` (${colText})` : ""}`;
}

let state = { page: 0, total: 0, rows: [] };

export async function render(container, user) {
  const today = todayISO();
  const weekAgo = new Date(Date.now() - 6 * 86400000);
  const wk = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, "0")}-${String(weekAgo.getDate()).padStart(2, "0")}`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Audit Log</h1>
        <p class="muted">Riwayat perubahan data penting: siapa mengubah apa dan kapan. Log ini hanya bisa dibaca — tidak bisa diubah atau dihapus dari aplikasi.</p>
      </div>
      <button id="al-export" class="btn-secondary">Export Excel</button>
    </div>

    <div class="form-row two-col" style="margin-bottom:8px;">
      <label>Dari Tanggal <input type="date" id="al-start" value="${wk}"></label>
      <label>Sampai Tanggal <input type="date" id="al-end" value="${today}"></label>
    </div>
    <div class="form-row two-col" style="margin-bottom:8px;">
      <label>Jenis Data
        <select id="al-table">
          <option value="">Semua</option>
          ${Object.entries(TABLE_LABELS).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}
        </select>
      </label>
      <label>Aksi
        <select id="al-action">
          <option value="">Semua</option>
          ${Object.entries(ACTION_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="form-row" style="margin-bottom:12px;">
      <label>Pelaku <input id="al-actor" placeholder="Cari nama pelaku…"></label>
    </div>

    <div id="al-table-wrap" class="table-wrap"><p class="muted" style="padding:18px 20px;">Memuat…</p></div>
    <div id="al-pager" class="small muted" style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:10px;"></div>

    <div id="al-modal" class="modal hidden">
      <div class="modal-box">
        <h3 id="al-modal-title">Detail</h3>
        <div id="al-modal-body" style="max-height:60vh;overflow:auto;"></div>
        <div class="modal-actions"><button type="button" id="al-close" class="btn-secondary">Tutup</button></div>
      </div>
    </div>
  `;

  const reload = () => { state.page = 0; load(); };
  ["al-start", "al-end", "al-table", "al-action"].forEach(id => document.getElementById(id).addEventListener("change", reload));
  let t = null;
  document.getElementById("al-actor").addEventListener("input", () => { clearTimeout(t); t = setTimeout(reload, 350); });
  document.getElementById("al-close").addEventListener("click", () => document.getElementById("al-modal").classList.add("hidden"));
  document.getElementById("al-export").addEventListener("click", doExport);

  state = { page: 0, total: 0, rows: [] };
  load();
}

function buildQuery(sel, opts = {}) {
  const start = document.getElementById("al-start").value;
  const end = document.getElementById("al-end").value;
  const table = document.getElementById("al-table").value;
  const action = document.getElementById("al-action").value;
  const actor = document.getElementById("al-actor").value.trim();
  let q = supabase.from("audit_log").select(sel, opts);
  // Tanggal dihitung menurut zona waktu browser (WIB/WITA/WIT mengikuti perangkat)
  if (start) q = q.gte("at", new Date(`${start}T00:00:00`).toISOString());
  if (end) q = q.lt("at", new Date(new Date(`${end}T00:00:00`).getTime() + 86400000).toISOString());
  if (table) q = q.eq("table_name", table);
  if (action) q = q.eq("action", action);
  if (actor) q = q.ilike("actor_name", `%${actor.replace(/[\\%_]/g, m => "\\" + m)}%`);
  return q.order("at", { ascending: false }).order("id", { ascending: false });
}

async function load() {
  const wrap = document.getElementById("al-table-wrap");
  wrap.innerHTML = `<p class="muted" style="padding:18px 20px;">Memuat…</p>`;
  const from = state.page * PAGE_SIZE;
  const { data, error, count } = await buildQuery("*", { count: "exact" }).range(from, from + PAGE_SIZE - 1);
  if (error) { wrap.innerHTML = `<p class="muted" style="padding:18px 20px;">Gagal memuat: ${esc(error.message)}</p>`; return; }
  state.rows = data || [];
  state.total = count ?? state.rows.length;

  if (!state.rows.length) {
    wrap.innerHTML = `<p class="muted" style="padding:18px 20px;">Tidak ada catatan untuk filter ini.</p>`;
  } else {
    wrap.innerHTML = `
      <table class="table">
        <thead><tr><th>Waktu</th><th>Pelaku</th><th>Aksi</th><th>Keterangan</th><th></th></tr></thead>
        <tbody>
          ${state.rows.map((r, i) => `
            <tr>
              <td data-label="Waktu">${esc(fmtWhen(r.at))}</td>
              <td data-label="Pelaku">${esc(r.actor_name || "—")}${r.actor_role ? `<div class="small muted">${esc(r.actor_role)}</div>` : ""}</td>
              <td data-label="Aksi"><span class="badge badge-${ACTION_BADGE[r.action] || "ok"}">${esc(ACTION_LABELS[r.action] || r.action)}</span></td>
              <td data-label="Keterangan">${esc(describe(r))}</td>
              <td><button class="btn-link al-detail" data-i="${i}">Detail</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    wrap.querySelectorAll(".al-detail").forEach(b => b.addEventListener("click", () => openDetail(state.rows[+b.dataset.i])));
  }

  const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const pager = document.getElementById("al-pager");
  pager.innerHTML = `
    <span>${state.total.toLocaleString("id-ID")} catatan · halaman ${state.page + 1} dari ${pages}</span>
    <span style="display:flex;gap:8px;">
      <button id="al-prev" class="btn-secondary" ${state.page === 0 ? "disabled" : ""}>‹ Sebelumnya</button>
      <button id="al-next" class="btn-secondary" ${state.page + 1 >= pages ? "disabled" : ""}>Berikutnya ›</button>
    </span>`;
  document.getElementById("al-prev").addEventListener("click", () => { state.page--; load(); });
  document.getElementById("al-next").addEventListener("click", () => { state.page++; load(); });
}

function openDetail(r) {
  document.getElementById("al-modal-title").textContent = `${ACTION_LABELS[r.action] || r.action} — ${TABLE_LABELS[r.table_name] || r.table_name || "—"}`;
  const old = r.old_data || {};
  const nw = r.new_data || {};
  const keys = [...new Set([...Object.keys(old), ...Object.keys(nw)])];
  const meta = `
    <p class="small muted" style="margin:0 0 10px;">
      ${esc(fmtWhen(r.at))} · oleh <strong>${esc(r.actor_name || "—")}</strong>${r.actor_role ? ` (${esc(r.actor_role)})` : ""}
      ${r.record_id ? `<br>ID data: <code>${esc(r.record_id)}</code>` : ""}
    </p>
    ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}`;
  const body = keys.length ? `
    <table class="table">
      <thead><tr><th>Kolom</th>${r.action !== "insert" ? "<th>Sebelum</th>" : ""}${r.action !== "delete" ? "<th>Sesudah</th>" : ""}</tr></thead>
      <tbody>
        ${keys.filter(k => k !== "tenant_id").map(k => `
          <tr><td><code>${esc(k)}</code></td>
          ${r.action !== "insert" ? `<td>${esc(shortValFull(old[k]))}</td>` : ""}
          ${r.action !== "delete" ? `<td>${esc(shortValFull(nw[k]))}</td>` : ""}</tr>`).join("")}
      </tbody>
    </table>` : "";
  document.getElementById("al-modal-body").innerHTML = meta + body;
  document.getElementById("al-modal").classList.remove("hidden");
}

function shortValFull(v) {
  if (v === null || v === undefined) return "∅";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 400 ? s.slice(0, 397) + "…" : s;
}

async function doExport() {
  const btn = document.getElementById("al-export");
  btn.disabled = true; btn.textContent = "Menyiapkan…";
  try {
    const rows = await fetchAllRows(() => buildQuery("*"));
    exportXLSX(`audit-log-${todayISO()}.xlsx`, rows.map(r => ({
      Waktu: fmtWhen(r.at),
      Pelaku: r.actor_name || "-",
      Role: r.actor_role || "-",
      Aksi: ACTION_LABELS[r.action] || r.action,
      Data: TABLE_LABELS[r.table_name] || r.table_name || "-",
      Keterangan: describe(r),
      "Sebelum (JSON)": r.old_data ? JSON.stringify(r.old_data).slice(0, 32000) : "",
      "Sesudah (JSON)": r.new_data ? JSON.stringify(r.new_data).slice(0, 32000) : "",
    })), "Audit Log");
  } catch (e) {
    toast("Gagal export: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Export Excel";
  }
}
