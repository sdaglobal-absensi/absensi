import { supabase } from "../supabaseClient.js";
import { toast, invalidatePermissionCache, invalidatePayrollSettingsCache, payrollPeriodRange, fmtDate } from "../core.js";
import { ICON_SEARCH } from "../approvalUI.js";

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
  "struktur-organisasi": "Struktur Organisasi (Lihat Pohon Unit & Anggota)",
  "struktur-kelola": "Struktur Organisasi — Boleh Mengubah (Unit, Anggota, Tingkat Approval)",
  "absensi-monitor": "Monitor Absensi",
  "izin-approval": "Approval Izin",
  "lembur-approval": "Approval Lembur",
  "koreksi-approval": "Approval Koreksi Absen",
  "profil-approval": "Approval Perubahan Data",
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
  "kuota-cuti": "Kuota Cuti Tahunan (Kuota per Karyawan & Master Cuti Khusus)",
  "pengaturan-sistem": "Pengaturan Sistem (Kelola Akses & Cut-Off Gaji)",
};

// Catatan kecil di bawah nama menu (opsional) — untuk hal yang perlu diketahui
// sebelum menyalakan menu itu.
const MENU_HINTS = {
  "profil-approval": "Menyetujui akan menimpa data di Data Karyawan, jadi menu Data Karyawan perlu ikut diizinkan untuk role yang sama.",
};

