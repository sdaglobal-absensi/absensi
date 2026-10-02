import { supabase } from "../supabaseClient.js";
import { createEmployeeAccount, resetEmployeePin, inviteText, callFunction } from "../accountApi.js";
import { esc } from "../approvalHelper.js";
import { toast, roleLabel, jenisHubunganKerjaLabel, searchSelectHtml, wireSearchSelect, lamaBekerja, isSuper, avatarHTML } from "../core.js";
import { downloadKaryawanTemplate, exportKaryawan, importKaryawanFile } from "./karyawan-excel.js";
import { hasXLSX, pickFileThen } from "../excelIO.js";
import {
  personalFieldsHtml, familySectionHtml, wireFamilyForm, fillBiodataForm,
  readBiodataForm, readChildren, loadChildren, saveChildren, fmtTanggal,
} from "../biodata.js";

let masterDepartments = [];
let masterLevels = [];
let masterLocations = [];
let masterPts = []; // Master PT / Vendor (tabel master_pt)
let ssDepartemen, ssBagian, ssJabatan, ssGrade, ssLokasi, ssUnitPt;
// Izin user yang sedang login, dipakai lagi di openModal() waktu membangun
// pilihan Role untuk baris yang sedang diedit.
// ID anak yang sudah tersimpan untuk karyawan yang sedang dibuka di modal —
// dipakai saat simpan untuk tahu anak mana yang dihapus dari form.
let originalChildIds = [];

