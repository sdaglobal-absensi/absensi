// Ekspor & Backup — unduh semua data usaha ke satu file Excel (banyak sheet)
// atau JSON. Foto TIDAK ikut diunduh (hanya path-nya); backup database
// Supabase juga tidak mencakup isi Storage.
import { supabase } from "../supabaseClient.js";
import { toast, todayISO, fetchAllRows } from "../core.js";

// Tabel yang diekspor. order = kolom yang membuat urutan unik (wajib untuk
// paging yang akurat). Tabel yang belum ada di project / tidak boleh dibaca
// role ini dilewati dan dilaporkan di hasil.
const DATASETS = [
  { t: "profiles", label: "Karyawan", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "employee_children", label: "Data Anak Karyawan", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "departments", label: "Departemen", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "job_levels", label: "Level", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "master_pt", label: "PT / Vendor", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "org_units", label: "Unit Organisasi", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "org_unit_members", label: "Anggota Unit", order: ["id"], group: "Karyawan & Organisasi" },
  { t: "profile_change_requests", label: "Pengajuan Ubah Data", order: ["id"], group: "Karyawan & Organisasi" },

  { t: "office_locations", label: "Lokasi Kantor", order: ["id"], group: "Absensi & Jadwal" },
  { t: "work_schedules", label: "Jadwal Kerja", order: ["id"], group: "Absensi & Jadwal" },
  { t: "work_schedule_days", label: "Hari Jadwal Kerja", order: ["id"], group: "Absensi & Jadwal" },
  { t: "employee_schedule_history", label: "Riwayat Jadwal Karyawan", order: ["id"], group: "Absensi & Jadwal" },
  { t: "holidays", label: "Hari Libur", order: ["id"], group: "Absensi & Jadwal" },
  { t: "attendance", label: "Absensi", order: ["id"], group: "Absensi & Jadwal", dateCol: "date", big: true },
  { t: "attendance_correction_requests", label: "Koreksi Absen", order: ["id"], group: "Absensi & Jadwal" },

  { t: "leave_requests", label: "Pengajuan Izin & Cuti", order: ["id"], group: "Izin, Cuti & Lembur" },
  { t: "leave_balances", label: "Kuota Cuti", order: ["id"], group: "Izin, Cuti & Lembur" },
  { t: "special_leave_rules", label: "Aturan Cuti Khusus", order: ["tenant_id", "kode"], group: "Izin, Cuti & Lembur" },
  { t: "overtime_requests", label: "Pengajuan Lembur", order: ["id"], group: "Izin, Cuti & Lembur" },
  { t: "request_approvals", label: "Langkah Approval", order: ["id"], group: "Izin, Cuti & Lembur" },
  { t: "approval_settings", label: "Pengaturan Approval", order: ["tenant_id", "request_type"], group: "Izin, Cuti & Lembur" },

  { t: "wage_history", label: "Riwayat Upah", order: ["id"], group: "Payroll" },
  { t: "salary_history", label: "Riwayat Gaji", order: ["id"], group: "Payroll" },
  { t: "allowance_types", label: "Master Tunjangan", order: ["id"], group: "Payroll" },
  { t: "employee_allowances", label: "Tunjangan Karyawan", order: ["id"], group: "Payroll" },
  { t: "late_penalty_rules", label: "Aturan Denda Telat", order: ["id"], group: "Payroll" },
  { t: "payroll_settings", label: "Pengaturan Gaji", order: ["tenant_id", "id"], group: "Payroll" },
  { t: "payroll_periods", label: "Periode Gaji", order: ["tenant_id", "period"], group: "Payroll" },
  { t: "payroll_slips", label: "Slip Gaji", order: ["id"], group: "Payroll" },
  { t: "payroll_adjustments", label: "Penyesuaian Gaji", order: ["id"], group: "Payroll" },
  { t: "outsourcing_invoices", label: "Invoice Outsourcing", order: ["id"], group: "Payroll" },
  { t: "outsourcing_area_invoices", label: "Invoice Outsourcing Area", order: ["id"], group: "Payroll" },

  { t: "role_permissions", label: "Akses Menu per Role", order: ["tenant_id", "role", "menu_id"], group: "Sistem" },
  { t: "audit_log", label: "Audit Log", order: ["id"], group: "Sistem", dateCol: "at", big: true },
];

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function render(container, user) {
  const groups = [...new Set(DATASETS.map(d => d.group))];
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Ekspor & Backup</h1>
        <p class="muted">Unduh salinan data usaha kamu. Simpan file ini di tempat aman — isinya data pribadi karyawan (termasuk gaji).</p>
      </div>
    </div>

    <div class="card" style="padding:16px 18px;margin-bottom:14px;">
      <div class="form-row two-col">
        <label>Format
          <select id="eb-format">
            <option value="xlsx">Excel (.xlsx) — satu sheet per data</option>
            <option value="json">JSON (.json) — cocok untuk backup/pindah sistem</option>
          </select>
        </label>
        <label class="checkbox-row" style="align-self:end;"><input type="checkbox" id="eb-all" checked> Pilih semua</label>
      </div>
      <div class="form-row two-col" style="margin-top:8px;">
        <label>Absensi & Audit Log: dari tanggal <input type="date" id="eb-start"></label>
        <label>sampai tanggal <input type="date" id="eb-end"></label>
      </div>
      <p class="small muted" style="margin:4px 0 0;">Kosongkan tanggal untuk mengunduh seluruh riwayat (bisa lama kalau datanya banyak).</p>
    </div>

    ${groups.map(g => `
      <div class="card" style="padding:14px 18px;margin-bottom:12px;">
        <strong>${esc(g)}</strong>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px 14px;margin-top:8px;">
          ${DATASETS.filter(d => d.group === g).map(d => `
            <label class="checkbox-row"><input type="checkbox" class="eb-ds" value="${d.t}" checked> ${esc(d.label)}</label>`).join("")}
        </div>
      </div>`).join("")}

    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <button id="eb-go" class="btn-primary">Unduh</button>
      <span id="eb-status" class="small muted"></span>
    </div>
    <div id="eb-result" style="margin-top:12px;"></div>

    <div class="card" style="padding:14px 18px;margin-top:18px;">
      <strong>Yang TIDAK ikut</strong>
      <ul class="small muted" style="margin:6px 0 0 18px;">
        <li>Foto absensi & foto profil (ada di Storage; di data hanya tercatat path-nya). Foto bisa diunduh dari Dashboard Supabase → Storage.</li>
        <li>Akun login (email/password/PIN) dan data langganan notifikasi.</li>
        <li>Backup database otomatis Supabase juga tidak mencakup isi Storage.</li>
      </ul>
    </div>
  `;

  const all = document.getElementById("eb-all");
  all.addEventListener("change", () => document.querySelectorAll(".eb-ds").forEach(c => { c.checked = all.checked; }));
  document.getElementById("eb-go").addEventListener("click", () => run(user));
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Sel Excel maksimal 32.767 karakter; objek/array dijadikan teks JSON.
function flattenForSheet(rows) {
  return rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      let x = v;
      if (x !== null && typeof x === "object") x = JSON.stringify(x);
      if (typeof x === "string" && x.length > 32000) x = x.slice(0, 32000) + "…(terpotong)";
      o[k] = x;
    }
    return o;
  });
}

async function run(user) {
  const btn = document.getElementById("eb-go");
  const status = document.getElementById("eb-status");
  const result = document.getElementById("eb-result");
  const format = document.getElementById("eb-format").value;
  const start = document.getElementById("eb-start").value;
  const end = document.getElementById("eb-end").value;
  const chosen = new Set([...document.querySelectorAll(".eb-ds:checked")].map(c => c.value));
  const list = DATASETS.filter(d => chosen.has(d.t));
  if (!list.length) { toast("Pilih minimal satu data", "error"); return; }
  if (start && end && start > end) { toast("Tanggal 'dari' harus sebelum 'sampai'", "error"); return; }
  if (format === "xlsx" && typeof XLSX === "undefined") { toast("Library Excel belum termuat, refresh halaman.", "error"); return; }

  btn.disabled = true;
  result.innerHTML = "";
  const got = {};      // tabel -> baris
  const skipped = [];  // { label, reason }

  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    status.textContent = `Mengambil ${d.label} (${i + 1}/${list.length})…`;
    try {
      const rows = await fetchAllRows(() => {
        let q = supabase.from(d.t).select("*");
        if (d.dateCol && start) q = q.gte(d.dateCol, d.dateCol === "at" ? new Date(`${start}T00:00:00`).toISOString() : start);
        if (d.dateCol && end) q = q.lte(d.dateCol, d.dateCol === "at" ? new Date(new Date(`${end}T00:00:00`).getTime() + 86400000 - 1).toISOString() : end);
        for (const c of d.order) q = q.order(c, { ascending: true });
        return q;
      });
      got[d.t] = rows;
    } catch (e) {
      skipped.push({ label: d.label, reason: e.message || String(e) });
    }
  }

  const done = DATASETS.filter(d => got[d.t]);
  if (!done.length) {
    btn.disabled = false; status.textContent = "";
    result.innerHTML = `<p class="muted">Tidak ada data yang bisa diambil. ${skipped.map(s => esc(s.label + ": " + s.reason)).join("; ")}</p>`;
    return;
  }

  status.textContent = "Menyusun file…";
  const stamp = todayISO();
  try {
    if (format === "json") {
      const payload = {
        exported_at: new Date().toISOString(),
        exported_by: user.full_name || user.id,
        tenant_id: user.tenant_id,
        filter: { start: start || null, end: end || null },
        tables: got,
      };
      download(`backup-data-${stamp}.json`, new Blob([JSON.stringify(payload)], { type: "application/json" }));
    } else {
      const wb = XLSX.utils.book_new();
      for (const d of done) {
        const rows = got[d.t];
        const ws = rows.length ? XLSX.utils.json_to_sheet(flattenForSheet(rows)) : XLSX.utils.aoa_to_sheet([["(kosong)"]]);
        XLSX.utils.book_append_sheet(wb, ws, d.label.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
      }
      XLSX.writeFile(wb, `backup-data-${stamp}.xlsx`);
    }
  } catch (e) {
    toast("Gagal membuat file: " + e.message, "error");
    btn.disabled = false; status.textContent = "";
    return;
  }

  const total = done.reduce((n, d) => n + got[d.t].length, 0);
  supabase.rpc("log_export", {
    p_summary: `Ekspor & Backup (${format.toUpperCase()}): ${done.length} data, ${total} baris`,
    p_data: { format, tables: done.map(d => d.t), rows: total, start: start || null, end: end || null },
  }).then(() => {}, () => {});

  btn.disabled = false;
  status.textContent = "";
  result.innerHTML = `
    <div class="card" style="padding:12px 16px;">
      <strong>Selesai.</strong> ${done.length} data, ${total.toLocaleString("id-ID")} baris.
      <ul class="small muted" style="margin:6px 0 0 18px;">
        ${done.map(d => `<li>${esc(d.label)}: ${got[d.t].length.toLocaleString("id-ID")} baris</li>`).join("")}
      </ul>
      ${skipped.length ? `<p class="small" style="margin:8px 0 0;"><strong>Dilewati</strong> (tabel belum ada atau role kamu tidak boleh membacanya):
        ${skipped.map(s => esc(s.label)).join(", ")}</p>` : ""}
    </div>`;
  toast("Unduhan siap", "success");
}