// Menu pribadi (absensi/izin/lembur/riwayat sendiri).
const PERSONAL_MENU_LABELS = {
  "absensi": "Absensi (Check-in/Check-out Pribadi)",
  "izin": "Pengajuan Izin Pribadi",
  "lembur": "Pengajuan Lembur Pribadi",
  "koreksi": "Pengajuan Koreksi Absen Pribadi",
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
const ROLES = ["super_admin_hr", "admin_hr", "admin_approval", "karyawan"];
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
      <strong>Admin HR</strong>, <strong>Admin</strong>, dan <strong>Karyawan</strong> — keempat toggle di setiap baris
      independen satu sama lain, jadi mematikan sebuah menu untuk satu role tidak memengaruhi role
      lainnya. Ketiganya diperlakukan sama persis, termasuk Super Admin HR — tidak ada lagi akses
      otomatis, semua diatur manual lewat tabel ini. Super Admin sendiri tidak ada di tabel ini:
      akses Super Admin selalu penuh dan tidak bisa dibatasi lewat toggle apapun. Menu yang
      dimatikan otomatis hilang dari sidebar, dan aksesnya tetap ditolak di sisi server walau
      dicoba lewat cara lain.
      <br><br>
      <strong>Admin</strong> adalah role admin yang aksesnya diatur penuh di sini: default-nya hanya
      menu pribadi + <em>Approval Izin</em> &amp; <em>Approval Lembur</em> yang menyala, menu lain
      tinggal dinyalakan sesuai kebutuhan. Role ini tidak dianggap staff HR, jadi tidak otomatis
      bisa membaca data karyawan lain atau mengatur role orang.
      <br><br>
      <strong>Catatan soal baris "Pengaturan Sistem":</strong> menu ini adalah halaman yang sedang
      kamu buka sekarang. Menyalakannya untuk sebuah role berarti role itu ikut bisa membuka
      halaman ini — termasuk mengubah tabel Kelola Akses (punya role lain, maupun punya dirinya
      sendiri) dan Periode Cut-Off Slip Gaji. Nyalakan hanya kalau memang mau didelegasikan
      sebagai admin cadangan (biasanya cukup untuk Super Admin HR saja).
    </p>
    <div class="ap-toolbar perm-toolbar">
      <div class="ap-tools">
        <div class="ap-search">
          ${ICON_SEARCH}
          <input type="search" id="perm-search" placeholder="Cari menu…" autocomplete="off" aria-label="Cari menu">
        </div>
        <select id="perm-sort" class="ap-sort" aria-label="Urutkan menu">
          <option value="default">Urutan bawaan</option>
          <option value="az">Menu A–Z</option>
          <option value="za">Menu Z–A</option>
        </select>
      </div>
      <span class="ap-meta" id="perm-meta"></span>
    </div>
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

    <h3 style="margin-bottom:10px; margin-top:32px;">Notifikasi Push Absensi</h3>
    <p class="muted small" style="margin-top:-6px; margin-bottom:14px;">
      Saklar global untuk SEMUA pengingat push absensi (sebelum/sesudah jam masuk & pulang).
      Kalau dimatikan, tidak ada notifikasi yang dikirim ke siapapun sampai dinyalakan lagi.
      <br><br>
      <strong>Catatan penting:</strong> saklar ini cuma mengatur pengiriman dari server —
      bukan pengganti izin notifikasi di HP masing-masing karyawan. Setiap karyawan tetap
      harus klik "Aktifkan Pengingat" satu kali di halaman Absensi miliknya sendiri supaya
      browser/HP-nya mengizinkan notifikasi masuk. Ini aturan keamanan browser yang berlaku di
      semua website — tidak ada cara bagi Super Admin untuk mengaktifkan izin itu dari sini
      atas nama karyawan lain.
    </p>
    <label style="display:flex; align-items:center; gap:10px; max-width:420px;">
      <input type="checkbox" id="push-reminders-toggle" style="width:18px; height:18px;">
      <span id="push-reminders-label">Memuat…</span>
    </label>
  `;

  document.getElementById("cutoff-start").addEventListener("input", updateCutoffPreview);
  document.getElementById("form-cutoff").addEventListener("submit", e => onSubmitCutoff(e, user));

  document.getElementById("push-reminders-toggle").addEventListener("change", e => onTogglePushReminders(e, user));

  await loadPermissions(user);
  await loadCutoff();
  await loadPushReminders();
}

// -----------------------------------------------------------------------
// Satu tabel, satu query, satu kolom checkbox per role (Super Admin HR, Admin
// HR, Admin, Karyawan) di setiap baris menu. role_permissions satu baris per
// (role, menu_id), jadi toggle tiap role disimpan & diubah independen walau
// menu_id-nya sama. Pencarian & urutan A–Z cuma memengaruhi tampilan (di
// browser); status toggle tetap disimpan di permState.
const permState = { enabledMap: {}, q: "", sort: "default", user: null };

const normText = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function loadPermissions(user) {
  const el = document.getElementById("perm-list");
  const { data, error } = await supabase.from("role_permissions").select("*");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  // enabledMap["admin_hr:absensi"] = true/false, dst — gampang dicari per baris/kolom.
  permState.enabledMap = {};
  (data || []).forEach(r => { permState.enabledMap[`${r.role}:${r.menu_id}`] = r.enabled; });
  permState.user = user;

  const search = document.getElementById("perm-search");
  const sort = document.getElementById("perm-sort");
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { permState.q = search.value; paintPermissions(); }, 120);
  });
  sort.addEventListener("change", () => { permState.sort = sort.value; paintPermissions(); });

  paintPermissions();
}

function paintPermissions() {
  const el = document.getElementById("perm-list");
  const meta = document.getElementById("perm-meta");
  const { enabledMap, user } = permState;

  const tokens = normText(permState.q).split(/\s+/).filter(Boolean);
  let rows = tokens.length
    ? ALL_MENU_ROWS.filter(r => { const hay = normText(r.label + " " + (MENU_HINTS[r.id] || "")); return tokens.every(t => hay.includes(t)); })
    : ALL_MENU_ROWS.slice();
  if (permState.sort === "az") rows.sort((a, b) => a.label.localeCompare(b.label, "id", { sensitivity: "base" }));
  if (permState.sort === "za") rows.sort((a, b) => b.label.localeCompare(a.label, "id", { sensitivity: "base" }));

  meta.textContent = tokens.length ? `Menampilkan ${rows.length} dari ${ALL_MENU_ROWS.length} menu` : `${ALL_MENU_ROWS.length} menu`;

  if (!rows.length) {
    el.innerHTML = `<p class="muted" style="padding:20px;">Tidak ada menu yang cocok dengan “${escapeHtml(permState.q.trim())}”.</p>`;
    return;
  }

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
      <thead><tr><th>Menu</th><th>Akses Super Admin HR</th><th>Akses Admin HR</th><th>Akses Admin</th><th>Akses Karyawan</th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${row.label}${MENU_HINTS[row.id] ? `<div class="small muted perm-hint">${MENU_HINTS[row.id]}</div>` : ""}</td>
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function roleDisplayName(role) {
  return {
    super_admin: "Super Admin",
    super_admin_hr: "Super Admin HR",
    admin_hr: "Admin HR",
    admin_approval: "Admin",
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

  permState.enabledMap[`${role}:${menuId}`] = enabled;
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
    previewEl.innerHTML = `<span class="text-danger">Pilih tanggal 1 - 28 saja supaya aturannya tetap konsisten walau di bulan Februari.</span>`;
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

// -----------------------------------------------------------------------
// Saklar global notifikasi push absensi (tabel push_settings, satu baris).
// Dicek langsung oleh Edge Function checkout-reminder tiap kali jalan --
// lihat komentar di supabase/functions/checkout-reminder/index.ts.
// -----------------------------------------------------------------------
function setPushReminderLabel(enabled) {
  document.getElementById("push-reminders-label").textContent =
    enabled ? "Aktif — pengingat push dikirim seperti biasa" : "Nonaktif — tidak ada pengingat push yang dikirim ke siapapun";
}

async function loadPushReminders() {
  const { data, error } = await supabase.from("push_settings").select("reminders_enabled").eq("id", 1).maybeSingle();
  const enabled = !error && data ? data.reminders_enabled !== false : true;
  document.getElementById("push-reminders-toggle").checked = enabled;
  setPushReminderLabel(enabled);
}

async function onTogglePushReminders(e, user) {
  const enabled = e.target.checked;
  setPushReminderLabel(enabled); // update label dulu biar responsif, dikoreksi lagi kalau gagal simpan

  const { error } = await supabase
    .from("push_settings")
    .update({ reminders_enabled: enabled, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    e.target.checked = !enabled; // rollback tampilan
    setPushReminderLabel(!enabled);
    toast("Gagal menyimpan: " + error.message, "error");
    return;
  }

  toast(enabled ? "Notifikasi push absensi diaktifkan untuk semua karyawan" : "Notifikasi push absensi dimatikan untuk semua karyawan", "success");
}
