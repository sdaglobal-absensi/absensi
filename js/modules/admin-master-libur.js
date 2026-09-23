import { supabase } from "../supabaseClient.js";
import { toast, fmtDate } from "../core.js";

export async function render(container, user) {
  const canEdit = true; // siapa pun yang sampai ke sini sudah lolos guard permission menu ini

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Hari Libur</h1>
        <p class="muted">Kalender tanggal merah nasional, cuti bersama, atau libur khusus perusahaan.</p>
      </div>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Hari Libur</button>` : ""}
    </div>
    <div id="holiday-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-holiday" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Tambah Hari Libur</h3>
        <form id="form-holiday">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Tanggal <input type="date" name="date" required></label>
          </div>
          <div class="form-row">
            <label>Nama Libur <input name="name" required placeholder="Contoh: Hari Raya Idul Fitri"></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif</label>
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
    document.getElementById("form-holiday").addEventListener("submit", onSubmit);
  }

  loadTable(canEdit);
}

async function loadTable(canEdit) {
  const { data, error } = await supabase.from("holidays").select("*").order("date", { ascending: true });
  const el = document.getElementById("holiday-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada data hari libur.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal</th><th>Nama Libur</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${r.name}</td>
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
  const modal = document.getElementById("modal-holiday");
  const form = document.getElementById("form-holiday");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Hari Libur" : "Tambah Hari Libur";

  if (existing) {
    form.id.value = existing.id;
    form.date.value = existing.date;
    form.name.value = existing.name;
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-holiday").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = {
    date: fd.get("date"),
    name: fd.get("name"),
    is_active: fd.get("is_active") === "on",
  };

  try {
    const { error } = id
      ? await supabase.from("holidays").update(payload).eq("id", id)
      : await supabase.from("holidays").insert(payload);
    if (error) throw error;
    toast("Hari libur tersimpan", "success");
    closeModal();
    loadTable(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
