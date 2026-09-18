import { supabase } from "../supabaseClient.js";
import { toast } from "../core.js";

export async function render(container, user) {
  const canEdit = user.role === "admin";

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Departemen</h1>
        <p class="muted">Struktur Departemen, Bagian, dan Jabatan — dipakai sebagai acuan saat mengisi data karyawan.</p>
      </div>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Data</button>` : ""}
    </div>
    <div id="dept-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-dept" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Tambah Data</h3>
        <form id="form-dept">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Departemen <input name="departemen" required placeholder="Contoh: Produksi"></label>
          </div>
          <div class="form-row">
            <label>Bagian <input name="bagian" required placeholder="Contoh: Quality Control"></label>
          </div>
          <div class="form-row">
            <label>Jabatan <input name="jabatan" required placeholder="Contoh: QC Inspector"></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif dipakai</label>
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
    document.getElementById("btn-new").addEventListener("click", () => openModal());
    document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
    document.getElementById("form-dept").addEventListener("submit", onSubmit);
  }

  loadTable(canEdit);
}

async function loadTable(canEdit) {
  const { data, error } = await supabase
    .from("departments")
    .select("*")
    .order("departemen", { ascending: true })
    .order("bagian", { ascending: true });

  const el = document.getElementById("dept-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada data master departemen.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Departemen</th><th>Bagian</th><th>Jabatan</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.departemen}</td>
            <td>${r.bagian}</td>
            <td>${r.jabatan}</td>
            <td><span class="badge badge-${r.is_active ? "ok" : "danger"}">${r.is_active ? "Aktif" : "Nonaktif"}</span></td>
            ${canEdit ? `<td><button class="btn-link btn-edit" data-id="${r.id}">Edit</button></td>` : ""}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = data.find(r => r.id === btn.dataset.id);
        openModal(row);
      });
    });
  }
}

function openModal(existing = null) {
  const modal = document.getElementById("modal-dept");
  const form = document.getElementById("form-dept");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Data" : "Tambah Data";

  if (existing) {
    form.id.value = existing.id;
    form.departemen.value = existing.departemen;
    form.bagian.value = existing.bagian;
    form.jabatan.value = existing.jabatan;
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-dept").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = {
    departemen: fd.get("departemen"),
    bagian: fd.get("bagian"),
    jabatan: fd.get("jabatan"),
    is_active: fd.get("is_active") === "on",
  };

  try {
    const { error } = id
      ? await supabase.from("departments").update(payload).eq("id", id)
      : await supabase.from("departments").insert(payload);
    if (error) throw error;
    toast("Master departemen tersimpan", "success");
    closeModal();
    loadTable(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
