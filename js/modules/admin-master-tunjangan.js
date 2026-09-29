import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, confirmDialog } from "../core.js";
import { hasXLSX, readFirstSheet, cellText, cellNumber, normKey, writeWorkbook, widthsFor, pickFileThen } from "../excelIO.js";

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

// Tampilan input nominal pakai titik ribuan (mis. "100.000") biar gampang
// dibaca; disimpan tetap sebagai angka biasa.
function formatRibuan(n) {
  return (Number(n) || 0).toLocaleString("id-ID");
}

function parseRibuan(str) {
  return Number(String(str).replace(/\D/g, "")) || 0;
}

export async function render(container, user) {
  canEdit = true; // siapa pun yang sampai ke sini sudah lolos guard permission menu ini

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Tunjangan</h1>
        <p class="muted">Jenis tunjangan bisa dibuat sendiri (Tunjangan Jabatan, Loyalitas, dst), lalu nominalnya diatur per karyawan — otomatis masuk ke Slip Gaji tiap bulan tanpa perlu diisi ulang.</p>
      </div>
      ${canEdit ? `
      <div class="filter-row pg-head-actions">
        <input type="file" id="import-file" accept=".xlsx,.xls" class="hidden">
        <button id="btn-template" class="btn-secondary">Download Template</button>
        <button id="btn-import" class="btn-secondary">Import Excel</button>
        <button id="btn-export" class="btn-secondary">Export Excel</button>
        <button id="btn-new-type" class="btn-primary">+ Jenis Tunjangan</button>
      </div>` : ""}
    </div>

    <div class="pg-section-head" style="margin-top:8px;">
      <h2>Jenis Tunjangan</h2>
    </div>
    <div id="type-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <div class="pg-section-head">
      <h2>Atur Nominal per Karyawan</h2>
      <p>Satu tabel untuk semua jenis tunjangan sekaligus — kalau ada jenis tunjangan baru ditambahkan di atas, kolomnya otomatis muncul di sini juga.</p>
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
    ` : ""}
  `;

  if (canEdit) {
    document.getElementById("btn-new-type").addEventListener("click", () => openTypeModal());
    document.getElementById("btn-cancel-type").addEventListener("click", closeTypeModal);
    document.getElementById("form-type").addEventListener("submit", onSubmitType);
    document.getElementById("btn-template").addEventListener("click", () => downloadSheet(true));
    document.getElementById("btn-export").addEventListener("click", () => downloadSheet(false));
    document.getElementById("btn-import").addEventListener("click", () => document.getElementById("import-file").click());
    pickFileThen(document.getElementById("import-file"), onImportFile);
  }

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

  renderTypeTable();
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
// Satu tabel gabungan: baris = karyawan, kolom = tiap jenis tunjangan
// (dibuat dari allowanceTypes). Kalau admin menambah jenis tunjangan baru
// di bagian atas, kolomnya otomatis muncul di sini juga — tidak perlu
// pilih jenis satu-satu lagi.
// -----------------------------------------------------------------------
function renderEmployeeTable() {
  const el = document.getElementById("employee-table");
  if (!allowanceTypes.length) { el.innerHTML = `<p class="muted">Buat jenis tunjangan dulu di atas.</p>`; return; }
  if (!employees.length) { el.innerHTML = `<p class="muted">Belum ada karyawan aktif.</p>`; return; }

  el.innerHTML = `
    <table class="table tbl-fit ${canEdit ? "tbl-sticky-end" : ""}">
      <thead>
        <tr>
          <th>Nama</th>
          <th>Kode</th>
          <th>Grade/Level</th>
          ${allowanceTypes.map(t => `<th>${t.nama}${t.is_active ? "" : " (nonaktif)"}</th>`).join("")}
          ${canEdit ? "<th></th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${employees.map(emp => {
          const gradeLevel = emp.grade ? `${emp.grade} — ${emp.level || "-"}` : "-";

          if (!canEdit) {
            return `
              <tr>
                <td>${emp.full_name}</td>
                <td>${emp.employee_code || "-"}</td>
                <td>${gradeLevel}</td>
                ${allowanceTypes.map(t => {
                  const row = (employeeAllowanceByUser[t.id] || {})[emp.id];
                  return `<td>${row ? `${fmtRupiah(row.nominal)} <span class="badge badge-${row.is_active ? "ok" : "danger"}" style="margin-left:6px;">${row.is_active ? "Aktif" : "Nonaktif"}</span>` : `<span class="muted">-</span>`}</td>`;
                }).join("")}
              </tr>
            `;
          }

          return `
            <tr data-row-user="${emp.id}">
              <td>${emp.full_name}</td>
              <td>${emp.employee_code || "-"}</td>
              <td>${gradeLevel}</td>
              ${allowanceTypes.map(t => {
                const row = (employeeAllowanceByUser[t.id] || {})[emp.id];
                return `
                  <td>
                    <div style="display:flex; flex-direction:column; gap:4px;">
                      <input type="text" inputmode="numeric" class="input-nominal" data-type-id="${t.id}" style="width:130px;" value="${formatRibuan(row ? row.nominal : 0)}">
                      <label class="checkbox-row" style="font-size:0.78rem;"><input type="checkbox" class="chk-active" data-type-id="${t.id}" ${row ? (row.is_active ? "checked" : "") : "checked"}> Aktif</label>
                    </div>
                  </td>
                `;
              }).join("")}
              <td><button class="btn-link btn-save-row" data-id="${emp.id}">Simpan</button></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-save-row").forEach(btn => {
      btn.addEventListener("click", () => saveRowAllowances(btn));
    });
    el.querySelectorAll(".input-nominal").forEach(inp => {
      inp.addEventListener("input", () => {
        inp.value = formatRibuan(parseRibuan(inp.value));
      });
    });
  }
}