export async function render(container, user) {
  // Siapa pun yang sampai ke halaman ini sudah lolos guard menu "karyawan"
  // (super_admin/super_admin_hr selalu, admin_hr cuma kalau diizinkan lewat
  // Pengaturan Sistem) — jadi semua yang bisa membuka halaman ini boleh edit.
  const canEdit = true;
  // Role TIDAK diatur dari halaman ini: akun baru selalu dibuat sebagai Karyawan,
  // dan role diubah lewat Struktur Organisasi (tombol Ubah Role) supaya yang
  // hanya punya akses Data Karyawan tidak salah memberi role. RLS di server
  // juga menolak perubahan role lewat tabel profiles kecuali oleh Super Admin.
  const isFullSuperAdmin = isSuper(user.role);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Data Karyawan</h1>
        <p class="muted">Kelola data kepegawaian, penempatan, dan status karyawan.</p>
        <p class="small muted" id="kode-usaha-info"></p>
      </div>
      ${canEdit ? `
      <div class="filter-row pg-head-actions">
        <input type="file" id="import-file" accept=".xlsx,.xls" class="hidden">
        <button id="btn-template" class="btn-secondary">Download Template</button>
        <button id="btn-import" class="btn-secondary">Import Excel</button>
        <button id="btn-export" class="btn-secondary">Export Excel</button>
        <button id="btn-new" class="btn-primary">+ Tambah Karyawan</button>
      </div>` : ""}
    </div>
    <div class="ap-toolbar kr-toolbar">
      <div class="ap-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="search" id="kr-search" placeholder="Cari nama, kode, atau email…" autocomplete="off" aria-label="Cari karyawan">
      </div>
      <div class="ap-tools">
        <select id="kr-filter-jenis" class="ap-sort" aria-label="Filter hubungan kerja">
          <option value="">Semua Hubungan Kerja</option>
          <option value="karyawan_tetap">Karyawan Tetap</option>
          <option value="pkwt">PKWT</option>
          <option value="outsourcing">Outsourcing</option>
        </select>
        <select id="kr-filter-status" class="ap-sort" aria-label="Filter status">
          <option value="">Semua Status</option>
          <option value="aktif">Aktif</option>
          <option value="nonaktif">Nonaktif</option>
        </select>
      </div>
    </div>
    <div class="ap-meta" id="kr-meta"></div>
    <div id="karyawan-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-karyawan" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <div style="position:sticky; top:-24px; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:12px; margin:-24px -24px 12px; padding:18px 24px 12px; background:var(--surface); border-bottom:1px solid var(--border);">
          <h3 id="modal-title" style="margin:0;">Tambah Karyawan</h3>
          <button type="button" id="btn-close-x" aria-label="Tutup" title="Tutup" style="flex-shrink:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; border:1px solid var(--border); border-radius:50%; background:var(--surface); color:var(--ink); font-size:1.4rem; line-height:1; cursor:pointer;">&times;</button>
        </div>
        <form id="form-karyawan">
          <input type="hidden" name="id">
          <input type="hidden" name="grade">
          <input type="hidden" name="level">

          <div class="form-section-label">Data Akun</div>
          <div class="form-row two-col">
            <label>Kode Karyawan <input name="employee_code" required></label>
            <label>Role
              <input id="role-display" value="Karyawan" disabled>
              <div id="role-hint" class="small muted">Diatur lewat Struktur Organisasi → Ubah Role.</div>
            </label>
          </div>
          <div class="form-row" id="logintype-row">
            <label>Cara Login
              <select name="login_type" id="login_type">
                <option value="email">Email + password</option>
                <option value="pin">Tanpa email — kode usaha + kode karyawan + PIN</option>
              </select>
            </label>
          </div>
          <div class="form-row two-col" id="email-row">
            <label id="email-label">Email <input type="email" name="email" required></label>
            <label id="password-label">Password Awal <input type="text" name="password" placeholder="min. 6 karakter"></label>
          </div>
          <div class="form-row two-col hidden" id="pin-row">
            <label>PIN Awal (6 digit) <input name="pin" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="kosongkan = dibuat otomatis"></label>
            <label class="small muted" style="align-self:end; padding-bottom:10px;">Untuk karyawan yang tidak punya email. Karyawan masuk lewat tab "Kode Karyawan".</label>
          </div>
          <div class="form-row two-col hidden" id="email-readonly-row">
            <label>Email <input type="email" id="email-readonly" disabled></label>
            <label class="small muted" style="align-self:end; padding-bottom:10px;">Karyawan lupa email? Ini alamat yang terdaftar untuk akun ini.</label>
          </div>
          <div class="hidden" id="email-convert-wrap" style="margin-bottom:16px;">
            <button type="button" class="btn-link" id="btn-show-convert-pin">Ganti ke login PIN (tanpa email)</button>
            <div class="hidden" id="convert-pin-box" style="margin-top:12px; padding:14px; border:1px solid var(--border); border-radius:var(--radius);">
              <div class="form-row two-col">
                <label>PIN Baru (6 digit) <input id="conv-pin" inputmode="numeric" maxlength="6" placeholder="kosongkan = dibuat otomatis" autocomplete="off"></label>
                <label class="small muted" style="align-self:end; padding-bottom:10px;">Karyawan masuk lewat tab "Kode Karyawan" memakai kode usaha + kode karyawan + PIN.</label>
              </div>
              <p class="small muted" style="margin:0 0 10px;">Email dan password lama tidak berlaku lagi, dan fitur "Lupa password?" tidak bisa dipakai untuk akun ini.</p>
              <div class="modal-actions">
                <button type="button" class="btn-secondary" id="btn-cancel-convert-pin">Batal</button>
                <button type="button" class="btn-primary" id="btn-do-convert-pin">Ubah ke Login PIN</button>
              </div>
            </div>
          </div>
          <div class="form-row two-col hidden" id="pin-manage-row" style="align-items:end;">
            <label>Cara Login <input value="Kode usaha + kode karyawan + PIN" disabled style="height:44px; box-sizing:border-box;"></label>
            <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:16px;">
              <span style="font-size:0.85rem;">&nbsp;</span>
              <button type="button" class="btn-secondary" id="btn-reset-pin" style="height:44px; box-sizing:border-box;">Reset PIN</button>
            </div>
          </div>
          <div class="hidden" id="pin-convert-wrap" style="margin-bottom:16px;">
            <button type="button" class="btn-link" id="btn-show-convert">Ganti ke login Email + Password</button>
            <div class="hidden" id="convert-box" style="margin-top:12px; padding:14px; border:1px solid var(--border); border-radius:var(--radius);">
              <div class="form-row two-col">
                <label>Email <input type="email" id="conv-email" placeholder="nama@email.com" autocomplete="off"></label>
                <label>Password Baru <input type="text" id="conv-password" placeholder="min. 6 karakter" autocomplete="off"></label>
              </div>
              <p class="small muted" style="margin:0 0 10px;">Setelah diubah, karyawan masuk lewat tab "Email" dan PIN lama tidak berlaku lagi.</p>
              <div class="modal-actions">
                <button type="button" class="btn-secondary" id="btn-cancel-convert">Batal</button>
                <button type="button" class="btn-primary" id="btn-do-convert">Ubah ke Email + Password</button>
              </div>
            </div>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Akun aktif</label>
          </div>

          <div class="form-section-label">Data Pribadi</div>
          <div class="form-row two-col">
            <label>Nama Lengkap <input name="full_name" required></label>
            <label>NIK KTP <input name="nik_ktp" inputmode="numeric" maxlength="16"></label>
          </div>
          <div class="form-row two-col">
            <label>No. HP <input name="phone"></label>
            <label>NPWP <input name="npwp"></label>
          </div>
          <div class="form-row">
            <label>Alamat Sesuai KTP <input name="alamat_ktp" placeholder="Alamat sesuai yang tertera di KTP"></label>
          </div>
          <div class="form-row">
            <label>Alamat Domisili <input name="alamat" placeholder="Alamat tempat tinggal saat ini"></label>
          </div>
          ${personalFieldsHtml({ includeIdentity: true })}

          ${familySectionHtml()}

          <div class="form-section-label">Penempatan</div>
          <div class="form-row three-col">
            <label>Jenis Hubungan Kerja
              <select name="jenis_hubungan_kerja" id="jenis_hubungan_kerja">
                <option value="karyawan_tetap">Karyawan Tetap</option>
                <option value="pkwt">PKWT</option>
                <option value="outsourcing">Outsourcing</option>
              </select>
            </label>
            ${searchSelectHtml({ id: "ss-unit-pt", label: "Unit / PT", placeholder: "Pilih PT / vendor…" })}
            ${searchSelectHtml({ id: "ss-lokasi", label: "Lokasi Kerja / Area", placeholder: "Cari lokasi kerja…" })}
          </div>
          <p class="small field-hint hidden" id="outsourcing-hint">Pilih <b>Unit / PT</b> dari daftar vendor outsourcing. Vendor belum ada? Tambahkan dulu di menu Master PT / Vendor.</p>
          <div class="form-row two-col">
            ${searchSelectHtml({ id: "ss-departemen", label: "Departemen", placeholder: "Cari departemen…" })}
            ${searchSelectHtml({ id: "ss-bagian", label: "Bagian", placeholder: "Pilih departemen dulu…" })}
          </div>
          <div class="form-row two-col">
            ${searchSelectHtml({ id: "ss-jabatan", label: "Jabatan", placeholder: "Pilih bagian dulu…" })}
            ${searchSelectHtml({ id: "ss-grade", label: "Grade", placeholder: "Cari grade/level…" })}
          </div>

          <div class="form-section-label">Kepegawaian</div>
          <div class="form-row three-col">
            <label>Status Karyawan
              <select name="status_karyawan">
                <option value="bulanan">Bulanan</option>
                <option value="harian">Harian</option>
              </select>
            </label>
            <label>Tanggal Masuk <input type="date" name="join_date" id="join_date"></label>
            <label>Lama Bekerja <input type="text" id="lama_bekerja" disabled placeholder="-"></label>
          </div>
          <div class="form-row two-col">
            <label>Tanggal Resign <input type="date" name="resign_date" id="resign_date"></label>
            <label class="small muted" style="align-self:end; padding-bottom:10px;">Kosongkan kalau karyawan masih bekerja.</label>
          </div>
          <p class="small field-hint hidden" id="resign-hint" style="color:var(--warn);">Tanggal resign sudah diisi, tapi akun masih aktif. Hilangkan centang "Akun aktif" di atas kalau karyawan sudah tidak bekerja.</p>

          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
    ` : ""}
  `;

  // Pencarian & filter daftar (dipasang tiap halaman dirender ulang, karena
  // elemennya ikut dibuat ulang bersama container.innerHTML di atas).
  karyawanRows = [];
  {
    let timer;
    document.getElementById("kr-search").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(renderKaryawanTable, 120); });
    document.getElementById("kr-filter-jenis").addEventListener("change", renderKaryawanTable);
    document.getElementById("kr-filter-status").addEventListener("change", renderKaryawanTable);
  }

  if (canEdit) {
    await loadMasterData();
    setupSearchSelects();

    document.getElementById("btn-new").addEventListener("click", () => openModal());
    const excelCtx = () => ({
      masterPts, masterLocations, masterDepartments, masterLevels,
      existingRows: karyawanRows,
      onDone: () => loadTable(true, isFullSuperAdmin),
    });
    document.getElementById("btn-template").addEventListener("click", () => downloadKaryawanTemplate(excelCtx()));
    document.getElementById("btn-export").addEventListener("click", () => exportKaryawan(getFilteredKaryawan()));
    document.getElementById("btn-import").addEventListener("click", () => {
      if (!hasXLSX()) { toast("Library Excel belum termuat, coba refresh halaman.", "error"); return; }
      document.getElementById("import-file").click();
    });
    pickFileThen(document.getElementById("import-file"), file => importKaryawanFile(file, excelCtx()));
    document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
    showKodeUsaha(user);
    document.getElementById("form-karyawan").addEventListener("submit", e => onSubmit(e, user, isFullSuperAdmin));
    document.getElementById("login_type").addEventListener("change", refreshLoginType);
    document.getElementById("btn-reset-pin").addEventListener("click", () => onResetPin(user));
    document.getElementById("btn-close-x").addEventListener("click", closeModal);
    document.getElementById("btn-show-convert").addEventListener("click", () => {
      document.getElementById("convert-box").classList.toggle("hidden");
    });
    document.getElementById("btn-cancel-convert").addEventListener("click", () => {
      document.getElementById("convert-box").classList.add("hidden");
    });
    document.getElementById("btn-do-convert").addEventListener("click", () => onConvertToEmail(user, isFullSuperAdmin));
    document.getElementById("btn-show-convert-pin").addEventListener("click", () => {
      document.getElementById("convert-pin-box").classList.toggle("hidden");
    });
    document.getElementById("btn-cancel-convert-pin").addEventListener("click", () => {
      document.getElementById("convert-pin-box").classList.add("hidden");
    });
    document.getElementById("btn-do-convert-pin").addEventListener("click", () => onConvertToPin(user, isFullSuperAdmin));
    // Tombol Esc menutup formulir
    document.addEventListener("keydown", ev => {
      if (ev.key !== "Escape") return;
      const m = document.getElementById("modal-karyawan");
      if (m && !m.classList.contains("hidden")) closeModal();
    });
    wireFamilyForm(document.getElementById("form-karyawan"));
    document.getElementById("join_date").addEventListener("input", refreshTenure);
    document.getElementById("resign_date").addEventListener("input", refreshTenure);
    document.querySelector('#form-karyawan input[name="is_active"]').addEventListener("change", refreshTenure);
    document.getElementById("jenis_hubungan_kerja").addEventListener("change", onJenisChange);
  }

  loadTable(canEdit, isFullSuperAdmin);
}

