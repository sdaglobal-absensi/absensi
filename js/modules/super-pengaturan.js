import { supabase } from "../supabaseClient.js";
import { toast, invalidatePermissionCache, invalidatePayrollSettingsCache, payrollPeriodRange, fmtDate } from "../core.js";

// =======================================================================
// PENGATURAN SISTEM — khusus Super Admin & Super Admin HR:
//   1. Kelola Akses Admin HR — nyalakan/matikan menu mana saja yang boleh
//      dibuka role Admin HR (tersimpan di tabel role_permissions).
//   2. Periode Cut-Off Slip Gaji — atur tanggal mulai periode gajian kalau
//      perusahaan pakai cut-off (mis. tgl 26 - 25), bukan kalender biasa.
// RLS di Supabase tetap jadi penjaga utama (bukan cuma sembunyi menu di
// sidebar) — jadi walau ada yang coba akses langsung lewat API, Admin HR
// tetap tertahan di tabel yang menu-nya belum diizinkan.
// =======================================================================

const MENU_LABELS = {
  "karyawan": "Data Karyawan",
  "absensi-monitor": "Monitor Absensi",
  "izin-approval": "Approval Izin",
  "lembur-approval": "Approval Lembur",
  "kenaikan-upah": "Kenaikan Upah & Gaji",
  "slip-gaji": "Slip Gaji",
  "laporan": "Laporan",
  "master-level": "Master Level",
  "master-tunjangan": "Master Tunjangan",
  "master-denda": "Master Denda Telat",
  "master-departemen": "Master Departemen",
  "master-jadwal": "Master Jadwal Kerja",
  "master-libur": "Master Hari Libur",
  "master-lokasi": "Master Lokasi Kantor",
};

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Pengaturan Sistem</h1>
        <p class="muted">Halaman ini cuma bisa dibuka Super Admin &amp; Super Admin HR.</p>
      </div>
    </div>

    <h3 style="margin-bottom:10px;">Kelola Akses Admin HR</h3>
    <p class="muted small" style="margin-top:-6px; margin-bottom:14px;">
      Nyalakan menu yang boleh dibuka akun ber-role <strong>Admin HR</strong>. Menu yang dimatikan
      otomatis hilang dari sidebar mereka, dan aksesnya tetap ditolak di sisi server walau dicoba
      lewat cara lain.
    </p>
    <div id="perm-list" class="table-wrap" style="margin-bottom:32px;"><p class="muted">Memuat…</p></div>

    <h3 style="margin-bottom:10px;">Periode Cut-Off Slip Gaji</h3>
    <p class="muted small" style="margin-top:-6px; margin-bottom:14px;">
      Berlaku global untuk semua karyawan, berulang tiap bulan. Pilih <strong>tanggal mulai</strong>
      periode yang sedang berjalan (lengkap tanggal/bulan/tahun biar jelas) — tanggal selesai
      terisi otomatis, dan aturan ini otomatis berlaku sama untuk bulan-bulan berikutnya juga.
      Khusus tanggal 1 - 28 (supaya konsisten walau di bulan Februari).
    </p>
    <form id="form-cutoff" class="form-row two-col" style="align-items:end; max-width:420px;">
      <label>Tanggal Mulai (periode berjalan)
        <input type="date" id="cutoff-start" required>
      </label>
      <label>Tanggal Selesai <span class="muted small">(otomatis)</span>
        <input type="date" id="cutoff-end" disabled>
      </label>
    </form>
    <p class="muted small" id="cutoff-preview" style="margin-top:10px;"></p>
    <button type="submit" form="form-cutoff" class="btn-primary" style="margin-top:14px;">Simpan</button>
  `;

  document.getElementById("cutoff-start").addEventListener("input", updateCutoffPreview);
  document.getElementById("form-cutoff").addEventListener("submit", e => onSubmitCutoff(e, user));

  await loadPermissions(user);
  await loadCutoff();
}

// -----------------------------------------------------------------------
async function loadPermissions(user) {
  const el = document.getElementById("perm-list");
  const { data, error } = await supabase.from("role_permissions").select("*").order("menu_id");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  const rows = (data || []).filter(r => MENU_LABELS[r.menu_id]);

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Menu</th><th>Akses Admin HR</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${MENU_LABELS[r.menu_id] || r.menu_id}</td>
            <td>
              <label class="checkbox-row">
                <input type="checkbox" class="perm-toggle" data-menu="${r.menu_id}" ${r.enabled ? "checked" : ""}>
                <span>${r.enabled ? "Diizinkan" : "Tidak diizinkan"}</span>
              </label>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".perm-toggle").forEach(cb => {
    cb.addEventListener("change", () => onTogglePermission(cb, user));
  });
}

async function onTogglePermission(checkbox, user) {
  const menuId = checkbox.dataset.menu;
  const enabled = checkbox.checked;
  checkbox.disabled = true;

  const { error } = await supabase
    .from("role_permissions")
    .update({ enabled, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("menu_id", menuId);

  checkbox.disabled = false;
  if (error) {
    toast("Gagal menyimpan: " + error.message, "error");
    checkbox.checked = !enabled; // revert tampilan kalau gagal
    return;
  }

  checkbox.closest("tr").querySelector("span").textContent = enabled ? "Diizinkan" : "Tidak diizinkan";
  invalidatePermissionCache();
  toast(`Akses "${MENU_LABELS[menuId] || menuId}" untuk Admin HR ${enabled ? "diaktifkan" : "dimatikan"}`, "success");
}

// -----------------------------------------------------------------------
function toISODateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadCutoff() {
  const { data, error } = await supabase.from("payroll_settings").select("cutoff_start_day").eq("id", 1).single();
  const day = error || !data ? 1 : (data.cutoff_start_day || 1);
  // Tampilkan tanggal mulai periode yang SEDANG BERJALAN hari ini (lengkap
  // tanggal/bulan/tahun), bukan cuma angka tanggalnya — biar langsung
  // kebayang periode konkret yang aktif sekarang.
  const { start } = payrollPeriodRange(currentActivePeriod(day), day);
  document.getElementById("cutoff-start").value = start;
  updateCutoffPreview();
}

// Tanggal Selesai + contoh rentang periode, dihitung ulang tiap Tanggal
// Mulai diganti. Aturan cut-off ini BERULANG tiap bulan — tanggal & bulan
// yang dipilih cuma dipakai untuk menentukan tanggal berapa dalam sebulan
// yang jadi patokan (tahunnya cuma buat tampilan, tidak disimpan).
function updateCutoffPreview() {
  const startEl = document.getElementById("cutoff-start");
  const endEl = document.getElementById("cutoff-end");
  const previewEl = document.getElementById("cutoff-preview");
  const startVal = startEl.value; // "YYYY-MM-DD"

  if (!startVal) { endEl.value = ""; previewEl.textContent = ""; return; }

  const [y, m, d] = startVal.split("-").map(Number);
  if (d > 28) {
    previewEl.innerHTML = `<span style="color:#c0392b;">Pilih tanggal 1 - 28 saja supaya aturannya tetap konsisten walau di bulan Februari.</span>`;
    endEl.value = "";
    return;
  }

  const m0 = m - 1; // 0-indexed
  const endDate = d === 1 ? new Date(y, m0 + 1, 0) : new Date(y, m0 + 1, d - 1);
  endEl.value = toISODateLocal(endDate);

  previewEl.innerHTML = d === 1
    ? `Periode: <strong>${fmtDate(startVal)} – ${fmtDate(endEl.value)}</strong> (kalender biasa, tiap bulan).`
    : `Periode berjalan: <strong>${fmtDate(startVal)} – ${fmtDate(endEl.value)}</strong>. Aturan ini berulang tiap bulan (tanggal ${d} s/d ${d - 1} bulan berikutnya).`;
}

// Periode mana (dalam format "YYYY-MM", dilabeli bulan AKHIR-nya, sesuai
// payrollPeriodRange) yang sedang aktif hari ini untuk tanggal cut-off
// tertentu — dipakai untuk nampilkan tanggal mulai periode berjalan
// lengkap dengan bulan & tahunnya saat halaman ini dibuka.
function currentActivePeriod(cutoffD) {
  const now = new Date();
  const y = now.getFullYear();
  const m0 = now.getMonth(); // 0-indexed
  const d = now.getDate();
  const labelDate = cutoffD <= 1 || d < cutoffD ? new Date(y, m0, 1) : new Date(y, m0 + 1, 1);
  return `${labelDate.getFullYear()}-${String(labelDate.getMonth() + 1).padStart(2, "0")}`;
}

async function onSubmitCutoff(e, user) {
  e.preventDefault();
  const startVal = document.getElementById("cutoff-start").value;
  if (!startVal) { toast("Isi tanggal mulai dulu", "error"); return; }
  const day = Number(startVal.split("-")[2]);
  if (!day || day < 1 || day > 28) { toast("Tanggal mulai harus 1 - 28 supaya konsisten walau di bulan Februari", "error"); return; }

  const { error } = await supabase
    .from("payroll_settings")
    .update({ cutoff_start_day: day, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  invalidatePayrollSettingsCache();
  toast("Periode cut-off slip gaji tersimpan", "success");
}
