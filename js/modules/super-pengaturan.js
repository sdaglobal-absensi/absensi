import { supabase } from "../supabaseClient.js";
import { toast, invalidatePermissionCache, invalidatePayrollSettingsCache, payrollPeriodRange, fmtDate } from "../core.js";

// =======================================================================
// PENGATURAN SISTEM — dibuka default oleh Super Admin (satu-satunya role
// "root"), tapi sekarang BISA didelegasikan ke Super Admin HR (opsional,
// lewat baris "Pengaturan Sistem" di tabel Kelola Akses Menu di bawah —
// defaultnya tetap mati untuk semua role selain Super Admin):
//   1. Kelola Akses Menu — satu tabel, nyalakan/matikan menu mana saja yang
//      boleh dibuka role Super Admin HR, Admin HR, dan/atau Karyawan (tiga
//      kolom checkbox per baris, tersimpan independen di tabel
//      role_permissions sebagai baris terpisah per (role, menu_id)). Ketiga
//      role ini diperlakukan SAMA PERSIS — Super Admin HR tidak istimewa,
//      akses-nya sepenuhnya manual lewat tabel ini juga — TERMASUK akses ke
//      halaman "Pengaturan Sistem" ini sendiri, yang sekarang ikut jadi satu
//      baris yang bisa ditoggle (lihat MENU_LABELS di bawah). Kalau
//      dinyalakan untuk Super Admin HR, dia ikut bisa membuka & mengubah
//      tabel ini (termasuk akses role lain, dan akses dirinya sendiri) serta
//      Periode Cut-Off Slip Gaji — jadi nyalakan hanya kalau memang mau
//      didelegasikan penuh sebagai admin cadangan.
//   2. Periode Cut-Off Slip Gaji — atur tanggal mulai periode gajian kalau
//      perusahaan pakai cut-off (mis. tgl 26 - 25), bukan kalender biasa.
// RLS di Supabase tetap jadi penjaga utama (bukan cuma sembunyi menu di
// sidebar) — jadi walau ada yang coba akses langsung lewat API, Super Admin
// HR, Admin HR, maupun Karyawan tetap tertahan di menu yang belum diizinkan.
// Super Admin sendiri tidak pernah bisa ditolak RLS (bypass mutlak) — jadi
// walau "Pengaturan Sistem" didelegasikan lalu suatu saat mau ditarik lagi,
// Super Admin selalu tetap bisa membuka halaman ini untuk mematikannya.
// =======================================================================

// Menu staff (approval, laporan, master data, dst). "pengaturan-sistem"
// sengaja ikut dimasukkan di sini (bukan lagi dikecualikan) supaya baris
// "Pengaturan Sistem" muncul juga di tabel Kelola Akses Menu — datanya
// tersimpan seperti menu lain, satu baris per (role, "pengaturan-sistem")
// di role_permissions, dan defaultnya TIDAK ada baris = dianggap mati.
const MENU_LABELS = {
  "karyawan": "Data Karyawan",
  "struktur-organisasi": "Struktur Organisasi (Lihat Cabang & Departemen)",
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
  "pengaturan-sistem": "Pengaturan Sistem (Kelola Akses & Cut-Off Gaji)",
};

// Menu pribadi (absensi/izin/lembur/riwayat sendiri).
const PERSONAL_MENU_LABELS = {
  "absensi": "Absensi (Check-in/Check-out Pribadi)",
  "izin": "Pengajuan Izin Pribadi",
  "lembur": "Pengajuan Lembur Pribadi",
  "riwayat": "Riwayat Absensi Pribadi",
  "slip-gaji-saya": "Slip Gaji Saya (Lihat & Cetak Punya Sendiri)",
};

