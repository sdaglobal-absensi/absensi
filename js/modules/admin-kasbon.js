import { supabase } from "../supabaseClient.js";
import { toast, fmtDateTime, fmtRupiah, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";
import { LOAN_STATUS, periodText } from "./employee-kasbon.js";

// =======================================================================
// APPROVAL & KELOLA KASBON (atasan & admin).
// Yang boleh menekan Setujui/Tolak hanya approver di tahap yang sedang
// berjalan (atau Super Admin) — dicek di server oleh decide_loan.
// Kasbon yang sedang berjalan bisa dihentikan oleh Super Admin / Admin HR
// (stop_loan), mis. dilunasi tunai atau karyawan keluar.
// =======================================================================

let me = null;
let filter = "pending";

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Approval Kasbon</h1>
        <p class="muted">Pengajuan pinjaman karyawan dan status cicilannya.</p>
      </div>
      <select id="loan-filter" aria-label="Filter status">
        <option value="pending">Menunggu</option>
        <option value="approved">Berjalan</option>
        <option value="all">Semua</option>
        <option value="lunas">Lunas</option>
        <option value="rejected">Ditolak</option>
      </select>
    </div>
    <div id="loan-admin-list"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("loan-filter").addEventListener("change", e => { filter = e.target.value; load(); });
  filter = "pending";
  await load();
}

async function load() {
  const el = document.getElementById("loan-admin-list");
  let q = supabase.from("employee_loans")
    .select("*, profiles!employee_loans_user_id_fkey(full_name, department, employee_code)")
    .order("created_at", { ascending: false }).limit(150);
  if (filter !== "all") q = q.eq("status", filter);
  const { data, error } = await q;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Tidak ada pengajuan.</p></div>`; return; }

  const ids = data.map(r => r.id);
  const [{ data: steps }, { data: inst }] = await Promise.all([
    supabase.from("loan_approvals").select("loan_id, step_order, status, approver_ids, approver_names").in("loan_id", ids).order("step_order"),
    supabase.from("loan_installments").select("loan_id, status, amount").in("loan_id", ids),
  ]);
  const stepsBy = {}, instBy = {};
  (steps || []).forEach(s => { (stepsBy[s.loan_id] ||= []).push(s); });
  (inst || []).forEach(i => { (instBy[i.loan_id] ||= []).push(i); });

  const isSuperUser = me.role === "super_admin";
  const canStop = isSuperUser || ["super_admin_hr", "admin_hr"].includes(me.role);

  el.innerHTML = data.map(r => {
    const [tone, label] = LOAN_STATUS[r.status] || ["muted", r.status];
    const chain = stepsBy[r.id] || [];
    const current = chain.find(s => s.status === "pending");
    const myTurn = r.status === "pending" && r.user_id !== me.id
      && (isSuperUser || (current && current.approver_ids.includes(me.id)));
    const rows = instBy[r.id] || [];
    const paid = rows.filter(i => i.status === "paid");
    const paidSum = paid.reduce((s, i) => s + Number(i.amount), 0);
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${esc(r.profiles?.full_name || "-")}</strong>
          <span class="muted small">${esc(r.profiles?.department || "")}</span>
        </div>
        <div><strong>${fmtRupiah(r.amount)}</strong> · ${r.tenor} bulan · mulai ${periodText(r.start_period)}</div>
        <div class="muted" style="white-space:pre-line;">${esc(r.purpose)}</div>
        ${rows.length ? `<div class="small" style="margin-top:6px;">Terpotong ${paid.length}/${rows.length} cicilan · Sudah ${fmtRupiah(paidSum)} · Sisa ${fmtRupiah(r.status === "stopped" ? 0 : Number(r.amount) - paidSum)}</div>` : ""}
        ${chain.length > 1 ? `<div class="muted small" style="margin-top:6px;">Tahap: ${chain.map(s => `${s.step_order}. ${esc(s.approver_names || "-")} (${s.status})`).join(" → ")}</div>` : ""}
        ${r.status === "pending" && current && !myTurn ? `<div class="muted small" style="margin-top:6px;">Menunggu: ${esc(current.approver_names || "-")}</div>` : ""}
        ${r.review_notes && r.status !== "approved" ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${myTurn ? `
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button class="btn-primary btn-sm btn-approve" data-id="${r.id}">Setujui</button>
            <button class="btn-danger btn-sm btn-reject" data-id="${r.id}">Tolak</button>
          </div>` : ""}
        ${r.status === "approved" && canStop ? `
          <div style="margin-top:10px;"><button class="btn-secondary btn-sm btn-stop" data-id="${r.id}">Hentikan / Lunasi Manual</button></div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-approve").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "approved")));
  el.querySelectorAll(".btn-reject").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "rejected")));
  el.querySelectorAll(".btn-stop").forEach(b => b.addEventListener("click", () => stopLoan(b.dataset.id)));
}

async function decide(id, decision) {
  let notes = null;
  if (decision === "rejected") {
    notes = window.prompt("Alasan penolakan (wajib diisi):", "");
    if (notes === null) return;
    if (!notes.trim()) { toast("Alasan penolakan wajib diisi", "error"); return; }
  } else {
    const ok = await confirmDialog({
      title: "Setujui kasbon?",
      message: "Cicilan akan dijadwalkan dan otomatis dipotong dari slip gaji karyawan tiap periode.",
      confirmLabel: "Setujui",
    });
    if (!ok) return;
  }
  const { error } = await supabase.rpc("decide_loan", { p_loan: id, p_decision: decision, p_notes: notes?.trim() || null });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast(decision === "approved" ? "Kasbon disetujui" : "Kasbon ditolak", "success");
  await load();
}

async function stopLoan(id) {
  const notes = window.prompt("Alasan dihentikan (mis. dilunasi tunai / karyawan keluar):", "");
  if (notes === null) return;
  const ok = await confirmDialog({
    title: "Hentikan kasbon?",
    message: "Cicilan yang belum dipotong akan dibatalkan. Yang sudah dipotong tetap tercatat.",
    confirmLabel: "Hentikan",
    confirmClass: "btn-danger",
  });
  if (!ok) return;
  const { error } = await supabase.rpc("stop_loan", { p_loan: id, p_notes: notes.trim() || null });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast("Kasbon dihentikan", "success");
  await load();
}
