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
//      "Download Template Excel" menghasilkan file dengan kolom yang sama,
//      sudah terisi kode & nama seluruh karyawan aktif (plus kuota yang
//      sedang tampil di layar) supaya admin tinggal edit angkanya lalu
//      import ulang. Ada kotak pencarian untuk cari karyawan tertentu di
//      tabel tanpa kehilangan input yang belum disimpan (baris disembunyikan
//      lewat CSS, bukan di-render ulang).
//      Bisa dijalankan ulang tiap tahun — kuota per tahun tersimpan
//      terpisah (unique user_id+tahun), tidak menimpa histori tahun lalu.
//   2. Master Cuti Khusus (special_leave_rules) — jumlah hari per satu
//      dari jenis-jenis cuti khusus bisa diubah di sini tanpa menyentuh
//      kode. Admin juga bisa Tambah jenis baru atau Hapus jenis yang
//      sudah tidak dipakai lewat menu di tiap baris / tombol di atas tabel.
// =======================================================================

let activeTab = "tahunan";
let employees = [];
let balances = {}; // { user_id: row leave_balances | undefined }
let specialRules = [];
let selectedYear = new Date().getFullYear();
let searchQuery = "";

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
          <button id="btn-template" class="btn-secondary">Download Template Excel</button>
          <button id="btn-import" class="btn-secondary">Import dari Excel</button>
          <button id="btn-save-all" class="btn-primary">Simpan Semua Perubahan</button>
        </div>
      </div>
      <p class="muted small page-subtext">Kolom Excel yang dibaca: <strong>Kode Karyawan</strong>, <strong>Nama</strong> (info saja), <strong>Kuota Hari</strong>. Dicocokkan lewat Kode Karyawan. Belum punya filenya? Klik <strong>Download Template Excel</strong> — sudah terisi kode &amp; nama semua karyawan aktif, tinggal isi/ubah angka Kuota Hari lalu import lagi.</p>
      <input type="text" id="search-tahunan" placeholder="Cari nama atau kode karyawan…" style="max-width:320px; margin-top:8px;">
      <div id="kuota-table" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>
    </div>

    <div id="panel-khusus" class="hidden">
      <div class="page-header" style="margin:0 0 4px;">
        <p class="muted small" style="max-width:70ch; margin:0;">Jumlah hari di sini otomatis dipakai saat karyawan memilih jenis Cuti Khusus di Pengajuan Izin — tanggal selesai ikut terhitung ulang otomatis kalau angkanya diubah. Tambah jenis baru atau hapus yang sudah tidak dipakai lewat tombol di bawah.</p>
        <button id="btn-tambah-khusus" class="btn-primary">+ Tambah Jenis Cuti Khusus</button>
      </div>
      <input type="text" id="search-khusus" placeholder="Cari jenis cuti khusus…" style="max-width:320px; margin:12px 0 0;">
      <div id="khusus-table" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>
    </div>

    <div id="modal-khusus" class="modal hidden">
      <div class="modal-box">
        <h3>Tambah Jenis Cuti Khusus</h3>
        <form id="form-khusus-new">
          <div class="form-row">
            <label>Nama Jenis Cuti Khusus <input name="label" required maxlength="150" placeholder="Contoh: Cuti Duka Sahabat Dekat"></label>
          </div>
          <div class="form-row">
            <label>Jumlah Hari <input type="number" name="jumlah_hari" min="1" step="1" value="1" required></label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-khusus" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
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
  document.getElementById("btn-template").addEventListener("click", downloadTemplate);
  document.getElementById("search-tahunan").addEventListener("input", e => {
    searchQuery = e.target.value;
    applyTahunanFilter();
  });

  document.getElementById("btn-tambah-khusus").addEventListener("click", () => openKhususModal());
  document.getElementById("btn-cancel-khusus").addEventListener("click", closeKhususModal);
  document.getElementById("form-khusus-new").addEventListener("submit", e => onSubmitKhususNew(e, user));
  document.getElementById("search-khusus").addEventListener("input", e => applyKhususFilter(e.target.value));

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
          const searchKey = `${emp.full_name} ${emp.employee_code || ""}`.toLowerCase();
          return `
            <tr data-search="${esc(searchKey)}">
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
    <p id="tahunan-empty-search" class="muted hidden" style="padding:14px;">Tidak ada karyawan yang cocok dengan pencarian.</p>
  `;
  employees.forEach(emp => {
    const input = document.getElementById(rowInputId(emp.id));
    const sisaEl = document.getElementById(`${rowInputId(emp.id)}-sisa`);
    const terpakai = balances[emp.id]?.terpakai_hari || 0;
    input.addEventListener("input", () => {
      sisaEl.textContent = Math.max(0, (Number(input.value) || 0) - terpakai);
    });
  });
  applyTahunanFilter();
}

