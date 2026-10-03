import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, fmtRupiah, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";
import { CATEGORY_LABEL, CLAIM_STATUS, periodText, bindReceiptLinks } from "./employee-reimburse.js";

// =======================================================================
// APPROVAL & KELOLA REIMBURSEMENT (atasan & admin).
// Setujui/Tolak hanya untuk approver di tahap yang sedang berjalan (atau
// Super Admin) — dicek di server oleh decide_expense. Super Admin / Admin HR
// juga bisa memindahkan periode bayar atau membatalkan klaim yang sudah
// disetujui tapi belum masuk slip final.
// =======================================================================

let me = null;
let filter = "pending";

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Approval Reimbursement</h1>
        <p class="muted">Klaim biaya karyawan beserta foto notanya.</p>
      </div>
      <select id="claim-filter" aria-label="Filter status">
        <option value="pending">Menunggu</option>
        <option value="approved">Disetujui (belum dibayar)</option>
        <option value="paid">Sudah dibayar</option>
        <option value="all">Semua</option>
        <option value="rejected">Ditolak</option>
      </select>
    </div>
    <div id="claim-admin-list"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("claim-filter").addEventListener("change", e => { filter = e.target.value; load(); });
  filter = "pending";
  await load();
}

async function load() {
  const el = document.getElementById("claim-admin-list");
  let q = supabase.from("expense_claims")
    .select("*, profiles!expense_claims_user_id_fkey(full_name, department, employee_code)")
    .order("created_at", { ascending: false }).limit(150);
  if (filter !== "all") q = q.eq("status", filter);
  const { data, error } = await q;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Tidak ada klaim.</p></div>`; return; }

  const { data: steps } = await supabase.from("expense_approvals")
    .select("claim_id, step_order, status, approver_ids, approver_names")
    .in("claim_id", data.map(r => r.id)).order("step_order");
  const stepsBy = {};
  (steps || []).forEach(s => { (stepsBy[s.claim_id] ||= []).push(s); });

  const isSuperUser = me.role === "super_admin";
  const isHR = isSuperUser || ["super_admin_hr", "admin_hr"].includes(me.role);

  el.innerHTML = data.map(r => {
    const [tone, label] = CLAIM_STATUS[r.status] || ["muted", r.status];
    const chain = stepsBy[r.id] || [];
    const current = chain.find(s => s.status === "pending");
    const myTurn = r.status === "pending" && r.user_id !== me.id
      && (isSuperUser || (current && current.approver_ids.includes(me.id)));
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${esc(r.profiles?.full_name || "-")}</strong>
          <span class="muted small">${esc(r.profiles?.department || "")}</span>
        </div>
        <div><strong>${fmtRupiah(r.amount)}</strong> · ${CATEGORY_LABEL[r.category] || r.category} · ${fmtDate(r.expense_date)}</div>
        <div class="muted" style="white-space:pre-line;">${esc(r.description)}</div>
        <div style="margin-top:6px;"><button class="btn-link btn-receipt" data-path="${esc(r.receipt_path)}">📎 Lihat nota</button></div>
        ${["approved", "paid"].includes(r.status) ? `<div class="small" style="margin-top:6px;">Periode bayar: ${periodText(r.pay_period)}</div>` : ""}
        ${chain.length > 1 ? `<div class="muted small" style="margin-top:6px;">Tahap: ${chain.map(s => `${s.step_order}. ${esc(s.approver_names || "-")} (${s.status})`).join(" → ")}</div>` : ""}
        ${r.status === "pending" && current && !myTurn ? `<div class="muted small" style="margin-top:6px;">Menunggu: ${esc(current.approver_names || "-")}</div>` : ""}
        ${r.review_notes && !["approved", "paid"].includes(r.status) ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${myTurn ? `
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button class="btn-primary btn-sm btn-approve" data-id="${r.id}">Setujui</button>
            <button class="btn-danger btn-sm btn-reject" data-id="${r.id}">Tolak</button>
          </div>` : ""}
        ${r.status === "approved" && isHR ? `
          <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn-secondary btn-sm btn-period" data-id="${r.id}" data-period="${esc(r.pay_period || "")}">Ubah Periode Bayar</button>
            <button class="btn-secondary btn-sm btn-void" data-id="${r.id}">Batalkan Klaim</button>
          </div>` : ""}
      </div>`;
  }).join("");

  bindReceiptLinks(el);
  el.querySelectorAll(".btn-approve").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "approved")));
  el.querySelectorAll(".btn-reject").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "rejected")));
  el.querySelectorAll(".btn-period").forEach(b => b.addEventListener("click", () => changePeriod(b.dataset.id, b.dataset.period)));
  el.querySelectorAll(".btn-void").forEach(b => b.addEventListener("click", () => voidClaim(b.dataset.id)));
}

async function decide(id, decision) {
  let notes = null;
  if (decision === "rejected") {
    notes = window.prompt("Alasan penolakan (wajib diisi):", "");
    if (notes === null) return;
    if (!notes.trim()) { toast("Alasan penolakan wajib diisi", "error"); return; }
  } else {
    const ok = await confirmDialog({
      title: "Setujui klaim?",
      message: "Pastikan nominal sesuai nota. Nominal akan ditambahkan ke slip gaji karyawan.",
      confirmLabel: "Setujui",
    });
    if (!ok) return;
  }
  const { error } = await supabase.rpc("decide_expense", { p_claim: id, p_decision: decision, p_notes: notes?.trim() || null });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast(decision === "approved" ? "Klaim disetujui" : "Klaim ditolak", "success");
  await load();
}

async function changePeriod(id, current) {
  const p = window.prompt("Periode bayar baru (format YYYY-MM, contoh 2026-11):", current || "");
  if (p === null) return;
  const { error } = await supabase.rpc("set_expense_period", { p_claim: id, p_period: p.trim() });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast("Periode bayar diubah", "success");
  await load();
}

async function voidClaim(id) {
  const notes = window.prompt("Alasan pembatalan:", "");
  if (notes === null) return;
  const ok = await confirmDialog({
    title: "Batalkan klaim?",
    message: "Klaim ini tidak akan ditambahkan ke slip gaji.",
    confirmLabel: "Batalkan Klaim",
    confirmClass: "btn-danger",
  });
  if (!ok) return;
  const { error } = await supabase.rpc("void_expense", { p_claim: id, p_notes: notes.trim() || null });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast("Klaim dibatalkan", "success");
  await load();
}
