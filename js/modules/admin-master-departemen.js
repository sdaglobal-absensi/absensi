import { supabase } from "../supabaseClient.js";
import { toast, confirmDialog, escapeHtml } from "../core.js";
import { hasXLSX, readFirstSheet, cellText, writeWorkbook, widthsFor, pickFileThen } from "../excelIO.js";

import { escapeHtml as escMsg } from "../core.js";
// Kolom Excel: Departemen, Bagian, Jabatan, Status (Aktif/Nonaktif).
// Baris yang kombinasi Departemen+Bagian+Jabatan-nya sudah ada tidak dibuat
// ganda; kolom Status (kalau diisi) hanya dipakai untuk mengubah aktif/nonaktif.
const HEADERS = ["Departemen", "Bagian", "Jabatan", "Status"];
let currentRows = [];

export async function render(container, user) {
  const canEdit = true; // siapa pun yang sampai ke sini sudah lolos guard permission menu ini

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Departemen</h1>
        <p class="muted">Struktur Departemen, Bagian, dan Jabatan — dipakai sebagai acuan saat mengisi data karyawan.</p>
      </div>
      ${canEdit ? `
      <div class="filter-row pg-head-actions">
        <input type="file" id="import-file" accept=".xlsx,.xls" class="hidden">
        <button id="btn-template" class="btn-secondary">Download Template</button>
        <button id="btn-import" class="btn-secondary">Import Excel</button>
        <button id="btn-export" class="btn-secondary">Export Excel</button>
        <button id="btn-new" class="btn-primary">+ Tambah Data</button>
      </div>` : ""}
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
    document.getElementById("btn-template").addEventListener("click", downloadTemplate);
    document.getElementById("btn-export").addEventListener("click", doExport);
    document.getElementById("btn-import").addEventListener("click", () => document.getElementById("import-file").click());
    pickFileThen(document.getElementById("import-file"), onImportFile);
  }

  loadTable(canEdit);
}

async function loadTable(canEdit) {
  const { data, error } = await supabase
    .from("departments")
    .select("*")
    .order("departemen", { ascending: true })
    .order("bagian", { ascending: true });

  currentRows = data || [];
  const el = document.getElementById("dept-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${escMsg(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada data master departemen.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Departemen</th><th>Bagian</th><th>Jabatan</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${escapeHtml(r.departemen)}</td>
            <td>${escapeHtml(r.bagian)}</td>
            <td>${escapeHtml(r.jabatan)}</td>
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

// ---------------------------------------------------------------------
// TEMPLATE / EXPORT / IMPORT EXCEL
// ---------------------------------------------------------------------
function downloadTemplate() {
  if (!hasXLSX()) { toast("Library Excel belum termuat, coba refresh halaman.", "error"); return; }
  const rows = [HEADERS, ["HCS", "GA", "HCS Staff", "Aktif"], ["Produksi", "Quality Control", "QC Inspector", "Aktif"]];
  const guide = [
    ["Petunjuk pengisian"],
    ["Isi sheet \"Data\" mulai baris 2 (dua baris contoh boleh dihapus)."],
    ["Departemen, Bagian, dan Jabatan wajib diisi."],
    ["Status: Aktif atau Nonaktif. Kosong = Aktif untuk data baru, tidak mengubah status untuk data yang sudah ada."],
    ["Kombinasi Departemen + Bagian + Jabatan yang sudah ada di sistem tidak akan dibuat ganda."],
  ];
  writeWorkbook("Template_Master_Departemen.xlsx", [
    { name: "Data", rows, widths: widthsFor(HEADERS, rows) },
    { name: "Petunjuk", rows: guide, widths: [90] },
  ]);
}

function doExport() {
  if (!hasXLSX()) { toast("Library Excel belum termuat, coba refresh halaman.", "error"); return; }
  if (!currentRows.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const rows = [HEADERS, ...currentRows.map(r => [r.departemen, r.bagian, r.jabatan, r.is_active ? "Aktif" : "Nonaktif"])];
  writeWorkbook("Master_Departemen.xlsx", [{ name: "Data", rows, widths: widthsFor(HEADERS, rows) }]);
}

const keyOf = (d, b, j) => [d, b, j].map(x => cellText(x).toLowerCase()).join("||");

async function onImportFile(file) {
  if (!hasXLSX()) { toast("Fitur import butuh library XLSX yang belum termuat.", "error"); return; }
  let rows;
  try { rows = await readFirstSheet(file); } catch (err) { toast("File tidak bisa dibaca: " + err.message, "error"); return; }
  if (!rows.length) { toast("File Excel kosong atau format kolom tidak dikenali.", "error"); return; }

  const existing = new Map(currentRows.map(r => [keyOf(r.departemen, r.bagian, r.jabatan), r]));
  const seen = new Set();
  const toInsert = [], toUpdate = [], errors = [];
  let unchanged = 0;

  rows.forEach(r => {
    const departemen = cellText(r.get("Departemen"));
    const bagian = cellText(r.get("Bagian"));
    const jabatan = cellText(r.get("Jabatan"));
    const statusTxt = cellText(r.get("Status")).toLowerCase();
    if (!departemen || !bagian || !jabatan) { errors.push(`Baris ${r._row}: Departemen, Bagian, dan Jabatan wajib diisi`); return; }
    if (statusTxt && !["aktif", "nonaktif"].includes(statusTxt)) { errors.push(`Baris ${r._row}: Status harus "Aktif" atau "Nonaktif"`); return; }
    const k = keyOf(departemen, bagian, jabatan);
    if (seen.has(k)) { errors.push(`Baris ${r._row}: duplikat dengan baris lain di file`); return; }
    seen.add(k);

    const old = existing.get(k);
    if (!old) { toInsert.push({ departemen, bagian, jabatan, is_active: statusTxt !== "nonaktif" }); return; }
    if (statusTxt && (statusTxt === "aktif") !== old.is_active) toUpdate.push({ id: old.id, is_active: statusTxt === "aktif" });
    else unchanged++;
  });

  if (!toInsert.length && !toUpdate.length) {
    toast(errors.length ? `Tidak ada yang bisa diimport. ${errors.slice(0, 3).join("; ")}` : "Semua baris sudah ada di sistem, tidak ada perubahan.", errors.length ? "error" : "success");
    return;
  }

  const ok = await confirmDialog({
    title: "Import Master Departemen",
    message: `${toInsert.length} data baru akan ditambahkan.\n${toUpdate.length} data akan diubah status aktifnya.\n${unchanged} baris sudah ada (dilewati).` +
      (errors.length ? `\n\n${errors.length} baris bermasalah (dilewati):\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? "\n…" : ""}` : ""),
    confirmLabel: "Proses Import",
  });
  if (!ok) return;

  try {
    if (toInsert.length) {
      const { error } = await supabase.from("departments").insert(toInsert);
      if (error) throw error;
    }
    for (const u of toUpdate) {
      const { error } = await supabase.from("departments").update({ is_active: u.is_active }).eq("id", u.id);
      if (error) throw error;
    }
    toast(`Import selesai: ${toInsert.length} ditambahkan, ${toUpdate.length} diubah.`, "success");
    loadTable(true);
  } catch (err) {
    toast("Gagal import: " + err.message, "error");
  }
}