function applyTahunanFilter() {
  const q = searchQuery.trim().toLowerCase();
  const rows = document.querySelectorAll("#kuota-table tbody tr");
  let visible = 0;
  rows.forEach(tr => {
    const match = !q || (tr.dataset.search || "").includes(q);
    tr.style.display = match ? "" : "none";
    if (match) visible++;
  });
  const emptyMsg = document.getElementById("tahunan-empty-search");
  if (emptyMsg) emptyMsg.classList.toggle("hidden", !q || visible > 0);
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

function downloadTemplate() {
  if (typeof XLSX === "undefined") { toast("Fitur template butuh library XLSX yang belum termuat.", "error"); return; }
  if (!employees.length) { toast("Belum ada karyawan aktif untuk dibuatkan template.", "error"); return; }

  const rows = employees.map(emp => {
    const input = document.getElementById(rowInputId(emp.id));
    const kuota = input ? (Number(input.value) || 0) : (balances[emp.id]?.kuota_hari ?? 12);
    return {
      "Kode Karyawan": emp.employee_code || "",
      "Nama": emp.full_name,
      "Kuota Hari": kuota,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 20 }, { wch: 30 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Kuota Cuti");
  XLSX.writeFile(wb, `Template_Kuota_Cuti_Tahunan_${selectedYear}.xlsx`);
  toast("Template Excel diunduh. Isi/ubah kolom Kuota Hari lalu import lagi lewat \"Import dari Excel\".", "success");
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

  // Reset pencarian supaya semua baris yang baru diisi dari Excel kelihatan.
  searchQuery = "";
  const searchInput = document.getElementById("search-tahunan");
  if (searchInput) searchInput.value = "";
  applyTahunanFilter();

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
  if (!specialRules.length) { el.innerHTML = `<p class="muted">Belum ada data master Cuti Khusus. Klik "+ Tambah Jenis Cuti Khusus" untuk menambahkan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Jenis Cuti Khusus</th><th>Jumlah Hari</th><th></th></tr></thead>
      <tbody>
        ${specialRules.map(r => `
          <tr data-search="${esc(r.label.toLowerCase())}">
            <td>${esc(r.label)}</td>
            <td><input type="number" id="khusus-input-${esc(r.kode)}" min="1" step="1" value="${r.jumlah_hari}" style="width:90px;"></td>
            <td style="white-space:nowrap;">
              <button class="btn-link btn-save-khusus" data-kode="${esc(r.kode)}">Simpan</button>
              &nbsp;|&nbsp;
              <button class="btn-link-danger btn-hapus-khusus" data-kode="${esc(r.kode)}">Hapus</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    <p id="khusus-empty-search" class="muted hidden" style="padding:14px;">Tidak ada jenis cuti khusus yang cocok dengan pencarian.</p>
  `;
  el.querySelectorAll(".btn-save-khusus").forEach(b => b.addEventListener("click", () => saveKhusus(b.dataset.kode, user)));
  el.querySelectorAll(".btn-hapus-khusus").forEach(b => b.addEventListener("click", () => deleteKhusus(b.dataset.kode)));

  const searchInput = document.getElementById("search-khusus");
  if (searchInput) applyKhususFilter(searchInput.value);
}

function applyKhususFilter(query) {
  const q = (query || "").trim().toLowerCase();
  const rows = document.querySelectorAll("#khusus-table tbody tr");
  let visible = 0;
  rows.forEach(tr => {
    const match = !q || (tr.dataset.search || "").includes(q);
    tr.style.display = match ? "" : "none";
    if (match) visible++;
  });
  const emptyMsg = document.getElementById("khusus-empty-search");
  if (emptyMsg) emptyMsg.classList.toggle("hidden", !q || visible > 0);
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

async function deleteKhusus(kode) {
  const rule = specialRules.find(r => r.kode === kode);
  const ok = await confirmDialog({
    title: `Hapus jenis cuti khusus "${rule ? rule.label : kode}"?`,
    message: "Jenis cuti khusus ini tidak akan bisa dipilih lagi di Pengajuan Izin. Kalau sudah pernah dipakai di pengajuan cuti sebelumnya, penghapusan akan ditolak sistem supaya histori pengajuan tidak rusak.",
    confirmLabel: "Ya, Hapus",
    confirmClass: "btn-danger",
  });
  if (!ok) return;

  const { error } = await supabase.from("special_leave_rules").delete().eq("kode", kode);
  if (error) {
    const isFkViolation = error.code === "23503" || /foreign key|violat/i.test(error.message || "");
    toast(
      isFkViolation
        ? `Tidak bisa dihapus: jenis cuti ini sudah pernah dipakai di pengajuan cuti karyawan.`
        : "Gagal menghapus: " + error.message,
      "error"
    );
    return;
  }
  toast("Jenis cuti khusus dihapus", "success");
  await loadKhusus();
  renderKhusus();
}

function slugifyKode(label) {
  const base = (label || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);
  return base || `cuti_khusus_${Date.now()}`;
}

function openKhususModal() {
  const form = document.getElementById("form-khusus-new");
  form.reset();
  document.getElementById("modal-khusus").classList.remove("hidden");
  form.label.focus();
}

function closeKhususModal() {
  document.getElementById("modal-khusus").classList.add("hidden");
}

async function onSubmitKhususNew(e, user) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const label = String(fd.get("label") || "").trim();
  const jumlah = Number(fd.get("jumlah_hari"));
  if (!label) { toast("Nama jenis cuti khusus wajib diisi", "error"); return; }
  if (!Number.isFinite(jumlah) || jumlah <= 0) { toast("Jumlah hari harus lebih dari 0", "error"); return; }

  const existingKodes = new Set(specialRules.map(r => r.kode));
  let kode = slugifyKode(label);
  let suffix = 2;
  while (existingKodes.has(kode)) { kode = `${slugifyKode(label)}_${suffix}`; suffix++; }
  const nextSort = specialRules.reduce((max, r) => Math.max(max, r.sort_order || 0), 0) + 1;

  const { error } = await supabase.from("special_leave_rules").insert({
    kode,
    label,
    jumlah_hari: jumlah,
    sort_order: nextSort,
    updated_by: user.id,
  });
  if (error) { toast("Gagal menambahkan: " + error.message, "error"); return; }

  invalidateSpecialLeaveRulesCache();
  toast(`Jenis cuti khusus "${label}" ditambahkan`, "success");
  closeKhususModal();
  await loadKhusus();
  renderKhusus(user);
}
