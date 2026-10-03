import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// DOKUMEN SAYA (sisi karyawan) + helper yang dipakai admin-dokumen.js.
// File disimpan di bucket privat `employee-docs`, path:
//   <tenant_id>/<user_id>/<acak>.<ekstensi>
// Karyawan boleh unggah/hapus dokumen pribadinya, kecuali KONTRAK (hanya HR).
// Lihat SQL 012_dokumen_karyawan.sql.
// =======================================================================

export const DOC_TYPE_LABEL = {
  ktp: "KTP", kk: "Kartu Keluarga", npwp: "NPWP", kontrak: "Kontrak Kerja",
  ijazah: "Ijazah", sertifikat: "Sertifikat", bpjs: "BPJS", lainnya: "Lainnya",
};
// Jenis yang boleh diunggah karyawan sendiri (kontrak hanya oleh HR).
export const SELF_TYPES = Object.keys(DOC_TYPE_LABEL).filter(k => k !== "kontrak");

const BUCKET = "employee-docs";
const MAX_BYTES = 10 * 1024 * 1024;

// Sisa hari -> teks + warna badge.
export function expiryBadge(expiresAt) {
  if (!expiresAt) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(expiresAt + "T00:00:00");
  const left = Math.round((d - today) / 86400000);
  if (left < 0) return `<span class="badge badge-danger">Lewat ${-left} hari</span>`;
  if (left === 0) return `<span class="badge badge-danger">Berakhir hari ini</span>`;
  if (left <= 7) return `<span class="badge badge-danger">${left} hari lagi</span>`;
  if (left <= 30) return `<span class="badge badge-warn">${left} hari lagi</span>`;
  return `<span class="badge badge-ok">Berlaku</span>`;
}

// Buka dokumen (URL bertanda tangan 10 menit). Jendela dibuka dulu secara
// sinkron supaya tidak diblokir pop-up blocker.
export async function openDocument(path) {
  const w = window.open("", "_blank");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error || !data?.signedUrl) {
    if (w) w.close();
    toast("Gagal membuka dokumen: " + (error?.message || "tidak ditemukan"), "error");
    return;
  }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}

export function bindDocLinks(root) {
  root.querySelectorAll(".btn-open-doc").forEach(b => b.addEventListener("click", () => openDocument(b.dataset.path)));
}

// Foto diperkecil (sisi terpanjang 2000px, JPEG 0.85); PDF dikirim apa adanya.
async function prepareFile(file) {
  if (file.type === "application/pdf") return { body: file, ext: "pdf", type: "application/pdf" };
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Format harus PDF, JPG, PNG, atau WebP");
  if (typeof createImageBitmap !== "function") {
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    return { body: file, ext, type: file.type };
  }
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob ? { body: blob, ext: "jpg", type: "image/jpeg" } : { body: file, ext: "jpg", type: file.type };
  } catch {
    return { body: file, ext: "jpg", type: file.type };
  }
}

// Unggah file + simpan barisnya. Dipakai karyawan (untuk diri sendiri) dan HR.
export async function uploadDocument({ tenantId, userId, uploaderId, fields, file }) {
  if (!(file instanceof File) || !file.size) throw new Error("File dokumen wajib dipilih");
  if (file.size > MAX_BYTES * 2) throw new Error("Ukuran file maksimal 10 MB");
  const { body, ext, type } = await prepareFile(file);
  if (body.size > MAX_BYTES) throw new Error("Ukuran file maksimal 10 MB");

  const path = `${tenantId}/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: eUp } = await supabase.storage.from(BUCKET).upload(path, body, { contentType: type, upsert: false });
  if (eUp) throw eUp;

  const { error } = await supabase.from("employee_documents").insert({
    user_id: userId,
    uploaded_by: uploaderId,
    doc_type: fields.doc_type,
    title: fields.title,
    doc_number: fields.doc_number || null,
    issued_date: fields.issued_date || null,
    expires_at: fields.expires_at || null,
    notes: fields.notes || null,
    file_path: path,
    file_name: file.name.slice(0, 150),
  });
  if (error) {
    // Rapikan file yatim kalau simpan baris gagal.
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
}

// Hapus baris, lalu filenya.
export async function deleteDocument(doc) {
  const { error } = await supabase.from("employee_documents").delete().eq("id", doc.id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([doc.file_path]);
}

// Kolom isian metadata (dipakai kedua modal).
export function docFieldsHtml(types) {
  return `
    <div class="form-row"><label>Jenis dokumen
      <select name="doc_type" required>
        ${types.map(k => `<option value="${k}">${DOC_TYPE_LABEL[k]}</option>`).join("")}
      </select></label></div>
    <div class="form-row"><label>Nama / judul dokumen
      <input name="title" required maxlength="150" placeholder="Contoh: Kontrak PKWT ke-2"></label></div>
    <div class="form-row"><label>Nomor dokumen (opsional) <input name="doc_number" maxlength="80"></label></div>
    <div class="form-row"><label>Tanggal terbit / mulai (opsional) <input type="date" name="issued_date"></label></div>
    <div class="form-row"><label><span id="dk-exp-label">Berlaku sampai (opsional)</span>
      <input type="date" name="expires_at"></label></div>
    <p class="muted small" id="dk-exp-hint" style="margin:0 0 8px;">Kosongkan kalau dokumen tidak punya batas waktu. Kalau diisi, HR diingatkan 30 dan 7 hari sebelumnya.</p>
    <div class="form-row"><label>Catatan (opsional) <textarea name="notes" rows="2" maxlength="500"></textarea></label></div>
    <div class="form-row"><label>File (PDF atau foto, maks. 10 MB)
      <input type="file" name="file" accept="application/pdf,image/*" required></label></div>`;
}

// Untuk jenis Kontrak, ubah label tanggal supaya jelas artinya.
export function wireTypeHint(form) {
  const sync = () => {
    const kontrak = form.doc_type.value === "kontrak";
    document.getElementById("dk-exp-label").textContent = kontrak
      ? "Kontrak berakhir pada (kosongkan jika karyawan tetap / PKWTT)"
      : "Berlaku sampai (opsional)";
  };
  form.doc_type.addEventListener("change", sync);
  sync();
}

export function readFields(form) {
  const fd = new FormData(form);
  return {
    doc_type: fd.get("doc_type"),
    title: String(fd.get("title") || "").trim(),
    doc_number: String(fd.get("doc_number") || "").trim(),
    issued_date: fd.get("issued_date"),
    expires_at: fd.get("expires_at"),
    notes: String(fd.get("notes") || "").trim(),
    file: fd.get("file"),
  };
}

// ---------------------------------------------------------------------
let me = null;
let tenantId = null;

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Dokumen Saya</h1>
        <p class="muted">Simpan KTP, ijazah, sertifikat, dan dokumen pribadi lainnya. Kontrak kerja diunggah oleh HR.</p>
      </div>
      <button id="btn-new-doc" class="btn-primary">+ Unggah Dokumen</button>
    </div>
    <div id="doc-list"><p class="muted">Memuat…</p></div>

    <div id="modal-doc" class="modal hidden">
      <div class="modal-box">
        <h3>Unggah Dokumen</h3>
        <form id="form-doc">
          ${docFieldsHtml(SELF_TYPES)}
          <div class="modal-actions">
            <button type="button" id="btn-cancel-doc" class="btn-secondary">Batal</button>
            <button type="submit" id="btn-save-doc" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
  `;
  const form = document.getElementById("form-doc");
  wireTypeHint(form);
  document.getElementById("btn-new-doc").addEventListener("click", () => {
    form.reset(); wireTypeHint(form);
    document.getElementById("modal-doc").classList.remove("hidden");
  });
  document.getElementById("btn-cancel-doc").addEventListener("click", closeModal);
  form.addEventListener("submit", onSubmit);
  await load();
}

