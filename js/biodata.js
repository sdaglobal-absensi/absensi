// =====================================================================
// BIODATA PRIBADI & KELUARGA KARYAWAN (modul bersama)
// =====================================================================
// Dipakai oleh dua halaman supaya form-nya tidak ditulis dua kali:
//   - admin-karyawan.js  → Data Karyawan (admin mengisi/mengedit semua field)
//   - employee-profil.js → Profil Saya (karyawan mengisi data sendiri)
//
// File ini SENGAJA tidak meng-import apa pun (tidak ada core.js /
// supabaseClient.js) — objek `supabase` dikirim lewat parameter fungsi,
// jadi modul ini gampang diuji terpisah.
//
// Penyimpanan:
//   - profiles            → jenis_kelamin, agama, tempat_lahir, tanggal_lahir,
//                           pendidikan_terakhir, status_pernikahan, nama_ayah,
//                           nama_ibu, pasangan_* (satu pasangan per karyawan)
//                           + `alamat` yang sekarang berarti Alamat Domisili.
//   - employee_children   → satu baris per anak (nama, tempat/tanggal lahir,
//                           pekerjaan, urutan). Anak pertama, kedua, dst.
//                           ditentukan dari kolom `urutan`.
// =====================================================================

// ---------------------------------------------------------------------
// PILIHAN (value = yang disimpan di database, label = yang tampil)
// ---------------------------------------------------------------------
export const OPT_JENIS_KELAMIN = [
  { value: "laki_laki", label: "Laki-laki" },
  { value: "perempuan", label: "Perempuan" },
];

export const OPT_AGAMA = [
  { value: "islam", label: "Islam" },
  { value: "kristen", label: "Kristen Protestan" },
  { value: "katolik", label: "Katolik" },
  { value: "hindu", label: "Hindu" },
  { value: "buddha", label: "Buddha" },
  { value: "konghucu", label: "Konghucu" },
];

export const OPT_PENDIDIKAN = [
  { value: "sd", label: "SD / Sederajat" },
  { value: "smp", label: "SMP / Sederajat" },
  { value: "sma_smk", label: "SMA / SMK / Sederajat" },
  { value: "d1", label: "D1" },
  { value: "d2", label: "D2" },
  { value: "d3", label: "D3" },
  { value: "d4", label: "D4" },
  { value: "s1", label: "S1" },
  { value: "s2", label: "S2" },
  { value: "s3", label: "S3" },
];

export const OPT_STATUS_NIKAH = [
  { value: "belum_menikah", label: "Belum Menikah" },
  { value: "menikah", label: "Menikah" },
  { value: "cerai_hidup", label: "Cerai Hidup" },
  { value: "cerai_mati", label: "Cerai Mati" },
];

const OPTIONS_BY_KEY = {
  jenis_kelamin: OPT_JENIS_KELAMIN,
  agama: OPT_AGAMA,
  pendidikan_terakhir: OPT_PENDIDIKAN,
  status_pernikahan: OPT_STATUS_NIKAH,
};

// Kolom di tabel profiles yang diurus oleh form biodata.
const PERSONAL_KEYS = ["jenis_kelamin", "agama", "tempat_lahir", "tanggal_lahir", "pendidikan_terakhir"];
const FAMILY_KEYS = [
  "status_pernikahan", "nama_ayah", "nama_ibu",
  "pasangan_nama", "pasangan_tempat_lahir", "pasangan_tanggal_lahir", "pasangan_pekerjaan",
];
const SPOUSE_KEYS = ["pasangan_nama", "pasangan_tempat_lahir", "pasangan_tanggal_lahir", "pasangan_pekerjaan"];

const ORDINAL_ANAK = ["Pertama", "Kedua", "Ketiga", "Keempat", "Kelima", "Keenam", "Ketujuh", "Kedelapan", "Kesembilan", "Kesepuluh"];
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

// ---------------------------------------------------------------------
// FORMAT / TAMPILAN
// ---------------------------------------------------------------------
export function optionLabel(key, value) {
  if (!value) return "-";
  const found = (OPTIONS_BY_KEY[key] || []).find(o => o.value === value);
  return found ? found.label : String(value);
}

