import { supabase } from "../supabaseClient.js";
import { toast } from "../core.js";

// =======================================================================
// MASTER PT / VENDOR — daftar badan hukum yang dipilih di kolom "Unit / PT"
// pada Data Karyawan (jadi tidak perlu diketik manual lagi):
//   - Internal : PT sendiri (dipilih untuk Karyawan Tetap / PKWT)
//   - Vendor   : PT penyedia jasa outsourcing (dipilih untuk Outsourcing)
// profiles.unit_pt tetap menyimpan NAMA-nya (teks), jadi Slip Gaji, Laporan,
// dan Invoice Outsourcing tidak perlu diubah. Kalau nama diedit di sini,
// nama di Data Karyawan yang memakainya ikut diperbarui.
// =======================================================================

const JENIS_LABEL = { internal: "PT Sendiri", vendor: "Vendor Outsourcing" };
let rows = [];

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master PT / Vendor</h1>
        <p class="muted">Daftar PT sendiri dan PT vendor outsourcing — dipilih di kolom Unit / PT pada Data Karyawan.</p>
      </div>
      <button id="btn-new" class="btn-primary">+ Tambah PT / Vendor</button>
    </div>
    <div id="pt-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <div id="modal-pt" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Tambah PT / Vendor</h3>
        <form id="form-pt">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Nama PT <input name="nama" required placeholder="Contoh: PT Karya Bintang Mandiri"></label>
          </div>
          <div class="form-row">
            <label>Jenis
              <select name="jenis" required>
                <option value="internal">PT Sendiri (untuk Karyawan Tetap / PKWT)</option>
                <option value="vendor">Vendor Outsourcing</option>
              </select>
            </label>
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
  `;

  document.getElementById("btn-new").addEventListener("click", () => openModal());
  document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
  document.getElementById("form-pt").addEventListener("submit", onSubmit);
  loadTable();
}

async function loadTable() {
  const el = document.getElementById("pt-table");
  const [{ data, error }, { data: users }] = await Promise.all([
    supabase.from("master_pt").select("*").order("jenis").order("nama"),
    supabase.from("profiles").select("unit_pt").eq("is_active", true).not("unit_pt", "is", null),
  ]);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  rows = data || [];
  if (!rows.length) { el.innerHTML = `<p class="muted">Belum ada data. Klik "+ Tambah PT / Vendor".</p>`; return; }

  const countByName = {};
  (users || []).forEach(u => { countByName[u.unit_pt] = (countByName[u.unit_pt] || 0) + 1; });

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama PT</th><th>Jenis</th><th>Karyawan Aktif</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(r.nama)}</td>
            <td><span class="badge ${r.jenis === "vendor" ? "badge-warn" : "badge-ok"}">${JENIS_LABEL[r.jenis]}</span></td>
            <td>${countByName[r.nama] || 0}</td>
            <td><span class="badge badge-${r.is_active ? "ok" : "danger"}">${r.is_active ? "Aktif" : "Nonaktif"}</span></td>
            <td><button class="btn-link btn-edit" data-id="${r.id}">Edit</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll(".btn-edit").forEach(btn => {
    btn.addEventListener("click", () => openModal(rows.find(r => r.id === btn.dataset.id)));
  });
}

function openModal(existing = null) {
  const form = document.getElementById("form-pt");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit PT / Vendor" : "Tambah PT / Vendor";
  if (existing) {
    form.id.value = existing.id;
    form.nama.value = existing.nama;
    form.jenis.value = existing.jenis;
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  document.getElementById("modal-pt").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-pt").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = {
    nama: String(fd.get("nama")).trim(),
    jenis: fd.get("jenis"),
    is_active: fd.get("is_active") === "on",
  };
  if (!payload.nama) { toast("Nama PT wajib diisi", "error"); return; }

  try {
    const old = id ? rows.find(r => r.id === id) : null;
    const { error } = id
      ? await supabase.from("master_pt").update(payload).eq("id", id)
      : await supabase.from("master_pt").insert(payload);
    if (error) throw error;

    // Nama berubah -> samakan nama di Data Karyawan yang memakainya.
    if (old && old.nama !== payload.nama) {
      const { error: e2 } = await supabase.from("profiles").update({ unit_pt: payload.nama }).eq("unit_pt", old.nama);
      if (e2) toast("Nama tersimpan, tapi gagal memperbarui Data Karyawan: " + e2.message, "error");
    }
    toast("PT / Vendor tersimpan", "success");
    closeModal();
    loadTable();
  } catch (err) {
    const dup = /duplicate|unique/i.test(err.message);
    toast(dup ? "Nama PT itu sudah ada di daftar." : "Gagal menyimpan: " + err.message, "error");
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
