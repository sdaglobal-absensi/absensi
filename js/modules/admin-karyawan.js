import { supabase, supabaseAdminCreate } from "../supabaseClient.js";
import { toast, roleLabel, searchSelectHtml, wireSearchSelect, lamaBekerja } from "../core.js";

let masterDepartments = [];
let masterLevels = [];
let masterLocations = [];
let ssDepartemen, ssBagian, ssJabatan, ssGrade, ssLokasi;

export async function render(container, user) {
  const canEdit = user.role === "admin";

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
            <label>Alamat <input name="alamat"></label>
          </div>

          <div class="form-section-label">Data Akun</div>
          <div class="form-row two-col">
            <label>Kode Karyawan <input name="employee_code" required></label>
            <label>Role
              <select name="role">
                <option value="karyawan">Karyawan</option>
                <option value="hr">HR / Manager</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <div class="form-row two-col" id="email-row">
            <label>Email <input type="email" name="email" required></label>
            <label>Password Awal <input type="text" name="password" placeholder="min. 6 karakter"></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Akun aktif</label>
          </div>

          <div class="form-section-label">Penempatan</div>
          <div class="form-row two-col">
            <label>Unit / PT <input name="unit_pt" placeholder="Contoh: PT Sinar Data Abadi"></label>
            ${searchSelectHtml({ id: "ss-lokasi", label: "Lokasi Kerja / Area", placeholder: "Cari lokasi kerja…" })}
          </div>
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
    document.getElementById("form-karyawan").addEventListener("submit", e => onSubmit(e, user));
    document.getElementById("join_date").addEventListener("input", e => {
      document.getElementById("lama_bekerja").value = lamaBekerja(e.target.value);
    });
  }

  loadTable(canEdit);
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

async function loadTable(canEdit) {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  const el = document.getElementById("karyawan-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Kode</th><th>Nama</th><th>Departemen</th><th>Jabatan</th><th>Level</th><th>Role</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${data.map(k => `
          <tr>
            <td>${k.employee_code || "-"}</td>
            <td>${k.full_name}</td>
            <td>${k.department || "-"}</td>
            <td>${k.position || "-"}</td>
            <td>${k.level || "-"}</td>
            <td>${roleLabel(k.role)}</td>
            <td><span class="badge badge-${k.is_active ? "ok" : "danger"}">${k.is_active ? "Aktif" : "Nonaktif"}</span></td>
            ${canEdit ? `<td><button class="btn-link btn-edit" data-id="${k.id}">Edit</button></td>` : ""}
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

function openModal(existing = null) {
  const modal = document.getElementById("modal-karyawan");
  const form = document.getElementById("form-karyawan");
  form.reset();
  ssDepartemen.clear(); ssBagian.setOptions([]); ssBagian.clear();
  ssJabatan.setOptions([]); ssJabatan.clear(); ssGrade.clear(); ssLokasi.clear();
  document.getElementById("lama_bekerja").value = "";

  document.getElementById("modal-title").textContent = existing ? "Edit Karyawan" : "Tambah Karyawan";
  document.getElementById("email-row").classList.toggle("hidden", !!existing);
  form.email.required = !existing;

  if (existing) {
    form.id.value = existing.id;
    form.full_name.value = existing.full_name || "";
    form.employee_code.value = existing.employee_code || "";
    form.role.value = existing.role || "karyawan";
    form.is_active.checked = existing.is_active;
    form.unit_pt.value = existing.unit_pt || "";
    form.status_karyawan.value = existing.status_karyawan || "bulanan";
    form.join_date.value = existing.join_date || "";
    form.phone.value = existing.phone || "";
    form.nik_ktp.value = existing.nik_ktp || "";
    form.npwp.value = existing.npwp || "";
    form.alamat.value = existing.alamat || "";
    form.grade.value = existing.grade || "";
    form.level.value = existing.level || "";

    document.getElementById("lama_bekerja").value = lamaBekerja(existing.join_date);

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
  }
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-karyawan").classList.add("hidden");
}

async function onSubmit(e, currentUser) {
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
    lokasi_kerja: ssLokasi.value || null,
    status_karyawan: fd.get("status_karyawan"),
    join_date: fd.get("join_date") || null,
    phone: fd.get("phone") || null,
    nik_ktp: fd.get("nik_ktp") || null,
    npwp: fd.get("npwp") || null,
    alamat: fd.get("alamat") || null,
    role: fd.get("role"),
    is_active: fd.get("is_active") === "on",
  };

  try {
    if (id) {
      const { error } = await supabase.from("profiles").update(payload).eq("id", id);
      if (error) throw error;
      toast("Data karyawan diperbarui", "success");
    } else {
      const email = fd.get("email");
      const password = fd.get("password") || Math.random().toString(36).slice(2, 10);
      // Pakai client terpisah supaya sesi admin yang sedang login tidak tertimpa.
      const { data: signUpData, error: signUpError } = await supabaseAdminCreate.auth.signUp({
        email, password,
        options: { data: { full_name: payload.full_name, role: payload.role, employee_code: payload.employee_code } },
      });
      if (signUpError) throw signUpError;

      const newUserId = signUpData.user?.id;
      if (newUserId) {
        await supabase.from("profiles").update(payload).eq("id", newUserId);
      }
      await supabaseAdminCreate.auth.signOut();
      toast(`Akun dibuat. Beritahu karyawan: email ${email}, password ${password}`, "success");
    }
    closeModal();
    loadTable(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