// "1990-08-17" → "17 Agustus 1990". Sengaja parse manual (bukan new Date)
// supaya tanggal tidak bergeser sehari gara-gara zona waktu.
export function fmtTanggal(iso) {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${parseInt(m[3], 10)} ${BULAN[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

// Tampilan nilai field profil untuk tabel (Profil Saya & Approval Perubahan Data):
// nilai internal seperti "laki_laki" atau "1990-08-17" diubah jadi teks yang enak dibaca.
export function displayProfileValue(key, value) {
  if (value === null || value === undefined || value === "") return "-";
  if (OPTIONS_BY_KEY[key]) return optionLabel(key, value);
  if (key === "tanggal_lahir" || key === "pasangan_tanggal_lahir") return fmtTanggal(value);
  return String(value);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function optionsHtml(list) {
  return `<option value="">— Pilih —</option>` +
    list.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");
}

function childTitle(index) {
  return `Anak ${ORDINAL_ANAK[index] || "ke-" + (index + 1)}`;
}

// ---------------------------------------------------------------------
// HTML FORM
// ---------------------------------------------------------------------
// Baris-baris field data pribadi (tanpa judul seksi, supaya bisa ditempel
// ke seksi "Data Pribadi" yang sudah ada).
// includeIdentity=true  → jenis kelamin, tempat & tanggal lahir ikut tampil
//                         (dipakai di Data Karyawan oleh admin).
// includeIdentity=false → dilewati, karena di Profil Saya ketiganya mirip
//                         data KTP dan hanya bisa diubah lewat pengajuan
//                         yang perlu approval admin.
export function personalFieldsHtml({ includeIdentity = true } = {}) {
  const max = todayLocalISO();
  if (includeIdentity) {
    return `
      <div class="form-row two-col">
        <label>Jenis Kelamin <select name="jenis_kelamin">${optionsHtml(OPT_JENIS_KELAMIN)}</select></label>
        <label>Agama <select name="agama">${optionsHtml(OPT_AGAMA)}</select></label>
      </div>
      <div class="form-row two-col">
        <label>Tempat Lahir <input name="tempat_lahir"></label>
        <label>Tanggal Lahir <input type="date" name="tanggal_lahir" max="${max}"></label>
      </div>
      <div class="form-row two-col">
        <label>Pendidikan Terakhir <select name="pendidikan_terakhir">${optionsHtml(OPT_PENDIDIKAN)}</select></label>
      </div>
    `;
  }
  return `
    <div class="form-row two-col">
      <label>Pendidikan Terakhir <select name="pendidikan_terakhir">${optionsHtml(OPT_PENDIDIKAN)}</select></label>
      <label>Agama <select name="agama">${optionsHtml(OPT_AGAMA)}</select></label>
    </div>
  `;
}

// Seksi lengkap "Status Pernikahan & Keluarga". Dikembalikan sebagai
// fragmen (tanpa div pembungkus) supaya gaya .form-section-label tetap
// benar. Semua wiring dicari lewat atribut data-role di dalam <form>.
export function familySectionHtml() {
  const max = todayLocalISO();
  return `
    <div class="form-section-label">Status Pernikahan &amp; Keluarga</div>
    <div class="form-row two-col">
      <label>Status Pernikahan <select name="status_pernikahan">${optionsHtml(OPT_STATUS_NIKAH)}</select></label>
    </div>
    <div class="form-row two-col">
      <label>Nama Ayah <input name="nama_ayah"></label>
      <label>Nama Ibu <input name="nama_ibu"></label>
    </div>

    <div data-role="spouse-block" class="hidden">
      <div class="form-subhead">Suami / Istri</div>
      <div class="form-row two-col">
        <label>Nama Suami / Istri <input name="pasangan_nama"></label>
        <label>Pekerjaan <input name="pasangan_pekerjaan"></label>
      </div>
      <div class="form-row two-col">
        <label>Tempat Lahir <input name="pasangan_tempat_lahir"></label>
        <label>Tanggal Lahir <input type="date" name="pasangan_tanggal_lahir" max="${max}"></label>
      </div>
    </div>

    <div class="form-subhead-row">
      <span class="form-subhead" style="margin:0;">Anak</span>
      <button type="button" class="btn-link" data-role="btn-add-child">+ Tambah Anak</button>
    </div>
    <div data-role="children-list"></div>
    <p class="muted small" data-role="children-empty" style="margin:0 0 12px;">Belum ada data anak.</p>
  `;
}

function childRowHtml(child = {}) {
  const max = todayLocalISO();
  return `
    <div class="child-row" data-id="${escapeHtml(child.id || "")}">
      <div class="child-row-head">
        <strong class="child-title"></strong>
        <button type="button" class="btn-link child-remove">Hapus</button>
      </div>
      <div class="form-row two-col">
        <label>Nama <input class="child-nama" value="${escapeHtml(child.nama || "")}" required></label>
        <label>Pekerjaan <input class="child-pekerjaan" value="${escapeHtml(child.pekerjaan || "")}" placeholder="Contoh: Pelajar"></label>
      </div>
      <div class="form-row two-col">
        <label>Tempat Lahir <input class="child-tempat" value="${escapeHtml(child.tempat_lahir || "")}"></label>
        <label>Tanggal Lahir <input type="date" class="child-tanggal" value="${escapeHtml(child.tanggal_lahir || "")}" max="${max}"></label>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// WIRING & ISI FORM
// ---------------------------------------------------------------------
function refreshChildren(form) {
  const rows = form.querySelectorAll(".child-row");
  rows.forEach((row, i) => { row.querySelector(".child-title").textContent = childTitle(i); });
  form.querySelector('[data-role="children-empty"]').classList.toggle("hidden", rows.length > 0);
}

// Tampilkan blok Suami/Istri hanya kalau status = Menikah, dan rapikan
// judul "Anak Pertama/Kedua/…". Panggil ulang setiap kali isi form diganti
// dari luar (form.reset(), atau nilai select diubah lewat kode).
export function syncFamilyForm(form) {
  const status = form.elements["status_pernikahan"]?.value;
  form.querySelector('[data-role="spouse-block"]').classList.toggle("hidden", status !== "menikah");
  refreshChildren(form);
}

export function setChildren(form, children = []) {
  form.querySelector('[data-role="children-list"]').innerHTML = children.map(childRowHtml).join("");
  refreshChildren(form);
}

export function addChildRow(form) {
  const list = form.querySelector('[data-role="children-list"]');
  list.insertAdjacentHTML("beforeend", childRowHtml());
  refreshChildren(form);
  const rows = list.querySelectorAll(".child-row");
  rows[rows.length - 1].querySelector(".child-nama").focus();
}

// Pasang event: ganti status pernikahan, tombol Tambah Anak, tombol Hapus.
// Cukup dipanggil sekali per form (pakai event delegation untuk tombol Hapus).
export function wireFamilyForm(form) {
  form.elements["status_pernikahan"].addEventListener("change", () => syncFamilyForm(form));
  form.querySelector('[data-role="btn-add-child"]').addEventListener("click", () => addChildRow(form));
  form.querySelector('[data-role="children-list"]').addEventListener("click", e => {
    const btn = e.target.closest(".child-remove");
    if (!btn) return;
    btn.closest(".child-row").remove();
    refreshChildren(form);
  });
}

// Isi form dari data profil + daftar anak. Field yang tidak ada di form
// (mis. jenis kelamin di Profil Saya) dilewati begitu saja.
export function fillBiodataForm(form, profile = {}, children = []) {
  [...PERSONAL_KEYS, ...FAMILY_KEYS].forEach(key => {
    const el = form.elements[key];
    if (el) el.value = profile?.[key] ?? "";
  });
  setChildren(form, children);
  syncFamilyForm(form);
}

// ---------------------------------------------------------------------
// BACA FORM → PAYLOAD
// ---------------------------------------------------------------------
// Hanya field yang benar-benar ada di form yang ikut di payload, jadi
// aman dipakai di Profil Saya (yang tidak punya field jenis kelamin dst.)
// tanpa menimpa nilai itu dengan null. Data suami/istri otomatis dikosongkan
// kalau status pernikahan bukan "Menikah".
export function readBiodataForm(form) {
  const payload = {};
  [...PERSONAL_KEYS, ...FAMILY_KEYS].forEach(key => {
    const el = form.elements[key];
    if (el) payload[key] = el.value.trim() || null;
  });
  if (payload.status_pernikahan !== "menikah") {
    SPOUSE_KEYS.forEach(key => { payload[key] = null; });
  }
  return payload;
}

export function readChildren(form) {
  return [...form.querySelectorAll(".child-row")].map((row, i) => ({
    id: row.dataset.id || null,
    urutan: i + 1,
    nama: row.querySelector(".child-nama").value.trim(),
    tempat_lahir: row.querySelector(".child-tempat").value.trim() || null,
    tanggal_lahir: row.querySelector(".child-tanggal").value || null,
    pekerjaan: row.querySelector(".child-pekerjaan").value.trim() || null,
  }));
}

// ---------------------------------------------------------------------
// SUPABASE: baca & simpan data anak
// ---------------------------------------------------------------------
export async function loadChildren(supabase, userId) {
  const { data, error } = await supabase
    .from("employee_children")
    .select("*")
    .eq("user_id", userId)
    .order("urutan", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Sinkronkan daftar anak di form dengan database TANPA hapus-lalu-isi-ulang
// (supaya kalau ada langkah yang gagal, data lama tidak hilang begitu saja):
//   1. baris lama yang masih ada di form → di-update
//   2. baris baru → di-insert
//   3. baris lama yang sudah dihapus dari form → baru dihapus terakhir
export async function saveChildren(supabase, userId, children, originalIds = []) {
  if (children.some(c => !c.nama)) throw new Error("Nama anak wajib diisi.");

  const keep = new Set(children.filter(c => c.id).map(c => c.id));
  const removedIds = originalIds.filter(id => !keep.has(id));
  const existing = children.filter(c => c.id).map(c => ({ ...c, user_id: userId }));
  const fresh = children.filter(c => !c.id).map(({ id, ...rest }) => ({ ...rest, user_id: userId }));

  if (existing.length) {
    const { error } = await supabase.from("employee_children").upsert(existing, { onConflict: "id" });
    if (error) throw error;
  }
  if (fresh.length) {
    const { error } = await supabase.from("employee_children").insert(fresh);
    if (error) throw error;
  }
  if (removedIds.length) {
    const { error } = await supabase.from("employee_children").delete().in("id", removedIds);
    if (error) throw error;
  }
}
