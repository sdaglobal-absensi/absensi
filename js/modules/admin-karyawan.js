import { supabase, supabaseAdminCreate } from "../supabaseClient.js";
import { toast, roleLabel, jenisHubunganKerjaLabel, searchSelectHtml, wireSearchSelect, lamaBekerja, isSuper, avatarHTML } from "../core.js";
import {
  personalFieldsHtml, familySectionHtml, wireFamilyForm, fillBiodataForm,
  readBiodataForm, readChildren, loadChildren, saveChildren, fmtTanggal,
} from "../biodata.js";

let masterDepartments = [];
let masterLevels = [];
let masterLocations = [];
let ssDepartemen, ssBagian, ssJabatan, ssGrade, ssLokasi;
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
      <h1>Data Karyawan</h1>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Karyawan</button>` : ""}
    </div>
    <div id="karyawan-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-karyawan" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3 id="modal-title">Tambah Karyawan</h3>
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
          <div class="form-row two-col" id="email-row">
            <label id="email-label">Email <input type="email" name="email" required></label>
            <label id="password-label">Password Awal <input type="text" name="password" placeholder="min. 6 karakter"></label>
          </div>
          <div class="form-row two-col hidden" id="email-readonly-row">
            <label>Email <input type="email" id="email-readonly" disabled></label>
            <label class="small muted" style="align-self:end; padding-bottom:10px;">Karyawan lupa email? Ini alamat yang terdaftar untuk akun ini.</label>
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
            <label>Unit / PT <input name="unit_pt" placeholder="Contoh: PT Sinar Data Abadi"></label>
            ${searchSelectHtml({ id: "ss-lokasi", label: "Lokasi Kerja / Area", placeholder: "Cari lokasi kerja…" })}
          </div>
          <p class="small field-hint hidden" id="outsourcing-hint">Isi <b>Unit / PT</b> dengan nama PT vendor/penyedia jasa outsourcing, bukan nama PT sendiri.</p>
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

  if (canEdit) {
    await loadMasterData();
    setupSearchSelects();

    document.getElementById("btn-new").addEventListener("click", () => openModal());
    document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
    document.getElementById("form-karyawan").addEventListener("submit", e => onSubmit(e, user, isFullSuperAdmin));
    wireFamilyForm(document.getElementById("form-karyawan"));
    document.getElementById("join_date").addEventListener("input", refreshTenure);
    document.getElementById("resign_date").addEventListener("input", refreshTenure);
    document.querySelector('#form-karyawan input[name="is_active"]').addEventListener("change", refreshTenure);
    document.getElementById("jenis_hubungan_kerja").addEventListener("change", refreshOutsourcingHint);
  }

  loadTable(canEdit, isFullSuperAdmin);
}

async function loadMasterData() {
  const [{ data: depts }, { data: levels }, { data: locs }] = await Promise.all([
    supabase.from("departments").select("*").eq("is_active", true),
    supabase.from("job_levels").select("*").eq("is_active", true),
    supabase.from("office_locations").select("*").eq("is_active", true),
  ]);
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

  ssLokasi = wireSearchSelect("ss-lokasi", masterLocations, {
    getLabel: o => o.name,
    getValue: o => o.name,
  });
}

async function loadTable(canEdit, isFullSuperAdmin) {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  const el = document.getElementById("karyawan-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  // Tombol Edit sekarang muncul untuk SEMUA baris tanpa kecuali (termasuk
  // akun Super Admin) -- role tidak diubah dari sini
  // (lihat renderRoleDisplay) -- diatur lewat Struktur Organisasi.
  const canEditRow = () => canEdit;

  el.innerHTML = `
    <table class="table">
      <thead><tr><th></th><th>Kode</th><th>Nama</th><th>Email</th><th>Departemen</th><th>Jabatan</th><th>Level</th><th>PTKP</th><th>Hubungan Kerja</th><th>Role</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${data.map(k => `
          <tr>
            <td><span class="row-avatar">${avatarHTML(k, k.full_name)}</span></td>
            <td>${k.employee_code || "-"}</td>
            <td>${k.full_name}</td>
            <td>${k.email || "-"}</td>
            <td>${k.department || "-"}</td>
            <td>${k.position || "-"}</td>
            <td>${k.level || "-"}</td>
            <td>${k.ptkp || "-"}</td>
            <td>
              <span class="badge ${k.jenis_hubungan_kerja === "outsourcing" ? "badge-warn" : "badge-ok"}">${jenisHubunganKerjaLabel(k.jenis_hubungan_kerja)}</span>
              ${k.jenis_hubungan_kerja === "outsourcing" && k.unit_pt ? `<br><span class="muted small">${k.unit_pt}</span>` : ""}
            </td>
            <td>${roleLabel(k.role)}</td>
            <td>
              <span class="badge badge-${k.is_active ? "ok" : "danger"}">${k.is_active ? "Aktif" : "Nonaktif"}</span>
              ${k.resign_date ? `<br><span class="muted small">Resign ${fmtTanggal(k.resign_date)}</span>` : ""}
            </td>
            ${canEdit ? `<td>${canEditRow(k) ? `<button class="btn-link btn-edit" data-id="${k.id}">Edit</button>` : ""}</td>` : ""}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = data.find(k => k.id === btn.dataset.id);
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
  ssJabatan.setOptions([]); ssJabatan.clear(); ssGrade.clear(); ssLokasi.clear();
  document.getElementById("lama_bekerja").value = "";
  renderRoleDisplay(existing);

  document.getElementById("modal-title").textContent = existing ? "Edit Karyawan" : "Tambah Karyawan";
  document.getElementById("email-row").classList.toggle("hidden", !!existing);
  form.email.required = !existing;
  document.getElementById("email-readonly-row").classList.toggle("hidden", !existing);
  document.getElementById("email-readonly").value = existing?.email || "(tidak diketahui)";

  if (existing) {
    form.id.value = existing.id;
    form.full_name.value = existing.full_name || "";
    form.employee_code.value = existing.employee_code || "";
    form.is_active.checked = existing.is_active;
    form.unit_pt.value = existing.unit_pt || "";
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
  } else {
    form.id.value = "";
    form.status_karyawan.value = "bulanan";
    form.jenis_hubungan_kerja.value = "karyawan_tetap";
  }
  fillBiodataForm(form, existing || {}, children);
  refreshTenure();
  refreshOutsourcingHint();
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
    unit_pt: fd.get("unit_pt") || null,
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
      const email = fd.get("email");
      const password = fd.get("password") || Math.random().toString(36).slice(2, 10);
      // Pakai client terpisah supaya sesi admin yang sedang login tidak tertimpa.
      // Catatan keamanan: trigger di server SENGAJA mengabaikan "role" yang
      // dikirim lewat signUp metadata (siapa pun bisa memanggil signUp
      // langsung lewat anon key, jadi role tidak boleh dipercaya dari sini).
      // Profil selalu dibuat dengan role 'karyawan' dan role TIDAK ikut dikirim di
      // update di bawah; role diubah lewat Struktur Organisasi (Ubah Role).
      const { data: signUpData, error: signUpError } = await supabaseAdminCreate.auth.signUp({
        email, password,
        options: { data: { full_name: payload.full_name, employee_code: payload.employee_code } },
      });
      if (signUpError) throw signUpError;

      const newUserId = signUpData.user?.id;
      if (newUserId) {
        const { error: updErr } = await supabase.from("profiles").update({ ...payload, email }).eq("id", newUserId);
        if (updErr) throw updErr;
        await saveChildrenLabeled(newUserId, children);
      }
      await supabaseAdminCreate.auth.signOut();
      toast(`Akun dibuat. Beritahu karyawan: email ${email}, password ${password}`, "success");
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
  const isOutsourcing = document.getElementById("jenis_hubungan_kerja").value === "outsourcing";
  document.getElementById("outsourcing-hint").classList.toggle("hidden", !isOutsourcing);
}