async function saveRowAllowances(btn) {
  const userId = btn.dataset.id;
  const tr = btn.closest("tr");

  const payloads = allowanceTypes.map(t => {
    const inputEl = tr.querySelector(`.input-nominal[data-type-id="${t.id}"]`);
    const chkEl = tr.querySelector(`.chk-active[data-type-id="${t.id}"]`);
    return {
      user_id: userId,
      allowance_type_id: t.id,
      nominal: parseRibuan(inputEl.value),
      is_active: chkEl.checked,
    };
  });

  btn.disabled = true;
  try {
    const { error } = await supabase.from("employee_allowances").upsert(payloads, { onConflict: "user_id,allowance_type_id" });
    if (error) throw error;
    toast("Tunjangan tersimpan", "success");
    await loadAll();
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
    btn.disabled = false;
  }
}

// -----------------------------------------------------------------------
// TEMPLATE / EXPORT / IMPORT EXCEL
// Kolom: Kode Karyawan, Nama (info saja), lalu satu kolom per jenis tunjangan
// (nama kolom = nama jenis tunjangan). Template & Export memakai format yang
// sama: template = file berisi nominal saat ini, tinggal diubah lalu diimport.
// Sel nominal KOSONG = tidak diubah. Isi 0 untuk menolkan.
// Status Aktif per tunjangan tidak diubah lewat Excel (tetap atur di tabel).
// -----------------------------------------------------------------------
function downloadSheet(isTemplate) {
  if (!hasXLSX()) { toast("Library Excel belum termuat, coba refresh halaman.", "error"); return; }
  if (!allowanceTypes.length) { toast("Buat jenis tunjangan dulu.", "error"); return; }
  if (!employees.length) { toast("Belum ada karyawan aktif.", "error"); return; }

  const headers = ["Kode Karyawan", "Nama", ...allowanceTypes.map(t => t.nama)];
  const rows = [headers, ...employees.map(emp => [
    emp.employee_code || "",
    emp.full_name,
    ...allowanceTypes.map(t => {
      const row = (employeeAllowanceByUser[t.id] || {})[emp.id];
      return row ? Number(row.nominal) : 0;
    }),
  ])];
  const guide = [
    ["Petunjuk pengisian"],
    ["Karyawan dicocokkan lewat Kode Karyawan. Kolom Nama hanya info, tidak dibaca saat import."],
    ["Isi nominal (angka, tanpa Rp) di kolom tunjangan. Sel kosong = tidak diubah. Isi 0 untuk menolkan."],
    ["Nama kolom tunjangan harus sama dengan Nama Jenis Tunjangan. Kolom yang tidak dikenali dilewati."],
    ["Status Aktif/Nonaktif per tunjangan tidak diubah lewat Excel; atur di tabel Master Tunjangan."],
  ];
  writeWorkbook(
    isTemplate ? "Template_Tunjangan_Karyawan.xlsx" : "Tunjangan_Karyawan.xlsx",
    [{ name: "Data", rows, widths: widthsFor(headers, rows) }, { name: "Petunjuk", rows: guide, widths: [95] }]
  );
}