// Tiga role bisa disetel manual di sini, baris per baris, independen satu
// sama lain: Super Admin HR & Admin HR (defaultnya menu yang relevan buat
// kerjaan HR menyala, data sensitif mati dulu) dan Karyawan (defaultnya cuma
// menu pribadi yang menyala, menu staff mati, tinggal dinyalakan kalau
// memang mau dibuka). Super Admin sendiri TIDAK ada kolomnya di sini — akses
// Super Admin selalu penuh & tidak bisa dibatasi lewat toggle apapun (satu-
// satunya role yang benar-benar bypass RLS). "pengaturan-sistem" (halaman
// ini sendiri) SEKARANG ikut ada di daftar menu (lewat MENU_LABELS di atas)
// supaya bisa didelegasikan ke Super Admin HR (atau, kalau memang mau,
// Admin HR/Karyawan juga) — defaultnya tetap mati sampai sengaja dinyalakan
// oleh Super Admin.
const ROLES = ["super_admin_hr", "admin_hr", "karyawan"];
const ALL_MENU_ROWS = [
  ...Object.keys(PERSONAL_MENU_LABELS).map(id => ({ id, label: PERSONAL_MENU_LABELS[id] })),
  ...Object.keys(MENU_LABELS).map(id => ({ id, label: MENU_LABELS[id] })),
];

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Pengaturan Sistem</h1>
        <p class="muted">Halaman ini cuma bisa dibuka Super Admin.</p>
      </div>
    </div>

    <h3 style="margin-bottom:10px;">Kelola Akses Menu</h3>
    <p class="muted small" style="margin-top:-6px; margin-bottom:14px;">
      Nyalakan/matikan menu apa saja untuk role <strong>Super Admin HR</strong>,
      <strong>Admin HR</strong>, dan <strong>Karyawan</strong> — ketiga toggle di setiap baris
      independen satu sama lain, jadi mematikan sebuah menu untuk satu role tidak memengaruhi role
      lainnya. Ketiganya diperlakukan sama persis, termasuk Super Admin HR — tidak ada lagi akses
      otomatis, semua diatur manual lewat tabel ini. Super Admin sendiri tidak ada di tabel ini:
      akses Super Admin selalu penuh dan tidak bisa dibatasi lewat toggle apapun. Menu yang
      dimatikan otomatis hilang dari sidebar, dan aksesnya tetap ditolak di sisi server walau
      dicoba lewat cara lain.
      <br><br>
      <strong>Catatan soal baris "Pengaturan Sistem":</strong> menu ini adalah halaman yang sedang
      kamu buka sekarang. Menyalakannya untuk sebuah role berarti role itu ikut bisa membuka
      halaman ini — termasuk mengubah tabel Kelola Akses (punya role lain, maupun punya dirinya
      sendiri) dan Periode Cut-Off Slip Gaji. Nyalakan hanya kalau memang mau didelegasikan
      sebagai admin cadangan (biasanya cukup untuk Super Admin HR saja).
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
// Satu tabel, satu query, dua kolom checkbox (Admin HR & Karyawan) per
// baris menu. role_permissions sekarang satu baris per (role, menu_id),
// jadi toggle Admin HR & Karyawan disimpan & diubah independen walau
// menu_id-nya sama.
async function loadPermissions(user) {
  const el = document.getElementById("perm-list");
  const { data, error } = await supabase.from("role_permissions").select("*");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  // enabledMap["admin_hr:absensi"] = true/false, dst — gampang dicari per baris/kolom.
  const enabledMap = {};
  (data || []).forEach(r => { enabledMap[`${r.role}:${r.menu_id}`] = r.enabled; });

  const cell = (row, role) => {
    const enabled = !!enabledMap[`${role}:${row.id}`];
    return `
      <td>
        <label class="checkbox-row">
          <input type="checkbox" class="perm-toggle" data-role="${role}" data-menu="${row.id}" ${enabled ? "checked" : ""}>
          <span>${enabled ? "Diizinkan" : "Tidak diizinkan"}</span>
        </label>
      </td>
    `;
  };

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Menu</th><th>Akses Super Admin HR</th><th>Akses Admin HR</th><th>Akses Karyawan</th></tr></thead>
      <tbody>
        ${ALL_MENU_ROWS.map(row => `
          <tr>
            <td>${row.label}</td>
            ${ROLES.map(role => cell(row, role)).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".perm-toggle").forEach(cb => {
    cb.addEventListener("change", () => onTogglePermission(cb, user));
  });
}

function roleDisplayName(role) {
  return {
    super_admin: "Super Admin",
    super_admin_hr: "Super Admin HR",
    admin_hr: "Admin HR",
    karyawan: "Karyawan",
  }[role] || role;
}

function menuLabel(menuId) {
  return PERSONAL_MENU_LABELS[menuId] || MENU_LABELS[menuId] || menuId;
}

async function onTogglePermission(checkbox, user) {
  const role = checkbox.dataset.role;
  const menuId = checkbox.dataset.menu;
  const enabled = checkbox.checked;
  checkbox.disabled = true;

  const { error } = await supabase
    .from("role_permissions")
    .upsert(
      { role, menu_id: menuId, enabled, updated_by: user.id, updated_at: new Date().toISOString() },
      { onConflict: "role,menu_id" }
    );

  checkbox.disabled = false;
  if (error) {
    toast("Gagal menyimpan: " + error.message, "error");
    checkbox.checked = !enabled; // revert tampilan kalau gagal
    return;
  }

  checkbox.closest("label").querySelector("span").textContent = enabled ? "Diizinkan" : "Tidak diizinkan";
  invalidatePermissionCache();
  toast(`Akses "${menuLabel(menuId)}" untuk ${roleDisplayName(role)} ${enabled ? "diaktifkan" : "dimatikan"}`, "success");
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