async function loadMasterData() {
  const [{ data: depts }, { data: levels }, { data: locs }, { data: pts }] = await Promise.all([
    supabase.from("departments").select("*").eq("is_active", true),
    supabase.from("job_levels").select("*").eq("is_active", true),
    supabase.from("office_locations").select("*").eq("is_active", true),
    supabase.from("master_pt").select("*").eq("is_active", true).order("nama"),
  ]);
  masterPts = pts || [];
  masterDepartments = depts || [];
  masterLevels = levels || [];
  masterLocations = locs || [];
}

function setupSearchSelects() {
  const uniqueDept = [...new Set(masterDepartments.map(d => d.departemen))];

  ssDepartemen = wireSearchSelect("ss-departemen", uniqueDept, {
    onSelect: dept => {
      const bagianOptions = [...new Set(masterDepartments.filter(d => d.departemen === dept).map(d => d.bagian))];
      ssBagian.setOptions(bagianOptions);
      ssBagian.clear();
      ssJabatan.setOptions([]);
      ssJabatan.clear();
    },
  });

  ssBagian = wireSearchSelect("ss-bagian", [], {
    onSelect: bagian => {
      const dept = ssDepartemen.value;
      const jabatanOptions = [...new Set(
        masterDepartments.filter(d => d.departemen === dept && d.bagian === bagian).map(d => d.jabatan)
      )];
      ssJabatan.setOptions(jabatanOptions);
      ssJabatan.clear();
    },
  });

  ssJabatan = wireSearchSelect("ss-jabatan", []);

  ssGrade = wireSearchSelect("ss-grade", masterLevels, {
    getLabel: o => `${o.grade} — ${o.level}`,
    getValue: o => o.id,
    onSelect: o => {
      document.querySelector('#form-karyawan input[name="grade"]').value = o.grade;
      document.querySelector('#form-karyawan input[name="level"]').value = o.level;
    },
  });

  // Pilihan Unit / PT mengikuti Jenis Hubungan Kerja: Outsourcing -> daftar
  // vendor, selain itu -> daftar PT sendiri (lihat ptOptionsFor()).
  ssUnitPt = wireSearchSelect("ss-unit-pt", ptOptionsFor(document.getElementById("jenis_hubungan_kerja")?.value), {
    getLabel: o => o.nama,
    getValue: o => o.nama,
  });

  ssLokasi = wireSearchSelect("ss-lokasi", masterLocations, {
    getLabel: o => o.name,
    getValue: o => o.name,
  });
}

