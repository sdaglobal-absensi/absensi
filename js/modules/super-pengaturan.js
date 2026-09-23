import { supabase } from "../supabaseClient.js";
import { toast, invalidatePermissionCache, invalidatePayrollSettingsCache } from "../core.js";

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
      Berlaku global untuk semua karyawan. Isi <strong>1</strong> kalau periode gajian mengikuti
      kalender biasa (tanggal 1 s/d akhir bulan). Isi tanggal lain (mis. <strong>26</strong>) kalau
      perusahaan pakai cut-off, misalnya periode berjalan dari tanggal 26 bulan sebelumnya sampai
      tanggal 25 bulan yang dipilih di Slip Gaji.
    </p>
    <form id="form-cutoff" class="form-row two-col" style="align-items:end; max-width:520px;">
      <label>Tanggal Mulai Periode (Cut-Off)
        <input type="number" name="cutoff_start_day" min="1" max="28" required>
      </label>
      <button type="submit" class="btn-primary">Simpan</button>
    </form>
  `;

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
async function loadCutoff() {
  const { data, error } = await supabase.from("payroll_settings").select("cutoff_start_day").eq("id", 1).single();
  const form = document.getElementById("form-cutoff");
  form.cutoff_start_day.value = error || !data ? 1 : (data.cutoff_start_day || 1);
}

async function onSubmitCutoff(e, user) {
  e.preventDefault();
  const day = Number(new FormData(e.target).get("cutoff_start_day"));
  if (!day || day < 1 || day > 28) { toast("Tanggal harus antara 1 - 28", "error"); return; }

  const { error } = await supabase
    .from("payroll_settings")
    .update({ cutoff_start_day: day, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  invalidatePayrollSettingsCache();
  toast("Periode cut-off slip gaji tersimpan", "success");
}
