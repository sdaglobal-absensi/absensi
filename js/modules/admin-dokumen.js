import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";
import {
  DOC_TYPE_LABEL, expiryBadge, bindDocLinks, uploadDocument, deleteDocument,
  docFieldsHtml, wireTypeHint, readFields,
} from "./employee-dokumen.js";

// =======================================================================
// DOKUMEN KARYAWAN (HR). Simpan dokumen semua karyawan dan pantau yang
// segera berakhir (kontrak PKWT, sertifikat, dst). Saat halaman dibuka,
// server memindai dokumen yang akan habis dan mengirim notifikasi lonceng
// ke pemegang menu ini (H-30, H-7, dan saat lewat) — tanpa perlu cron.
// Lihat SQL 012_dokumen_karyawan.sql.
// =======================================================================

let me = null;
let tenantId = null;
let employees = [];
let docs = [];
let typeFilter = "";
let searchText = "";

export async function render(container, user) {
  me = user;
  typeFilter = "";
  searchText = "";
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Dokumen Karyawan</h1>
        <p class="muted">Arsip KTP, kontrak, ijazah, sertifikat, dan lainnya. Dokumen yang segera berakhir diingatkan otomatis.</p>
      </div>
      <button id="btn-new-doc" class="btn-primary">+ Unggah Dokumen</button>
    </div>

    <div id="expiring-box"></div>

    <div class="card" style="margin-bottom:12px; display:flex; gap:8px; flex-wrap:wrap;">
      <input id="dk-search" type="search" placeholder="Cari nama karyawan / judul dokumen" style="flex:1; min-width:200px;">
      <select id="dk-type" aria-label="Filter jenis dokumen">
        <option value="">Semua jenis</option>
        ${Object.entries(DOC_TYPE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
      </select>
    </div>
    <div id="doc-admin-list"><p class="muted">Memuat…</p></div>

    <div id="modal-doc" class="modal hidden">
      <div class="modal-box">
        <h3>Unggah Dokumen Karyawan</h3>
        <form id="form-doc">
          <div class="form-row"><label>Karyawan
            <select name="user_id" id="dk-employee" required><option value="">Memuat…</option></select></label></div>
          ${docFieldsHtml(Object.keys(DOC_TYPE_LABEL))}
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
  document.getElementById("btn-new-doc").addEventListener("click", openModal);
  document.getElementById("btn-cancel-doc").addEventListener("click", closeModal);
  form.addEventListener("submit", onSubmit);
  document.getElementById("dk-search").addEventListener("input", e => { searchText = e.target.value.trim().toLowerCase(); renderList(); });
  document.getElementById("dk-type").addEventListener("change", e => { typeFilter = e.target.value; renderList(); });

  // Kirim notifikasi pengingat (sekali per tahap per dokumen), lalu muat data.
  supabase.rpc("docs_expiry_scan").then(() => {}, () => {});
  await Promise.all([loadEmployees(), loadDocs()]);
  await loadExpiring();
}

async function loadEmployees() {
  const { data, error } = await supabase.from("profiles")
    .select("id, full_name, employee_code, tenant_id, jenis_hubungan_kerja")
    .eq("is_active", true).order("full_name").limit(2000);
  if (error) { toast("Gagal memuat daftar karyawan: " + error.message, "error"); return; }
  employees = data || [];
  tenantId = employees.find(x => x.tenant_id)?.tenant_id || null;
  const sel = document.getElementById("dk-employee");
  if (sel) {
    sel.innerHTML = `<option value="">Pilih karyawan…</option>` + employees.map(p =>
      `<option value="${p.id}">${esc(p.full_name)}${p.employee_code ? " (" + esc(p.employee_code) + ")" : ""}</option>`).join("");
  }
}

async function loadDocs() {
  const el = document.getElementById("doc-admin-list");
  const { data, error } = await supabase.from("employee_documents")
    .select("*, profiles!employee_documents_user_id_fkey(full_name, employee_code, jenis_hubungan_kerja)")
    .order("created_at", { ascending: false }).limit(1000);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  docs = data || [];
  renderList();
}

async function loadExpiring() {
  const box = document.getElementById("expiring-box");
  const { data, error } = await supabase.rpc("documents_expiring", { p_days: 30 });
  if (error || !data?.length) {
    box.innerHTML = error ? "" : `<div class="card" style="margin-bottom:12px;"><span class="badge badge-ok">Aman</span> <span class="muted">Tidak ada dokumen atau kontrak yang berakhir dalam 30 hari.</span></div>`;
    return;
  }
  const nameOf = id => employees.find(p => p.id === id)?.full_name || "-";
  const jenisOf = id => employees.find(p => p.id === id)?.jenis_hubungan_kerja;
  box.innerHTML = `
    <div class="card" style="margin-bottom:12px; border-left:4px solid var(--danger,#dc2626);">
      <strong>Segera berakhir (${data.length})</strong>
      <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
        ${data.map(r => `
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            ${expiryBadge(r.expires_at)}
            <strong>${esc(nameOf(r.user_id))}</strong>
            <span class="muted small">${DOC_TYPE_LABEL[r.doc_type] || esc(r.doc_type)}${jenisOf(r.user_id) === "pkwt" && r.doc_type === "kontrak" ? " (PKWT)" : ""} · ${esc(r.title)} · ${fmtDate(r.expires_at)}</span>
          </div>`).join("")}
      </div>
      <p class="muted small" style="margin:8px 0 0;">Sudah diperpanjang? Unggah kontrak/dokumen baru dengan tanggal berakhir yang lebih akhir — pengingat lama otomatis hilang.</p>
    </div>`;
}

function renderList() {
  const el = document.getElementById("doc-admin-list");
  const rows = docs.filter(d => {
    if (typeFilter && d.doc_type !== typeFilter) return false;
    if (!searchText) return true;
    const p = d.profiles || {};
    return [p.full_name, p.employee_code, d.title, d.doc_number].join(" ").toLowerCase().includes(searchText);
  });
  if (!rows.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Tidak ada dokumen.</p></div>`; return; }

  el.innerHTML = rows.slice(0, 300).map(d => {
    const p = d.profiles || {};
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <strong>${esc(p.full_name || "-")}</strong>
          <span class="muted small">${esc(p.employee_code || "")}</span>
          <span class="badge badge-muted">${DOC_TYPE_LABEL[d.doc_type] || esc(d.doc_type)}</span>
          ${expiryBadge(d.expires_at)}
        </div>
        <div>${esc(d.title)}</div>
        <div class="muted small">
          ${d.doc_number ? `No. ${esc(d.doc_number)} · ` : ""}
          ${d.issued_date ? `Terbit ${fmtDate(d.issued_date)} · ` : ""}
          ${d.expires_at ? `Berakhir ${fmtDate(d.expires_at)}` : "Tanpa batas waktu"}
        </div>
        ${d.notes ? `<div class="muted small" style="white-space:pre-line; margin-top:4px;">${esc(d.notes)}</div>` : ""}
        <div style="margin-top:8px; display:flex; gap:12px;">
          <button class="btn-link btn-open-doc" data-path="${esc(d.file_path)}">📎 Buka file</button>
          <button class="btn-link btn-del-doc" data-id="${d.id}" style="color:var(--danger,#dc2626);">Hapus</button>
        </div>
      </div>`;
  }).join("") + (rows.length > 300 ? `<p class="muted small">Menampilkan 300 pertama. Persempit dengan pencarian.</p>` : "");

  bindDocLinks(el);
  el.querySelectorAll(".btn-del-doc").forEach(b => b.addEventListener("click", () => {
    const doc = docs.find(x => x.id === b.dataset.id);
    if (doc) removeDoc(doc);
  }));
}

function openModal() {
  const form = document.getElementById("form-doc");
  form.reset();
  wireTypeHint(form);
  document.getElementById("modal-doc").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal-doc").classList.add("hidden"); }

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const userId = form.user_id.value;
  const f = readFields(form);
  if (!userId) { toast("Pilih karyawan dulu", "error"); return; }
  if (!f.title) { toast("Judul dokumen wajib diisi", "error"); return; }
  if (f.issued_date && f.expires_at && f.expires_at < f.issued_date) {
    toast("Tanggal berakhir tidak boleh sebelum tanggal terbit", "error"); return;
  }
  if (!tenantId) { toast("Profil usaha tidak ditemukan", "error"); return; }

  const btn = document.getElementById("btn-save-doc");
  btn.disabled = true;
  try {
    await uploadDocument({ tenantId, userId, uploaderId: me.id, fields: f, file: f.file });
    toast("Dokumen tersimpan", "success");
    closeModal();
    supabase.rpc("docs_expiry_scan").then(() => {}, () => {});
    await loadDocs();
    await loadExpiring();
  } catch (err) {
    toast("Gagal menyimpan: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function removeDoc(doc) {
  const ok = await confirmDialog({
    title: "Hapus dokumen?",
    message: `"${doc.title}" milik ${doc.profiles?.full_name || "karyawan"} akan dihapus permanen.`,
    confirmLabel: "Hapus", confirmClass: "btn-danger",
  });
  if (!ok) return;
  try {
    await deleteDocument(doc);
    toast("Dokumen dihapus", "success");
    await loadDocs();
    await loadExpiring();
  } catch (err) {
    toast("Gagal menghapus: " + (err.message || err), "error");
  }
}
