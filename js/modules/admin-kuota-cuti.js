import { supabase } from "../supabaseClient.js";
import { toast, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";
import { invalidateSpecialLeaveRulesCache } from "../leaveRules.js";

// =======================================================================
// Kuota Cuti Tahunan (menu admin) — dua bagian:
//   1. Kuota per karyawan per tahun (leave_balances). Kuota diisi manual
//      per baris, atau lewat "Import dari Excel" (kolom: Kode Karyawan,
//      Nama, Kuota Hari — dicocokkan lewat Kode Karyawan; baris yang
//      kodenya tidak ketemu dilaporkan gagal, tidak di-skip diam-diam).
//      Bisa dijalankan ulang tiap tahun — kuota per tahun tersimpan
//      terpisah (unique user_id+tahun), tidak menimpa histori tahun lalu.
//   2. Master Cuti Khusus (special_leave_rules) — jumlah hari per satu
//      dari 7 jenis bisa diubah di sini tanpa menyentuh kode.
// =======================================================================

let activeTab = "tahunan";
let employees = [];
let balances = {}; // { user_id: row leave_balances | undefined }
let specialRules = [];
let selectedYear = new Date().getFullYear();

export async function render(container, user) {
  const years = [selectedYear - 1, selectedYear, selectedYear + 1];

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Kuota Cuti Tahunan</h1>
        <p class="muted">Atur kuota Cuti Tahunan per karyawan per tahun, dan jumlah hari untuk tiap jenis Cuti Khusus.</p>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="tahunan">Kuota Cuti Tahunan</button>
      <button class="tab-btn" data-tab="khusus">Master Cuti Khusus</button>
    </div>

    <div id="panel-tahunan">
      <div class="page-header">
        <div class="form-row" style="margin:0;">
          <label>Tahun
            <select id="tahun-select">
              ${years.map(y => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}</option>`).join("")}
            </select>
          </label>
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <input type="file" id="import-file" accept=".xlsx,.xls" class="hidden">
          <button id="btn-import" class="btn-secondary">Import dari Excel</button>
          <button id="btn-save-all" class="btn-primary">Simpan Semua Perubahan</button>
        </div>
      </div>
      <p class="muted small" style="margin-top:-16px;">Kolom Excel yang dibaca: <strong>Kode Karyawan</strong>, <strong>Nama</strong> (info saja), <strong>Kuota Hari</strong>. Dicocokkan lewat Kode Karyawan.</p>
      <div id="kuota-table" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>
    </div>

    <div id="panel-khusus" class="hidden">
      <p class="muted small" style="max-width:70ch;">Jumlah hari di sini otomatis dipakai saat karyawan memilih jenis Cuti Khusus di Pengajuan Izin — tanggal selesai ikut terhitung ulang otomatis kalau angkanya diubah.</p>
      <div id="khusus-table" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>
    </div>
  `;

  container.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  document.getElementById("tahun-select").addEventListener("change", async e => {
    selectedYear = Number(e.target.value);
    await loadTahunan();
    renderTahunan(user);
  });
  document.getElementById("btn-save-all").addEventListener("click", () => saveAllTahunan(user));
  document.getElementById("btn-import").addEventListener("click", () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", e => onImportExcel(e, user));

  await loadTahunan();
  renderTahunan(user);
  await loadKhusus();
  renderKhusus(user);
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("panel-tahunan").classList.toggle("hidden", tab !== "tahunan");
  document.getElementById("panel-khusus").classList.toggle("hidden", tab !== "khusus");
}

// =======================================================================
// TAB 1: KUOTA CUTI TAHUNAN
// =======================================================================
async function loadTahunan() {
  const [{ data: emp }, { data: bal }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, employee_code, department").eq("is_active", true).order("full_name"),
    supabase.from("leave_balances").select("*").eq("tahun", selectedYear),
  ]);
  employees = emp || [];
  balances = {};
  (bal || []).forEach(b => { balances[b.user_id] = b; });
}

function rowInputId(userId) { return `kuota-input-${userId}`; }

function renderTahunan() {
  const el = document.getElementById("kuota-table");
  if (!employees.length) { el.innerHTML = `<p class="muted">Belum ada karyawan aktif.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Kode Karyawan</th><th>Kuota Hari/Tahun</th><th>Terpakai</th><th>Sisa</th></tr></thead>
      <tbody>
        ${employees.map(emp => {
          const b = balances[emp.id];
          const kuota = b ? b.kuota_hari : 12;
          const terpakai = b ? b.terpakai_hari : 0;
          return `
            <tr>
              <td>${esc(emp.full_name)}</td>
              <td>${esc(emp.employee_code || "-")}</td>
              <td><input type="number" id="${rowInputId(emp.id)}" min="0" step="1" value="${kuota}" style="width:100px;"></td>
              <td>${terpakai}</td>
              <td id="${rowInputId(emp.id)}-sisa">${Math.max(0, kuota - terpakai)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
  employees.forEach(emp => {
    const input = document.getElementById(rowInputId(emp.id));
    const sisaEl = document.getElementById(`${rowInputId(emp.id)}-sisa`);
    const terpakai = balances[emp.id]?.terpakai_hari || 0;
    input.addEventListener("input", () => {
      sisaEl.textContent = Math.max(0, (Number(input.value) || 0) - terpakai);
    });
  });
}

async function saveAllTahunan(user) {
  const rows = employees.map(emp => ({
    user_id: emp.id,
    tahun: selectedYear,
    kuota_hari: Number(document.getElementById(rowInputId(emp.id)).value) || 0,
    updated_by: user.id,
  }));

  const ok = await confirmDialog({
    title: `Simpan kuota Cuti Tahunan ${selectedYear} untuk ${rows.length} karyawan?`,
    message: "Kuota per karyawan yang belum pernah diatur untuk tahun ini akan dibuat baru; yang sudah ada akan diperbarui angkanya.",
    confirmLabel: "Ya, Simpan",
  });
  if (!ok) return;

  const { error } = await supabase.from("leave_balances").upsert(rows, { onConflict: "user_id,tahun" });
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }
  toast(`Kuota Cuti Tahunan ${selectedYear} tersimpan untuk ${rows.length} karyawan`, "success");
  await loadTahunan();
  renderTahunan();
}

async function onImportExcel(e, user) {
  const file = e.target.files[0];
  e.target.value = ""; // supaya file yang sama bisa dipilih lagi kalau mau import ulang
  if (!file) return;
  if (typeof XLSX === "undefined") { toast("Fitur import butuh library XLSX yang belum termuat.", "error"); return; }

  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (!rows.length) { toast("File Excel kosong atau format kolom tidak dikenali.", "error"); return; }

  const byCode = new Map(employees.filter(e2 => e2.employee_code).map(e2 => [String(e2.employee_code).trim(), e2]));
  let matched = 0;
  const failed = [];

  rows.forEach(row => {
    const kode = String(row["Kode Karyawan"] ?? "").trim();
    const kuota = Number(row["Kuota Hari"]);
    if (!kode) { failed.push("(baris tanpa Kode Karyawan)"); return; }
    const emp = byCode.get(kode);
    if (!emp) { failed.push(kode); return; }
    if (!Number.isFinite(kuota)) { failed.push(`${kode} (Kuota Hari bukan angka)`); return; }
    const input = document.getElementById(rowInputId(emp.id));
    if (input) {
      input.value = kuota;
      input.dispatchEvent(new Event("input"));
      matched++;
    }
  });

  toast(
    failed.length
      ? `${matched} baris cocok, ${failed.length} gagal (kode tidak ditemukan): ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", …" : ""}`
      : `${matched} baris berhasil dicocokkan. Klik "Simpan Semua Perubahan" untuk menyimpan.`,
    failed.length ? "error" : "success"
  );
}

// =======================================================================
// TAB 2: MASTER CUTI KHUSUS
// =======================================================================
async function loadKhusus() {
  const { data } = await supabase.from("special_leave_rules").select("*").order("sort_order");
  specialRules = data || [];
}

function renderKhusus(user) {
  const el = document.getElementById("khusus-table");
  if (!specialRules.length) { el.innerHTML = `<p class="muted">Belum ada data master Cuti Khusus.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Jenis Cuti Khusus</th><th>Jumlah Hari</th><th></th></tr></thead>
      <tbody>
        ${specialRules.map(r => `
          <tr>
            <td>${esc(r.label)}</td>
            <td><input type="number" id="khusus-input-${esc(r.kode)}" min="1" step="1" value="${r.jumlah_hari}" style="width:90px;"></td>
            <td><button class="btn-link btn-save-khusus" data-kode="${esc(r.kode)}">Simpan</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll(".btn-save-khusus").forEach(b => b.addEventListener("click", () => saveKhusus(b.dataset.kode, user)));
}

async function saveKhusus(kode, user) {
  const input = document.getElementById(`khusus-input-${kode}`);
  const jumlah = Number(input.value);
  if (!Number.isFinite(jumlah) || jumlah <= 0) { toast("Jumlah hari harus lebih dari 0", "error"); return; }

  const { error } = await supabase.from("special_leave_rules")
    .update({ jumlah_hari: jumlah, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("kode", kode);
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }
  invalidateSpecialLeaveRulesCache();
  toast("Jumlah hari tersimpan", "success");
  await loadKhusus();
  renderKhusus(user);
}