let karyawanRows = [];
let karyawanCanEdit = false;

async function loadTable(canEdit, isFullSuperAdmin) {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  const el = document.getElementById("karyawan-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  karyawanRows = data || [];
  karyawanCanEdit = canEdit;

  renderKaryawanTable();
}

const normText = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Daftar karyawan sesuai pencarian & filter yang sedang aktif (dipakai tabel dan Export Excel).
function getFilteredKaryawan() {
  const tokens = normText(document.getElementById("kr-search").value).split(/\s+/).filter(Boolean);
  const jenis = document.getElementById("kr-filter-jenis").value;
  const status = document.getElementById("kr-filter-status").value;
  return karyawanRows.filter(k => {
    if (jenis && (k.jenis_hubungan_kerja || "karyawan_tetap") !== jenis) return false;
    if (status && (status === "aktif") !== !!k.is_active) return false;
    if (!tokens.length) return true;
    const hay = normText([k.full_name, k.employee_code, k.email, k.department, k.position].join(" "));
    return tokens.every(t => hay.includes(t));
  });
}

function renderKaryawanTable() {
  const el = document.getElementById("karyawan-table");
  const canEdit = karyawanCanEdit;
  const data = getFilteredKaryawan();

  document.getElementById("kr-meta").textContent = karyawanRows.length
    ? (data.length === karyawanRows.length ? `${karyawanRows.length} karyawan` : `Menampilkan ${data.length} dari ${karyawanRows.length} karyawan`)
    : "";

  if (!data.length) {
    el.innerHTML = `<p class="muted" style="text-align:center;">${karyawanRows.length ? "Tidak ada karyawan yang cocok dengan pencarian/filter." : "Belum ada data karyawan."}</p>`;
    return;
  }

  el.innerHTML = `
    <table class="table kr-table">
      <thead><tr><th>Karyawan</th><th>Kode</th><th>Departemen / Jabatan</th><th>Level</th><th>Hubungan Kerja</th><th>Role</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${data.map(k => {
          const outsourcing = k.jenis_hubungan_kerja === "outsourcing";
          return `
          <tr>
            <td>
              <div class="kr-emp">
                <span class="row-avatar">${avatarHTML(k, k.full_name)}</span>
                <div>
                  <div class="kr-name">${esc(k.full_name)}</div>
                  <div class="kr-sub">${esc(k.login_type === "pin" ? "Login PIN (tanpa email)" : (k.email || "-"))}</div>
                </div>
              </div>
            </td>
            <td>${esc(k.employee_code || "-")}</td>
            <td>
              <div class="kr-name kr-name-plain">${esc(k.position || "-")}</div>
              <div class="kr-sub">${esc(k.department || "-")}</div>
            </td>
            <td>
              ${esc(k.level || "-")}
              ${k.ptkp ? `<div class="kr-sub">PTKP ${esc(k.ptkp)}</div>` : ""}
            </td>
            <td class="kr-wrap">
              <span class="badge ${outsourcing ? "badge-warn" : "badge-ok"}">${jenisHubunganKerjaLabel(k.jenis_hubungan_kerja)}</span>
              ${k.unit_pt ? `<div class="kr-sub">${esc(k.unit_pt)}</div>` : ""}
            </td>
            <td>${roleLabel(k.role)}</td>
            <td>
              <span class="badge badge-${k.is_active ? "ok" : "danger"}">${k.is_active ? "Aktif" : "Nonaktif"}</span>
              ${k.resign_date ? `<div class="kr-sub">Resign ${fmtTanggal(k.resign_date)}</div>` : ""}
            </td>
            ${canEdit ? `<td><button class="btn-link btn-edit" data-id="${k.id}">Edit</button></td>` : ""}
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = karyawanRows.find(k => k.id === btn.dataset.id);
        openModal(row);
      });
    });
  }
}

