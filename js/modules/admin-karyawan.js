import { supabase, supabaseAdminCreate } from "../supabaseClient.js";
import { toast, roleLabel } from "../core.js";

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Data Karyawan</h1>
      <button id="btn-new" class="btn-primary">+ Tambah Karyawan</button>
    </div>
    <div id="karyawan-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <div id="modal-karyawan" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Tambah Karyawan</h3>
        <form id="form-karyawan">
          <input type="hidden" name="id">
          <div class="form-row two-col">
            <label>Nama Lengkap <input name="full_name" required></label>
            <label>Kode Karyawan <input name="employee_code" required></label>
          </div>
          <div class="form-row two-col" id="email-row">
            <label>Email <input type="email" name="email" required></label>
            <label>Password Awal <input type="text" name="password" placeholder="min. 6 karakter"></label>
          </div>
          <div class="form-row two-col">
            <label>Departemen <input name="department"></label>
            <label>Jabatan <input name="position"></label>
          </div>
          <div class="form-row two-col">
            <label>No. HP <input name="phone"></label>
            <label>Role
              <select name="role">
                <option value="karyawan">Karyawan</option>
                <option value="hr">HR / Manager</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Akun aktif</label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("btn-new").addEventListener("click", () => openModal());
  document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
  document.getElementById("form-karyawan").addEventListener("submit", e => onSubmit(e, user));

  loadTable();
}

async function loadTable() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  const el = document.getElementById("karyawan-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Kode</th><th>Nama</th><th>Departemen</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${data.map(k => `
          <tr>
            <td>${k.employee_code || "-"}</td>
            <td>${k.full_name}</td>
            <td>${k.department || "-"}</td>
            <td>${roleLabel(k.role)}</td>
            <td><span class="badge badge-${k.is_active ? "ok" : "danger"}">${k.is_active ? "Aktif" : "Nonaktif"}</span></td>
            <td><button class="btn-link btn-edit" data-id="${k.id}">Edit</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = data.find(k => k.id === btn.dataset.id);
      openModal(row);
    });
  });
}

function openModal(existing = null) {
  const modal = document.getElementById("modal-karyawan");
  const form = document.getElementById("form-karyawan");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Karyawan" : "Tambah Karyawan";
  document.getElementById("email-row").classList.toggle("hidden", !!existing);
  form.email.required = !existing;

  if (existing) {
    form.id.value = existing.id;
    form.full_name.value = existing.full_name || "";
    form.employee_code.value = existing.employee_code || "";
    form.department.value = existing.department || "";
    form.position.value = existing.position || "";
    form.phone.value = existing.phone || "";
    form.role.value = existing.role || "karyawan";
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
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
    department: fd.get("department"),
    position: fd.get("position"),
    phone: fd.get("phone"),
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

      // Trigger di database otomatis membuat baris profiles; lengkapi field sisanya.
      const newUserId = signUpData.user?.id;
      if (newUserId) {
        await supabase.from("profiles").update(payload).eq("id", newUserId);
      }
      await supabaseAdminCreate.auth.signOut();
      toast(`Akun dibuat. Beritahu karyawan: email ${email}, password ${password}`, "success");
    }
    closeModal();
    loadTable();
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