async function onImportFile(file) {
  if (!hasXLSX()) { toast("Fitur import butuh library XLSX yang belum termuat.", "error"); return; }
  let rows;
  try { rows = await readFirstSheet(file); } catch (err) { toast("File tidak bisa dibaca: " + err.message, "error"); return; }
  if (!rows.length) { toast("File Excel kosong atau format kolom tidak dikenali.", "error"); return; }

  const byCode = new Map(employees.filter(e => e.employee_code).map(e => [cellText(e.employee_code).toLowerCase(), e]));
  const typeCols = allowanceTypes.map(t => ({ type: t, key: normKey(t.nama) }));
  const headerKeys = new Set(rows[0].keys.map(normKey));
  const missingTypes = typeCols.filter(c => !headerKeys.has(c.key)).map(c => c.type.nama);
  if (missingTypes.length === typeCols.length) {
    toast("Tidak ada kolom tunjangan yang dikenali. Pakai Download Template agar nama kolom sesuai.", "error");
    return;
  }

  const payloads = [];
  const errors = [];
  const touchedUsers = new Set();

  rows.forEach(r => {
    const kode = cellText(r.get("Kode Karyawan"));
    if (!kode) { errors.push(`Baris ${r._row}: Kode Karyawan kosong`); return; }
    const emp = byCode.get(kode.toLowerCase());
    if (!emp) { errors.push(`Baris ${r._row}: kode ${kode} tidak ditemukan di karyawan aktif`); return; }

    typeCols.forEach(({ type }) => {
      const raw = r.get(type.nama);
      if (raw === "" || raw == null) return; // kosong = tidak diubah
      const n = cellNumber(raw);
      if (!Number.isFinite(n) || n < 0) { errors.push(`Baris ${r._row} (${kode}): nominal "${type.nama}" bukan angka valid`); return; }
      const old = (employeeAllowanceByUser[type.id] || {})[emp.id];
      if (old && Number(old.nominal) === n) return; // sama, tidak perlu ditulis
      payloads.push({ user_id: emp.id, allowance_type_id: type.id, nominal: n, is_active: old ? old.is_active : true });
      touchedUsers.add(emp.id);
    });
  });

  if (!payloads.length) {
    toast(errors.length ? `Tidak ada yang bisa diimport. ${errors.slice(0, 3).join("; ")}` : "Tidak ada perubahan nominal dibanding data saat ini.", errors.length ? "error" : "success");
    return;
  }

  const ok = await confirmDialog({
    title: "Import Tunjangan",
    message: `${payloads.length} nominal tunjangan untuk ${touchedUsers.size} karyawan akan disimpan.` +
      (missingTypes.length ? `\n\nKolom tidak ada di file (tidak diubah): ${missingTypes.join(", ")}` : "") +
      (errors.length ? `\n\n${errors.length} baris/sel bermasalah (dilewati):\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? "\n…" : ""}` : ""),
    confirmLabel: "Proses Import",
  });
  if (!ok) return;

  try {
    const { error } = await supabase.from("employee_allowances").upsert(payloads, { onConflict: "user_id,allowance_type_id" });
    if (error) throw error;
    toast(`Import selesai: ${payloads.length} nominal tunjangan tersimpan.`, "success");
    await loadAll();
  } catch (err) {
    toast("Gagal import: " + err.message, "error");
  }
}