// Role hanya ditampilkan (read-only). Akun baru selalu Karyawan; untuk mengubah
// role (Admin, Admin HR, dst.) pakai Struktur Organisasi -> Ubah Role.
function renderRoleDisplay(existing) {
  document.getElementById("role-display").value = roleLabel(existing?.role || "karyawan");
}

async function openModal(existing = null) {
  const modal = document.getElementById("modal-karyawan");
  const form = document.getElementById("form-karyawan");

  // Data anak diambil dulu SEBELUM modal dibuka (bukan sesudahnya), supaya
  // admin tidak sempat menekan Simpan selagi daftar anak belum termuat.
  let children = [];
  if (existing) {
    try {
      children = await loadChildren(supabase, existing.id);
    } catch (err) {
      toast("Gagal memuat data anak: " + err.message + " (pastikan supabase-schema.sql terbaru sudah dijalankan)", "error");
      return;
    }
  }
  originalChildIds = children.map(c => c.id);

  form.reset();
  ssDepartemen.clear(); ssBagian.setOptions([]); ssBagian.clear();
  ssJabatan.setOptions([]); ssJabatan.clear(); ssGrade.clear(); ssLokasi.clear(); ssUnitPt.clear();
  document.getElementById("lama_bekerja").value = "";
  renderRoleDisplay(existing);

  document.getElementById("modal-title").textContent = existing ? "Edit Karyawan" : "Tambah Karyawan";
  const isPinAcc = existing?.login_type === "pin";
  document.getElementById("logintype-row").classList.toggle("hidden", !!existing);
  document.getElementById("login_type").value = "email";
  refreshLoginType();
  document.getElementById("email-readonly-row").classList.toggle("hidden", !existing || isPinAcc);
  document.getElementById("pin-manage-row").classList.toggle("hidden", !isPinAcc);
  document.getElementById("pin-convert-wrap").classList.toggle("hidden", !isPinAcc);
  document.getElementById("email-convert-wrap").classList.toggle("hidden", !existing || isPinAcc);
  document.getElementById("convert-pin-box").classList.add("hidden");
  document.getElementById("conv-pin").value = "";
  document.getElementById("convert-box").classList.add("hidden");
  document.getElementById("conv-email").value = "";
  document.getElementById("conv-password").value = "";
  document.getElementById("email-readonly").value = existing?.email || "(tidak diketahui)";
  editingUserId = existing?.id || null;
  if (existing) { document.getElementById("email-row").classList.add("hidden"); form.email.required = false; document.getElementById("pin-row").classList.add("hidden"); }

  if (existing) {
    form.id.value = existing.id;
    form.full_name.value = existing.full_name || "";
    form.employee_code.value = existing.employee_code || "";
    form.is_active.checked = existing.is_active;
    form.jenis_hubungan_kerja.value = existing.jenis_hubungan_kerja || "karyawan_tetap";
    form.status_karyawan.value = existing.status_karyawan || "bulanan";
    form.join_date.value = existing.join_date || "";
    form.resign_date.value = existing.resign_date || "";
    form.phone.value = existing.phone || "";
    form.nik_ktp.value = existing.nik_ktp || "";
    form.npwp.value = existing.npwp || "";
    form.alamat.value = existing.alamat || "";
    form.alamat_ktp.value = existing.alamat_ktp || "";
    form.grade.value = existing.grade || "";
    form.level.value = existing.level || "";

    if (existing.department) {
      ssDepartemen.setValue(existing.department);
      const bagianOptions = [...new Set(masterDepartments.filter(d => d.departemen === existing.department).map(d => d.bagian))];
      ssBagian.setOptions(bagianOptions);
    }
    if (existing.bagian) {
      ssBagian.setValue(existing.bagian);
      const jabatanOptions = [...new Set(
        masterDepartments.filter(d => d.departemen === existing.department && d.bagian === existing.bagian).map(d => d.jabatan)
      )];
      ssJabatan.setOptions(jabatanOptions);
    }
    if (existing.position) ssJabatan.setValue(existing.position);
    if (existing.grade) ssGrade.setValue(existing.grade, `${existing.grade} — ${existing.level || ""}`);
    if (existing.lokasi_kerja) ssLokasi.setValue(existing.lokasi_kerja);
    if (existing.unit_pt) ssUnitPt.setValue(existing.unit_pt); // tetap tampil walau belum ada di Master PT / Vendor
  } else {
    form.id.value = "";
    form.status_karyawan.value = "bulanan";
    form.jenis_hubungan_kerja.value = "karyawan_tetap";
  }
  fillBiodataForm(form, existing || {}, children);
  refreshTenure();
  refreshOutsourcingHint();
  ssUnitPt.setOptions(ptOptionsFor(form.jenis_hubungan_kerja.value)); // tanpa mengosongkan nilai yang sedang dimuat
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-karyawan").classList.add("hidden");
}

