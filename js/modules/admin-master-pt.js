import { supabase } from "../supabaseClient.js";
import { toast } from "../core.js";

import { escapeHtml as escMsg } from "../core.js";
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
      <div class="modal-box modal-box-lg">
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
          <fieldset id="fs-invoice" class="pt-invoice-fields">
            <legend>Pengaturan Invoice (khusus Vendor Outsourcing)</legend>
            <p class="muted small">Isi 0 bila komponen tidak berlaku — barisnya tidak akan muncul di invoice. Management fee dihitung dari total gaji; PPN dan PPh 23 dihitung dari management fee.</p>
            <div class="form-row pt-rates">
              <label>Management Fee (%) <input type="number" name="fee_persen" min="0" step="0.01" value="0"></label>
              <label>PPN (%) <input type="number" name="ppn_persen" min="0" step="0.01" value="0"></label>
              <label>PPh 23 (%) <input type="number" name="pph23_persen" min="0" step="0.01" value="0"></label>
            </div>
            <div class="form-row">
              <label>Rekening Bank <input name="bank_rekening" placeholder="Contoh: Bank Mandiri KCP Krian - No. Rek: 1410007515265"></label>
            </div>
            <div class="form-row">
              <label>Nama Penandatangan (Mengetahui) <input name="nama_penandatangan" placeholder="Contoh: Totok Supriyono"></label>
            </div>
          </fieldset>
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
  document.querySelector("#form-pt [name=jenis]").addEventListener("change", toggleInvoiceFields);
  loadTable();
}

async function loadTable() {
  const el = document.getElementById("pt-table");
  const [{ data, error }, { data: users }] = await Promise.all([
    supabase.from("master_pt").select("*").order("jenis").order("nama"),
    supabase.from("profiles").select("unit_pt").eq("is_active", true).not("unit_pt", "is", null),
  ]);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${escMsg(error.message)}</p>`; return; }
  rows = data || [];
  if (!rows.length) { el.innerHTML = `<p class="muted">Belum ada data. Klik "+ Tambah PT / Vendor".</p>`; return; }

  const countByName = {};
  (users || []).forEach(u => { countByName[u.unit_pt] = (countByName[u.unit_pt] || 0) + 1; });

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama PT</th><th>Jenis</th><th>Fee / PPN / PPh 23</th><th>Karyawan Aktif</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(r.nama)}</td>
            <td><span class="badge ${r.jenis === "vendor" ? "badge-warn" : "badge-ok"}">${JENIS_LABEL[r.jenis]}</span></td>
            <td>${r.jenis === "vendor" ? `${fmtPct(r.fee_persen)} / ${fmtPct(r.ppn_persen)} / ${fmtPct(r.pph23_persen)}` : `<span class="muted">-</span>`}</td>
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
    form.fee_persen.value = existing.fee_persen ?? 0;
    form.ppn_persen.value = existing.ppn_persen ?? 0;
    form.pph23_persen.value = existing.pph23_persen ?? 0;
    form.bank_rekening.value = existing.bank_rekening || "";
    form.nama_penandatangan.value = existing.nama_penandatangan || "";
  } else {
    form.id.value = "";
  }
  toggleInvoiceFields();
  document.getElementById("modal-pt").classList.remove("hidden");
}

// Pengaturan invoice hanya relevan untuk Vendor Outsourcing.
function toggleInvoiceFields() {
  const isVendor = document.querySelector("#form-pt [name=jenis]").value === "vendor";
  document.getElementById("fs-invoice").classList.toggle("hidden", !isVendor);
}

function fmtPct(n) { return `${String(Number(n) || 0).replace(".", ",")}%`; }

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
    fee_persen: Number(fd.get("fee_persen")) || 0,
    ppn_persen: Number(fd.get("ppn_persen")) || 0,
    pph23_persen: Number(fd.get("pph23_persen")) || 0,
    bank_rekening: String(fd.get("bank_rekening") || "").trim() || null,
    nama_penandatangan: String(fd.get("nama_penandatangan") || "").trim() || null,
  };
  if (payload.fee_persen < 0 || payload.ppn_persen < 0 || payload.pph23_persen < 0) { toast("Persentase tidak boleh negatif", "error"); return; }
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
