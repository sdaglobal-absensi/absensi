import { supabase } from "../supabaseClient.js";
import { toast, fmtDateTime, fmtRupiah, confirmDialog, todayISO } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// KASBON / PINJAMAN KARYAWAN (sisi karyawan).
// Ajukan nominal + tenor -> atasan menyetujui (rantai approval unit).
// Setelah DISETUJUI, server membuat jadwal cicilan; slip gaji tiap periode
// otomatis memotong cicilannya (lihat admin-slip-gaji.js & SQL 010).
// =======================================================================

export const LOAN_STATUS = {
  pending: ["warn", "Menunggu"],
  approved: ["ok", "Berjalan"],
  lunas: ["ok", "Lunas"],
  rejected: ["danger", "Ditolak"],
  cancelled: ["muted", "Dibatalkan"],
  stopped: ["muted", "Dihentikan"],
};

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export function periodText(p) {
  const [y, m] = String(p).split("-");
  return `${BULAN[Number(m) - 1] || m} ${y}`;
}
function nextPeriod() {
  const d = new Date(todayISO() + "T00:00:00");
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

let me = null;

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Kasbon / Pinjaman</h1>
        <p class="muted">Ajukan pinjaman. Kalau disetujui, cicilannya otomatis dipotong dari slip gaji tiap bulan.</p>
      </div>
      <button id="btn-new" class="btn-primary">+ Ajukan Kasbon</button>
    </div>
    <div id="loan-list"><p class="muted">Memuat…</p></div>

    <div id="modal-loan" class="modal hidden">
      <div class="modal-box">
        <h3>Pengajuan Kasbon</h3>
        <form id="form-loan">
          <div class="form-row"><label>Nominal pinjaman (Rp) <input type="number" name="amount" min="10000" max="1000000000" step="1" required placeholder="Contoh: 2000000"></label></div>
          <div class="form-row"><label>Lama cicilan (bulan) <input type="number" name="tenor" min="1" max="24" step="1" value="3" required></label></div>
          <div class="form-row"><label>Mulai dipotong dari periode gaji <input type="month" name="start" required></label></div>
          <div class="form-row"><label>Keperluan <textarea name="purpose" rows="3" required maxlength="500" placeholder="Jelaskan keperluan singkat"></textarea></label></div>
          <p id="loan-preview" class="muted small" style="margin:0 0 8px;"></p>
          <p class="muted small" style="margin:0 0 8px;">Hanya boleh satu kasbon berjalan dalam satu waktu.</p>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" id="btn-save" class="btn-primary">Kirim Pengajuan</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("btn-new").addEventListener("click", openModal);
  document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
  const form = document.getElementById("form-loan");
  form.addEventListener("submit", onSubmit);
  form.amount.addEventListener("input", updatePreview);
  form.tenor.addEventListener("input", updatePreview);
  await load();
}

function updatePreview() {
  const f = document.getElementById("form-loan");
  const a = Number(f.amount.value), t = Number(f.tenor.value);
  const el = document.getElementById("loan-preview");
  el.textContent = a >= 10000 && t >= 1 ? `Perkiraan cicilan: ${fmtRupiah(Math.floor(a / t))} per bulan selama ${t} bulan.` : "";
}

async function load() {
  const el = document.getElementById("loan-list");
  const { data, error } = await supabase.from("employee_loans")
    .select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(50);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada pengajuan.</p></div>`; return; }

  const pendingIds = data.filter(r => r.status === "pending").map(r => r.id);
  const liveIds = data.filter(r => ["approved", "lunas", "stopped"].includes(r.status)).map(r => r.id);
  const stepsBy = {}, instBy = {};
  if (pendingIds.length) {
    const { data: steps } = await supabase.from("loan_approvals")
      .select("loan_id, step_order, status, approver_names").in("loan_id", pendingIds).order("step_order");
    (steps || []).forEach(s => { (stepsBy[s.loan_id] ||= []).push(s); });
  }
  if (liveIds.length) {
    const { data: inst } = await supabase.from("loan_installments")
      .select("loan_id, seq, period, amount, status").in("loan_id", liveIds).order("seq");
    (inst || []).forEach(i => { (instBy[i.loan_id] ||= []).push(i); });
  }

  el.innerHTML = data.map(r => {
    const [tone, label] = LOAN_STATUS[r.status] || ["muted", r.status];
    const waiting = (stepsBy[r.id] || []).find(s => s.status === "pending");
    const inst = instBy[r.id] || [];
    const paid = inst.filter(i => i.status === "paid");
    const paidSum = paid.reduce((s, i) => s + Number(i.amount), 0);
    const left = Number(r.amount) - paidSum;
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${fmtRupiah(r.amount)}</strong>
          <span class="muted small">${r.tenor} bulan · mulai ${periodText(r.start_period)}</span>
        </div>
        <div class="muted" style="white-space:pre-line;">${esc(r.purpose)}</div>
        ${waiting ? `<div class="muted small" style="margin-top:6px;">Menunggu persetujuan: ${esc(waiting.approver_names || "-")}</div>` : ""}
        ${inst.length ? `
          <div class="small" style="margin-top:8px;">Terpotong ${paid.length}/${inst.length} cicilan · Sisa ${fmtRupiah(r.status === "stopped" ? 0 : left)}</div>
          <details style="margin-top:6px;"><summary class="small">Jadwal cicilan</summary>
            <div class="small" style="margin-top:4px;">
              ${inst.map(i => `<div style="display:flex; justify-content:space-between; gap:12px;"><span>${i.seq}. ${periodText(i.period)}</span><span>${fmtRupiah(i.amount)} · ${{ scheduled: "terjadwal", paid: "terpotong", cancelled: "dibatalkan" }[i.status] || i.status}</span></div>`).join("")}
            </div>
          </details>` : ""}
        ${r.review_notes && r.status !== "approved" ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${r.status === "pending" ? `<div style="margin-top:8px;"><button class="btn-link btn-cancel-req" data-id="${r.id}" style="color:var(--danger,#dc2626);">Batalkan</button></div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-cancel-req").forEach(b => b.addEventListener("click", () => cancelReq(b.dataset.id)));
}

function openModal() {
  const form = document.getElementById("form-loan");
  form.reset();
  form.tenor.value = 3;
  form.start.value = nextPeriod();
  document.getElementById("loan-preview").textContent = "";
  document.getElementById("modal-loan").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal-loan").classList.add("hidden"); }

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const amount = Math.trunc(Number(fd.get("amount")));
  const tenor = Math.trunc(Number(fd.get("tenor")));
  if (!(amount >= 10000)) { toast("Nominal minimal Rp 10.000", "error"); return; }
  if (!(tenor >= 1 && tenor <= 24)) { toast("Lama cicilan 1–24 bulan", "error"); return; }

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  try {
    const { error } = await supabase.from("employee_loans").insert({
      user_id: me.id,
      amount,
      tenor,
      start_period: String(fd.get("start")),
      purpose: String(fd.get("purpose")).trim(),
    });
    if (error) throw error;
    toast("Pengajuan kasbon terkirim ke atasan", "success");
    closeModal();
    await load();
  } catch (err) {
    toast("Gagal mengirim: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function cancelReq(id) {
  const ok = await confirmDialog({ title: "Batalkan pengajuan?", message: "Pengajuan kasbon ini akan dibatalkan.", confirmLabel: "Batalkan", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.rpc("cancel_loan", { p_loan: id });
  if (error) { toast("Gagal membatalkan: " + error.message, "error"); return; }
  toast("Pengajuan dibatalkan", "success");
  await load();
}