async function onSubmit(e, currentUser, isFullSuperAdmin) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = {
    full_name: fd.get("full_name"),
    employee_code: fd.get("employee_code"),
    department: ssDepartemen.value || null,
    bagian: ssBagian.value || null,
    position: ssJabatan.value || null,
    grade: fd.get("grade") || null,
    level: fd.get("level") || null,
    unit_pt: ssUnitPt.value || null,
    jenis_hubungan_kerja: fd.get("jenis_hubungan_kerja") || "karyawan_tetap",
    lokasi_kerja: ssLokasi.value || null,
    status_karyawan: fd.get("status_karyawan"),
    join_date: fd.get("join_date") || null,
    resign_date: fd.get("resign_date") || null,
    phone: fd.get("phone") || null,
    nik_ktp: fd.get("nik_ktp") || null,
    npwp: fd.get("npwp") || null,
    alamat: fd.get("alamat") || null,
    alamat_ktp: fd.get("alamat_ktp") || null,
    ...readBiodataForm(e.target),
    is_active: fd.get("is_active") === "on",
  };
  const children = readChildren(e.target);

  try {
    if (id) {
      const { error } = await supabase.from("profiles").update(payload).eq("id", id);
      if (error) throw error;
      await saveChildrenLabeled(id, children);
      toast("Data karyawan diperbarui", "success");
    } else {
      const loginType = fd.get("login_type") === "pin" ? "pin" : "email";
      const email = loginType === "email" ? String(fd.get("email") || "").trim() : null;
      const password = fd.get("password") || Math.random().toString(36).slice(2, 10);
      // Akun dibuat di server (Edge Function account-admin) supaya otomatis
      // masuk ke usaha admin ini dengan role 'karyawan'. Role diubah lewat
      // Struktur Organisasi (Ubah Role), bukan di sini.
      const created = await createEmployeeAccount({
        employee_code: payload.employee_code, full_name: payload.full_name, login_type: loginType,
        ...(loginType === "email" ? { email, password } : { pin: String(fd.get("pin") || "").trim() }),
      });

      const newUserId = created?.user_id;
      if (!newUserId) {
        throw new Error("Server tidak mengembalikan user_id. Edge Function account-admin yang ter-deploy kemungkinan bukan versi yang benar — deploy ulang.");
      }
      const { error: updErr } = await supabase.from("profiles")
        .update(loginType === "email" ? { ...payload, email } : payload).eq("id", newUserId);
      if (updErr) throw updErr;
      await saveChildrenLabeled(newUserId, children);

      closeModal();
      loadTable(true, isFullSuperAdmin);
      await showCredentials(currentUser, {
        title: "Akun karyawan dibuat",
        namaKaryawan: payload.full_name, kodeKaryawan: payload.employee_code,
        loginType, email,
        secretLabel: loginType === "pin" ? "PIN" : "Password", secret: loginType === "pin" ? created.pin : password,
      });
      return;
    }
    closeModal();
    loadTable(true, isFullSuperAdmin);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}

