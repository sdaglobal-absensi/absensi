import { supabase } from "../supabaseClient.js";
import { toast, fmtDateTime, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// KELOLA PENGUMUMAN (admin) — buat, ubah, nonaktifkan, hapus pengumuman.
// Target: semua karyawan, atau satu unit (beserta unit di bawahnya).
// Pengumuman BARU (atau yang diaktifkan kembali) otomatis menjadi notifikasi
// lonceng ke semua penerima lewat trigger database (008_pengumuman.sql);
// mengedit isi pengumuman yang sudah aktif TIDAK mengirim notifikasi lagi.
// Siapa boleh membuka halaman ini ditentukan menu 'pengumuman-kelola'
// (Pengaturan Sistem) dan dikunci lagi oleh RLS di server.
// =======================================================================

let units = [];
let rows = [];
let readCounts = {};

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Kelola Pengumuman</h1>
        <p class="muted">Siarkan info internal ke semua karyawan atau ke satu unit. Karyawan menerima notifikasi di lonceng.</p>
      </div>
      <button id="btn-new" class="btn-primary">+ Buat Pengumuman</button>
    </div>
    <div id="ann-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <div id="modal-ann" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Buat Pengumuman</h3>
        <form id="form-ann">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Judul <input name="title" required maxlength="150" placeholder="Contoh: Libur Bersama Idul Fitri"></label>
          </div>
          <div class="form-row">
            <label>Isi Pengumuman <textarea name="body" rows="6" required maxlength="5000" placeholder="Tulis isi pengumuman…"></textarea></label>
          </div>
          <div class="form-row">
            <label>Ditujukan ke
              <select name="target">
                <option value="semua">Semua karyawan</option>
                <option value="unit">Satu unit (termasuk unit di bawahnya)</option>
              </select>
            </label>
          </div>
          <div class="form-row hidden" id="row-unit">
            <label>Unit <select name="unit_id"></select></label>
          </div>
          <div class="form-row">
            <label>Berlaku sampai (opsional) <input type="date" name="expires"></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_pinned"> 📌 Sematkan di atas (penting)</label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif (tampil ke karyawan)</label>
          </div>
          <p class="muted small" id="notify-hint" style="margin:0 0 8px;">Saat disimpan, penerima langsung mendapat notifikasi.</p>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" id="btn-save" class="btn-primary">Simpan & Kirim</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("btn-new").addEventListener("click", () => openModal());
  document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
  document.getElementById("form-ann").addEventListener("submit", onSubmit);
  document.querySelector("#form-ann [name=target]").addEventListener("change", syncTarget);

  await loadUnits();
  await loadTable();
}

async function loadUnits() {
  const { data } = await supabase.from("org_units").select("id, nama, tipe, is_active").eq("is_active", true).order("nama");
  units = data || [];
  const sel = document.querySelector("#form-ann [name=unit_id]");
  sel.innerHTML = units.length
    ? units.map(u => `<option value="${u.id}">${esc(u.nama)} (${esc(u.tipe)})</option>`).join("")
    : `<option value="">Belum ada unit — buat di Struktur Organisasi</option>`;
}

function unitName(id) {
  return units.find(u => u.id === id)?.nama || "Unit (nonaktif/terhapus)";
}

function syncTarget() {
  const isUnit = document.querySelector("#form-ann [name=target]").value === "unit";
  document.getElementById("row-unit").classList.toggle("hidden", !isUnit);
}

