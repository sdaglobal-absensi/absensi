import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, fmtRupiah, confirmDialog, todayISO } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// REIMBURSEMENT / KLAIM BIAYA (sisi karyawan).
// Ajukan klaim + foto nota -> atasan menyetujui (rantai approval unit).
// Setelah DISETUJUI, nominalnya masuk sebagai tambahan di slip gaji pada
// periode pembayaran yang ditetapkan server (lihat SQL 011 & admin-slip-gaji.js).
// Foto nota disimpan di bucket privat `expense-receipts`.
// =======================================================================

export const CATEGORY_LABEL = {
  transport: "Transportasi", makan: "Makan / Konsumsi", akomodasi: "Akomodasi / Hotel",
  bbm_parkir: "BBM / Tol / Parkir", perlengkapan: "Perlengkapan Kerja", komunikasi: "Pulsa / Internet", lainnya: "Lainnya",
};
export const CLAIM_STATUS = {
  pending: ["warn", "Menunggu"],
  approved: ["ok", "Disetujui"],
  paid: ["ok", "Sudah Dibayar"],
  rejected: ["danger", "Ditolak"],
  cancelled: ["muted", "Dibatalkan"],
};

const BUCKET = "expense-receipts";
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export function periodText(p) {
  if (!p) return "-";
  const [y, m] = String(p).split("-");
  return `${BULAN[Number(m) - 1] || m} ${y}`;
}

// Buka foto nota (URL bertanda tangan 10 menit). Jendela dibuka dulu secara
// sinkron supaya tidak diblokir pop-up blocker.
export async function openReceipt(path) {
  const w = window.open("", "_blank");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error || !data?.signedUrl) {
    if (w) w.close();
    toast("Gagal membuka nota: " + (error?.message || "tidak ditemukan"), "error");
    return;
  }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}

export function bindReceiptLinks(root) {
  root.querySelectorAll(".btn-receipt").forEach(b => b.addEventListener("click", () => openReceipt(b.dataset.path)));
}

// Perkecil foto: sisi terpanjang 1600px, JPEG 0.82 (nota perlu tetap terbaca).
async function shrink(file) {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.82));
    return blob || file;
  } catch { return file; }
}

