import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah } from "../core.js";

// =======================================================================
// MASTER TUNJANGAN
// Tunjangan seperti "Tunjangan Jabatan" atau "Tunjangan Loyalitas" nominalnya
// beda-beda per karyawan (bukan per grade/level), dan admin bisa bikin jenis
// tunjangan sendiri bebas (tidak terbatas 2 nama itu). Dua bagian di halaman
// ini:
//   1. Jenis Tunjangan — daftar nama tunjangan yang tersedia (allowance_types).
//   2. Atur Nominal per Karyawan — nominal tunjangan tertentu untuk tiap
//      karyawan (employee_allowances), berlaku terus tiap bulan di Slip Gaji
//      sampai diubah/dinonaktifkan, tidak perlu diisi ulang tiap periode.
// =======================================================================

let canEdit = false;
let allowanceTypes = [];
let employees = [];
let employeeAllowanceByUser = {}; // { [typeId]: { [userId]: row } }
let selectedTypeId = "";

export async function render(container, user) {
  canEdit = user.role === "admin";

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Tunjangan</h1>
        <p class="muted">Jenis tunjangan bisa dibuat sendiri (Tunjangan Jabatan, Loyalitas, dst), lalu nominalnya diatur per karyawan — otomatis masuk ke Slip Gaji tiap bulan tanpa perlu diisi ulang.</p>
      </div>
      ${canEdit ? `<button id="btn-new-type" class="btn-primary">+ Jenis Tunjangan</button>` : ""}
    </div>

    <h3 style="margin-bottom:10px;">Jenis Tunjangan</h3>
    <div id="type-table" class="table-wrap" style="margin-bottom:32px;"><p class="muted">Memuat…</p></div>

    <h3 style="margin-bottom:4px;">Atur Nominal per Karyawan</h3>
    <p class="muted small" style="margin-top:0; margin-bottom:14px;">Pilih jenis tunjangan, lalu atur nominalnya untuk masing-masing karyawan.</p>
    <div class="filter-row" style="margin-bottom:14px;">
      <select id="filter-type"></select>
    </div>
    <div id="employee-table" class="table-wrap"></div>

    ${canEdit ? `
    <!-- Modal: tambah/edit jenis tunjangan -->
    <div id="modal-type" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-type-title">Tambah Jenis Tunjangan</h3>
        <form id="form-type">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Nama Tunjangan <input name="nama" required placeholder="Contoh: Tunjangan Jabatan"></label>
          </div>
          <div class="form-row">
            <label>Keterangan (opsional) <input name="keterangan" placeholder="Contoh: Untuk karyawan level supervisor ke atas"></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif (dihitung di Slip Gaji)</label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-type" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal: atur nominal per karyawan -->
    <div id="modal-nominal" class="modal hidden">
      <div class="modal-box">
        <h3>Atur Nominal</h3>
        <p class="muted small" id="nominal-emp-label" style="margin-top:-4px;"></p>
        <form id="form-nominal">
          <input type="hidden" name="user_id">
          <div class="form-row">
            <label>Nominal (Rp/bulan) <input type="number" name="nominal" min="0" step="1" required></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif (dihitung di Slip Gaji)</label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-nominal" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
    ` : ""}
  `;

  if (canEdit) {
    document.getElementById("btn-new-type").addEventListener("click", () => openTypeModal());
    document.getElementById("btn-cancel-type").addEventListener("click", closeTypeModal);
    document.getElementById("form-type").addEventListener("submit", onSubmitType);
    document.getElementById("btn-cancel-nominal").addEventListener("click", closeNominalModal);
    document.getElementById("form-nominal").addEventListener("submit", onSubmitNominal);
  }

  document.getElementById("filter-type").addEventListener("change", e => {
    selectedTypeId = e.target.value;
    renderEmployeeTable();
  });

  await loadAll();
}

async function loadAll() {
  const [{ data: types, error: errTypes }, { data: emp }, { data: alw }] = await Promise.all([
    supabase.from("allowance_types").select("*").order("nama"),
    supabase.from("profiles").select("id, full_name, employee_code, grade, level").eq("is_active", true).order("full_name"),
    supabase.from("employee_allowances").select("*"),
  ]);

  if (errTypes) { toast("Gagal memuat jenis tunjangan: " + errTypes.message, "error"); }

  allowanceTypes = types || [];
  employees = emp || [];

  employeeAllowanceByUser = {};
  (alw || []).forEach(row => {
    (employeeAllowanceByUser[row.allowance_type_id] ??= {})[row.user_id] = row;
  });

  if (!selectedTypeId || !allowanceTypes.some(t => t.id === selectedTypeId)) {
    selectedTypeId = allowanceTypes[0]?.id || "";
  }

  renderTypeTable();
  renderTypeFilter();
  renderEmployeeTable();
}

// -----------------------------------------------------------------------
// JENIS TUNJANGAN
// -----------------------------------------------------------------------
function renderTypeTable() {
  const el = document.getElementById("type-table");
  if (!allowanceTypes.length) { el.innerHTML = `<p class="muted">Belum ada jenis tunjangan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Keterangan</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${allowanceTypes.map(t => `
          <tr>
            <td>${t.nama}</td>
            <td>${t.keterangan || "-"}</td>
            <td><span class="badge badge-${t.is_active ? "ok" : "danger"}">${t.is_active ? "Aktif" : "Nonaktif"}</span></td>
            ${canEdit ? `<td><button class="btn-link btn-edit-type" data-id="${t.id}">Edit</button></td>` : ""}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-edit-type").forEach(btn => {
      btn.addEventListener("click", () => openTypeModal(allowanceTypes.find(t => t.id === btn.dataset.id)));
    });
  }
}

function openTypeModal(existing = null) {
  const modal = document.getElementById("modal-type");
  const form = document.getElementById("form-type");
  form.reset();
  document.getElementById("modal-type-title").textContent = existing ? "Edit Jenis Tunjangan" : "Tambah Jenis Tunjangan";

  if (existing) {
    form.id.value = existing.id;
    form.nama.value = existing.nama;
    form.keterangan.value = existing.keterangan || "";
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  modal.classList.remove("hidden");
}

function closeTypeModal() {
  document.getElementById("modal-type").classList.add("hidden");
}

async function onSubmitType(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = {
    nama: fd.get("nama"),
    keterangan: fd.get("keterangan") || null,
    is_active: fd.get("is_active") === "on",
  };

  try {
    const { error } = id
      ? await supabase.from("allowance_types").update(payload).eq("id", id)
      : await supabase.from("allowance_types").insert(payload);
    if (error) throw error;
    toast("Jenis tunjangan tersimpan", "success");
    closeTypeModal();
    await loadAll();
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}

// -----------------------------------------------------------------------
// NOMINAL PER KARYAWAN
// -----------------------------------------------------------------------
function renderTypeFilter() {
  const sel = document.getElementById("filter-type");
  if (!allowanceTypes.length) { sel.innerHTML = `<option value="">Belum ada jenis tunjangan</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  sel.innerHTML = allowanceTypes.map(t => `<option value="${t.id}" ${t.id === selectedTypeId ? "selected" : ""}>${t.nama}${t.is_active ? "" : " (nonaktif)"}</option>`).join("");
}

function renderEmployeeTable() {
  const el = document.getElementById("employee-table");
  if (!selectedTypeId) { el.innerHTML = `<p class="muted">Buat jenis tunjangan dulu di atas.</p>`; return; }
  if (!employees.length) { el.innerHTML = `<p class="muted">Belum ada karyawan aktif.</p>`; return; }

  const rowsForType = employeeAllowanceByUser[selectedTypeId] || {};

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Kode</th><th>Grade/Level</th><th>Nominal</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${employees.map(emp => {
          const row = rowsForType[emp.id];
          return `
            <tr>
              <td>${emp.full_name}</td>
              <td>${emp.employee_code || "-"}</td>
              <td>${emp.grade ? `${emp.grade} — ${emp.level || "-"}` : "-"}</td>
              <td>${row ? fmtRupiah(row.nominal) : `<span class="muted">Belum diatur</span>`}</td>
              <td>${row ? `<span class="badge badge-${row.is_active ? "ok" : "danger"}">${row.is_active ? "Aktif" : "Nonaktif"}</span>` : "-"}</td>
              ${canEdit ? `<td><button class="btn-link btn-set-nominal" data-id="${emp.id}">${row ? "Ubah" : "Atur"}</button></td>` : ""}
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-set-nominal").forEach(btn => {
      btn.addEventListener("click", () => openNominalModal(btn.dataset.id));
    });
  }
}

function openNominalModal(userId) {
  const emp = employees.find(e => e.id === userId);
  const row = (employeeAllowanceByUser[selectedTypeId] || {})[userId];
  const type = allowanceTypes.find(t => t.id === selectedTypeId);
  const form = document.getElementById("form-nominal");
  form.reset();
  form.user_id.value = userId;
  document.getElementById("nominal-emp-label").textContent = `${emp.full_name} — ${type.nama}`;
  form.nominal.value = row ? row.nominal : 0;
  form.is_active.checked = row ? row.is_active : true;
  document.getElementById("modal-nominal").classList.remove("hidden");
}

function closeNominalModal() {
  document.getElementById("modal-nominal").classList.add("hidden");
}

async function onSubmitNominal(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    user_id: fd.get("user_id"),
    allowance_type_id: selectedTypeId,
    nominal: Number(fd.get("nominal")) || 0,
    is_active: fd.get("is_active") === "on",
  };

  try {
    const { error } = await supabase.from("employee_allowances").upsert(payload, { onConflict: "user_id,allowance_type_id" });
    if (error) throw error;
    toast("Nominal tunjangan tersimpan", "success");
    closeNominalModal();
    await loadAll();
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