async function loadTable() {
  const el = document.getElementById("ann-table");
  const { data, error } = await supabase.from("announcements")
    .select("*").order("is_pinned", { ascending: false }).order("created_at", { ascending: false }).limit(200);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${esc(error.message)}</p>`; return; }
  rows = data || [];
  if (!rows.length) { el.innerHTML = `<p class="muted">Belum ada pengumuman. Klik “Buat Pengumuman”.</p>`; return; }

  readCounts = {};
  const { data: reads } = await supabase.from("announcement_reads")
    .select("announcement_id").in("announcement_id", rows.map(r => r.id)).limit(10000);
  (reads || []).forEach(r => { readCounts[r.announcement_id] = (readCounts[r.announcement_id] || 0) + 1; });

  const now = Date.now();
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Pengumuman</th><th>Tujuan</th><th>Dibuat</th><th>Dibaca</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => {
          const expired = r.expires_at && new Date(r.expires_at).getTime() <= now;
          const status = !r.is_active ? ["muted", "Nonaktif"] : expired ? ["danger", "Kedaluwarsa"] : ["ok", "Aktif"];
          return `
          <tr>
            <td><strong>${r.is_pinned ? "📌 " : ""}${esc(r.title)}</strong><div class="muted small" style="max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.body)}</div></td>
            <td>${r.target_type === "unit" ? esc(unitName(r.target_unit_id)) : "Semua karyawan"}</td>
            <td>${fmtDateTime(r.created_at)}</td>
            <td>${readCounts[r.id] || 0} orang</td>
            <td><span class="badge badge-${status[0]}">${status[1]}</span></td>
            <td style="white-space:nowrap;">
              <button class="btn-link btn-edit" data-id="${r.id}">Edit</button>
              <button class="btn-link btn-toggle-active" data-id="${r.id}">${r.is_active ? "Nonaktifkan" : "Aktifkan"}</button>
              <button class="btn-link btn-del" data-id="${r.id}" style="color:var(--danger,#dc2626);">Hapus</button>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;

  el.querySelectorAll(".btn-edit").forEach(b => b.addEventListener("click", () => openModal(rows.find(r => r.id === b.dataset.id))));
  el.querySelectorAll(".btn-toggle-active").forEach(b => b.addEventListener("click", () => toggleActive(rows.find(r => r.id === b.dataset.id))));
  el.querySelectorAll(".btn-del").forEach(b => b.addEventListener("click", () => remove(rows.find(r => r.id === b.dataset.id))));
}

function openModal(existing = null) {
  const form = document.getElementById("form-ann");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Pengumuman" : "Buat Pengumuman";
  document.getElementById("btn-save").textContent = existing ? "Simpan" : "Simpan & Kirim";
  document.getElementById("notify-hint").textContent = existing
    ? "Mengubah isi tidak mengirim notifikasi ulang (kecuali pengumuman diaktifkan kembali)."
    : "Saat disimpan, penerima langsung mendapat notifikasi.";

  if (existing) {
    form.id.value = existing.id;
    form.title.value = existing.title;
    form.body.value = existing.body;
    form.elements.target.value = existing.target_type;
    if (existing.target_unit_id) form.unit_id.value = existing.target_unit_id;
    form.expires.value = existing.expires_at ? existing.expires_at.slice(0, 10) : "";
    form.is_pinned.checked = existing.is_pinned;
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  syncTarget();
  document.getElementById("modal-ann").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-ann").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const id = fd.get("id");
  const isUnit = fd.get("target") === "unit";
  if (isUnit && !fd.get("unit_id")) { toast("Pilih unit tujuan dulu", "error"); return; }

  // Kedaluwarsa = akhir hari yang dipilih (waktu setempat browser).
  const expires = fd.get("expires");
  const payload = {
    title: String(fd.get("title")).trim(),
    body: String(fd.get("body")).trim(),
    target_type: isUnit ? "unit" : "semua",
    target_unit_id: isUnit ? fd.get("unit_id") : null,
    is_pinned: fd.get("is_pinned") === "on",
    is_active: fd.get("is_active") === "on",
    expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
  };

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  try {
    const { error } = id
      ? await supabase.from("announcements").update(payload).eq("id", id)
      : await supabase.from("announcements").insert(payload);
    if (error) throw error;
    toast(id ? "Pengumuman diperbarui" : "Pengumuman terkirim", "success");
    closeModal();
    await loadTable();
  } catch (err) {
    toast("Gagal menyimpan: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function toggleActive(r) {
  if (!r) return;
  const { error } = await supabase.from("announcements").update({ is_active: !r.is_active }).eq("id", r.id);
  if (error) { toast("Gagal mengubah status: " + error.message, "error"); return; }
  toast(r.is_active ? "Pengumuman dinonaktifkan" : "Pengumuman diaktifkan & dikirim ulang", "success");
  await loadTable();
}

async function remove(r) {
  if (!r) return;
  const ok = await confirmDialog({
    title: "Hapus pengumuman?",
    message: `“${r.title}” akan dihapus permanen beserta catatan siapa yang sudah membaca. Untuk menyembunyikan saja, gunakan Nonaktifkan.`,
    confirmLabel: "Hapus",
    confirmClass: "btn-danger",
  });
  if (!ok) return;
  const { error } = await supabase.from("announcements").delete().eq("id", r.id);
  if (error) { toast("Gagal menghapus: " + error.message, "error"); return; }
  toast("Pengumuman dihapus", "success");
  await loadTable();
}