function closeModal() { document.getElementById("modal-doc").classList.add("hidden"); }

async function load() {
  const el = document.getElementById("doc-list");
  const { data, error } = await supabase.from("employee_documents")
    .select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(200);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada dokumen.</p></div>`; return; }

  el.innerHTML = data.map(d => {
    const canDelete = d.doc_type !== "kontrak" && d.uploaded_by === me.id;
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-muted">${DOC_TYPE_LABEL[d.doc_type] || esc(d.doc_type)}</span>
          <strong>${esc(d.title)}</strong>
          ${expiryBadge(d.expires_at)}
        </div>
        <div class="muted small">
          ${d.doc_number ? `No. ${esc(d.doc_number)} · ` : ""}
          ${d.issued_date ? `Terbit ${fmtDate(d.issued_date)} · ` : ""}
          ${d.expires_at ? `Berlaku sampai ${fmtDate(d.expires_at)}` : "Tanpa batas waktu"}
        </div>
        ${d.notes ? `<div class="muted" style="white-space:pre-line; margin-top:4px;">${esc(d.notes)}</div>` : ""}
        <div style="margin-top:8px; display:flex; gap:12px;">
          <button class="btn-link btn-open-doc" data-path="${esc(d.file_path)}">📎 Buka file</button>
          ${canDelete ? `<button class="btn-link btn-del-doc" data-id="${d.id}" style="color:var(--danger,#dc2626);">Hapus</button>` : ""}
        </div>
      </div>`;
  }).join("");

  bindDocLinks(el);
  el.querySelectorAll(".btn-del-doc").forEach(b => b.addEventListener("click", () => {
    const doc = data.find(x => x.id === b.dataset.id);
    if (doc) removeDoc(doc);
  }));
}

async function onSubmit(e) {
  e.preventDefault();
  const f = readFields(e.target);
  if (!f.title) { toast("Judul dokumen wajib diisi", "error"); return; }
  if (f.issued_date && f.expires_at && f.expires_at < f.issued_date) {
    toast("Tanggal berakhir tidak boleh sebelum tanggal terbit", "error"); return;
  }
  const btn = document.getElementById("btn-save-doc");
  btn.disabled = true;
  try {
    if (!tenantId) {
      const { data: prof, error } = await supabase.from("profiles").select("tenant_id").eq("id", me.id).single();
      if (error || !prof?.tenant_id) throw new Error("Profil usaha tidak ditemukan");
      tenantId = prof.tenant_id;
    }
    await uploadDocument({ tenantId, userId: me.id, uploaderId: me.id, fields: f, file: f.file });
    toast("Dokumen tersimpan", "success");
    closeModal();
    await load();
  } catch (err) {
    toast("Gagal menyimpan: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function removeDoc(doc) {
  const ok = await confirmDialog({ title: "Hapus dokumen?", message: `"${doc.title}" akan dihapus permanen.`, confirmLabel: "Hapus", confirmClass: "btn-danger" });
  if (!ok) return;
  try {
    await deleteDocument(doc);
    toast("Dokumen dihapus", "success");
    await load();
  } catch (err) {
    toast("Gagal menghapus: " + (err.message || err), "error");
  }
}