// Simpan data anak dengan pesan error yang jelas: data karyawan (profiles)
// sudah tersimpan di titik ini, jadi kalau bagian anak yang gagal, admin
// perlu tahu bahwa cuma bagian anak yang belum masuk.
async function saveChildrenLabeled(userId, children) {
  try {
    await saveChildren(supabase, userId, children, originalChildIds);
  } catch (err) {
    throw new Error("Data karyawan sudah tersimpan, tapi data anak gagal disimpan: " + err.message);
  }
}

// Segarkan bagian yang bergantung pada tanggal masuk & tanggal resign:
// "Lama Bekerja" (berhenti di tanggal resign kalau ada), batas minimal
// tanggal resign (tidak boleh sebelum tanggal masuk, sama seperti constraint
// di database), dan peringatan kalau sudah resign tapi akun masih aktif.
function refreshTenure() {
  const join = document.getElementById("join_date").value;
  const resign = document.getElementById("resign_date");
  resign.min = join || "";
  document.getElementById("lama_bekerja").value = lamaBekerja(join, resign.value || null);
  const stillActive = document.querySelector('#form-karyawan input[name="is_active"]').checked;
  document.getElementById("resign-hint").classList.toggle("hidden", !(resign.value && stillActive));
}

// Tampilkan pengingat kalau Jenis Hubungan Kerja diset ke Outsourcing, supaya
// admin ingat mengisi Unit/PT dengan nama PT vendor (bukan PT sendiri).
function refreshOutsourcingHint() {
  const jenis = document.getElementById("jenis_hubungan_kerja").value;
  document.getElementById("outsourcing-hint").classList.toggle("hidden", jenis !== "outsourcing");
}

// Daftar pilihan Unit / PT sesuai jenis hubungan kerja: vendor untuk
// Outsourcing, PT sendiri (internal) untuk Karyawan Tetap/PKWT.
function ptOptionsFor(jenis) {
  return masterPts.filter(p => p.jenis === (jenis === "outsourcing" ? "vendor" : "internal"));
}

// Dipanggil saat Jenis Hubungan Kerja berubah: ganti daftar pilihan, dan
// kosongkan pilihan lama kalau sudah tidak cocok dengan jenis yang baru.
function onJenisChange() {
  refreshOutsourcingHint();
  const opts = ptOptionsFor(document.getElementById("jenis_hubungan_kerja").value);
  ssUnitPt.setOptions(opts);
  if (ssUnitPt.value && !opts.some(o => o.nama === ssUnitPt.value)) ssUnitPt.clear();
}


// ---------------------------------------------------------------------
// Cara Login (Email / PIN) pada form Tambah Karyawan
// ---------------------------------------------------------------------
let editingUserId = null;

function refreshLoginType() {
  const form = document.getElementById("form-karyawan");
  const isPin = document.getElementById("login_type").value === "pin";
  const adding = !form.id.value;
  document.getElementById("email-row").classList.toggle("hidden", isPin || !adding);
  document.getElementById("pin-row").classList.toggle("hidden", !isPin || !adding);
  form.email.required = !isPin && adding;
}