let me = null;

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Reimbursement / Klaim Biaya</h1>
        <p class="muted">Unggah foto nota. Kalau disetujui atasan, nominalnya ditambahkan ke slip gaji.</p>
      </div>
      <button id="btn-new" class="btn-primary">+ Ajukan Klaim</button>
    </div>
    <div id="claim-list"><p class="muted">Memuat…</p></div>

    <div id="modal-claim" class="modal hidden">
      <div class="modal-box">
        <h3>Klaim Biaya</h3>
        <form id="form-claim">
          <div class="form-row"><label>Jenis biaya
            <select name="category" required>
              ${Object.entries(CATEGORY_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
            </select></label></div>
          <div class="form-row"><label>Tanggal biaya <input type="date" name="date" required></label></div>
          <div class="form-row"><label>Nominal (Rp) <input type="number" name="amount" min="1000" max="100000000" step="1" required></label></div>
          <div class="form-row"><label>Keterangan <textarea name="description" rows="3" required maxlength="500" placeholder="Contoh: Taksi ke klien PT Maju Jaya"></textarea></label></div>
          <div class="form-row"><label>Foto nota <input type="file" name="receipt" accept="image/*" required></label></div>
          <p class="muted small" style="margin:0 0 8px;">Maksimal 90 hari ke belakang. Pastikan nominal di nota terbaca jelas.</p>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" id="btn-save" class="btn-primary">Kirim Klaim</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("btn-new").addEventListener("click", openModal);
  document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
  document.getElementById("form-claim").addEventListener("submit", onSubmit);
  await load();
}

async function load() {
  const el = document.getElementById("claim-list");
  const { data, error } = await supabase.from("expense_claims")
    .select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(100);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada klaim.</p></div>`; return; }

  const pendingIds = data.filter(r => r.status === "pending").map(r => r.id);
  const stepsBy = {};
  if (pendingIds.length) {
    const { data: steps } = await supabase.from("expense_approvals")
      .select("claim_id, step_order, status, approver_names").in("claim_id", pendingIds).order("step_order");
    (steps || []).forEach(s => { (stepsBy[s.claim_id] ||= []).push(s); });
  }

  el.innerHTML = data.map(r => {
    const [tone, label] = CLAIM_STATUS[r.status] || ["muted", r.status];
    const waiting = (stepsBy[r.id] || []).find(s => s.status === "pending");
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${fmtRupiah(r.amount)}</strong>
          <span class="muted small">${CATEGORY_LABEL[r.category] || r.category} · ${fmtDate(r.expense_date)}</span>
        </div>
        <div class="muted" style="white-space:pre-line;">${esc(r.description)}</div>
        <div style="margin-top:6px;"><button class="btn-link btn-receipt" data-path="${esc(r.receipt_path)}">📎 Lihat nota</button></div>
        ${waiting ? `<div class="muted small" style="margin-top:6px;">Menunggu persetujuan: ${esc(waiting.approver_names || "-")}</div>` : ""}
        ${r.status === "approved" ? `<div class="small" style="margin-top:6px;">Akan dibayar lewat slip gaji periode ${periodText(r.pay_period)}</div>` : ""}
        ${r.status === "paid" ? `<div class="small" style="margin-top:6px;">Sudah masuk slip gaji periode ${periodText(r.pay_period)}</div>` : ""}
        ${r.review_notes && !["approved", "paid"].includes(r.status) ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${r.status === "pending" ? `<div style="margin-top:8px;"><button class="btn-link btn-cancel-req" data-id="${r.id}" style="color:var(--danger,#dc2626);">Batalkan</button></div>` : ""}
      </div>`;
  }).join("");

  bindReceiptLinks(el);
  el.querySelectorAll(".btn-cancel-req").forEach(b => b.addEventListener("click", () => cancelReq(b.dataset.id)));
}

function openModal() {
  const form = document.getElementById("form-claim");
  form.reset();
  form.date.value = todayISO();
  form.date.max = todayISO();
  document.getElementById("modal-claim").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal-claim").classList.add("hidden"); }

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const amount = Math.trunc(Number(fd.get("amount")));
  const file = fd.get("receipt");
  if (!(amount >= 1000)) { toast("Nominal minimal Rp 1.000", "error"); return; }
  if (!(file instanceof File) || !file.size) { toast("Foto nota wajib diunggah", "error"); return; }

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  let path = null;
  try {
    const { data: prof, error: eProf } = await supabase.from("profiles").select("tenant_id").eq("id", me.id).single();
    if (eProf || !prof?.tenant_id) throw new Error("Profil usaha tidak ditemukan");
    const body = await shrink(file);
    if (body.size > 5 * 1024 * 1024) throw new Error("Ukuran foto maksimal 5 MB");
    path = `${prof.tenant_id}/${me.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error: eUp } = await supabase.storage.from(BUCKET).upload(path, body, { contentType: "image/jpeg", upsert: false });
    if (eUp) throw eUp;

    const { error } = await supabase.from("expense_claims").insert({
      user_id: me.id,
      category: fd.get("category"),
      expense_date: fd.get("date"),
      amount,
      description: String(fd.get("description")).trim(),
      receipt_path: path,
    });
    if (error) throw error;
    toast("Klaim terkirim ke atasan", "success");
    closeModal();
    await load();
  } catch (err) {
    toast("Gagal mengirim: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function cancelReq(id) {
  const ok = await confirmDialog({ title: "Batalkan klaim?", message: "Klaim ini akan dibatalkan.", confirmLabel: "Batalkan", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.rpc("cancel_expense", { p_claim: id });
  if (error) { toast("Gagal membatalkan: " + error.message, "error"); return; }
  toast("Klaim dibatalkan", "success");
  await load();
}