async function onResetPin(currentUser) {
  if (!editingUserId) return;
  if (!confirm("Buat PIN baru untuk karyawan ini? PIN lama langsung tidak berlaku.")) return;
  const form = document.getElementById("form-karyawan");
  const btn = document.getElementById("btn-reset-pin");
  btn.disabled = true;
  try {
    const res = await resetEmployeePin(editingUserId);
    await showCredentials(currentUser, {
      title: "PIN baru dibuat",
      namaKaryawan: form.full_name.value, kodeKaryawan: form.employee_code.value,
      loginType: "pin", secretLabel: "PIN", secret: res.pin,
    });
  } catch (err) {
    toast("Gagal reset PIN: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// Ubah akun PIN menjadi akun Email + Password (dikerjakan server).
async function onConvertToEmail(currentUser, isFullSuperAdmin) {
  if (!editingUserId) return;
  const email = document.getElementById("conv-email").value.trim().toLowerCase();
  const password = document.getElementById("conv-password").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Format email tidak valid", "error"); return; }
  if (password.length < 6) { toast("Password minimal 6 karakter", "error"); return; }
  if (!confirm("Ubah login karyawan ini ke Email + Password? PIN lama langsung tidak berlaku.")) return;
  const form = document.getElementById("form-karyawan");
  const btn = document.getElementById("btn-do-convert");
  btn.disabled = true;
  try {
    await callFunction("account-admin", { action: "convert-to-email", user_id: editingUserId, email, password });
    const nama = form.full_name.value, kode = form.employee_code.value;
    closeModal();
    loadTable(true, isFullSuperAdmin);
    await showCredentials(currentUser, {
      title: "Login diubah ke Email + Password",
      namaKaryawan: nama, kodeKaryawan: kode,
      loginType: "email", email, secretLabel: "Password", secret: password,
    });
  } catch (err) {
    toast("Gagal mengubah login: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// Ubah akun Email + Password menjadi akun PIN (dikerjakan server).
async function onConvertToPin(currentUser, isFullSuperAdmin) {
  if (!editingUserId) return;
  if (editingUserId === currentUser.id) { toast("Tidak bisa mengubah login akunmu sendiri.", "error"); return; }
  const pin = document.getElementById("conv-pin").value.trim();
  if (pin && !/^\d{6}$/.test(pin)) { toast("PIN harus 6 digit angka", "error"); return; }
  if (!confirm("Ubah login karyawan ini ke PIN? Email dan password lama langsung tidak berlaku.")) return;
  const form = document.getElementById("form-karyawan");
  const btn = document.getElementById("btn-do-convert-pin");
  btn.disabled = true;
  try {
    const res = await callFunction("account-admin", { action: "convert-to-pin", user_id: editingUserId, pin: pin || undefined });
    const nama = form.full_name.value, kode = form.employee_code.value;
    closeModal();
    loadTable(true, isFullSuperAdmin);
    await showCredentials(currentUser, {
      title: "Login diubah ke PIN",
      namaKaryawan: nama, kodeKaryawan: kode,
      loginType: "pin", secretLabel: "PIN", secret: res.pin,
    });
  } catch (err) {
    toast("Gagal mengubah login: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// Jendela berisi kredensial + pesan undangan siap kirim (WhatsApp).
// Sengaja BUKAN toast: PIN/password hanya ditampilkan sekali ini.
async function showCredentials(currentUser, info) {
  let tenant = null;
  try {
    const { data } = await supabase.from("tenants").select("kode, nama").eq("id", currentUser.tenant_id).maybeSingle();
    tenant = data;
  } catch { /* tetap tampilkan tanpa kode usaha */ }

  const text = inviteText({
    namaUsaha: tenant?.nama || "perusahaan", kodeUsaha: tenant?.kode || "-",
    namaKaryawan: info.namaKaryawan, kodeKaryawan: info.kodeKaryawan,
    email: info.email, secretLabel: info.secretLabel, secret: info.secret, loginType: info.loginType,
  });

  const el = document.createElement("div");
  el.className = "modal";
  el.innerHTML = `
    <div class="modal-box">
      <h3>${esc(info.title)}</h3>
      <p class="small muted">${esc(info.secretLabel)} ini <b>hanya tampil sekarang</b>. Salin pesan di bawah dan kirim ke karyawan.</p>
      <textarea readonly rows="9" style="width:100%; font-family:inherit;">${esc(text)}</textarea>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-act="close">Tutup</button>
        <button type="button" class="btn-primary" data-act="copy">Salin Pesan</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('[data-act="close"]').addEventListener("click", () => el.remove());
  el.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); toast("Pesan disalin", "success"); }
    catch { el.querySelector("textarea").select(); toast("Pilih teks lalu salin manual", "info"); }
  });
}


// Kode usaha ditampilkan tetap di header Data Karyawan (dipakai karyawan
// tanpa email untuk login), lengkap dengan tombol salin.
async function showKodeUsaha(currentUser) {
  const el = document.getElementById("kode-usaha-info");
  if (!el) return;
  try {
    const { data } = await supabase.from("tenants").select("kode").eq("id", currentUser.tenant_id).maybeSingle();
    if (!data?.kode) return;
    el.innerHTML = `Kode usaha: <b>${esc(data.kode)}</b> <button type="button" class="btn-link" id="btn-copy-kode">Salin</button>`;
    document.getElementById("btn-copy-kode").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(data.kode); toast("Kode usaha disalin", "success"); }
      catch { toast("Kode usaha: " + data.kode, "info"); }
    });
  } catch { /* abaikan: hanya informasi tambahan */ }
}
