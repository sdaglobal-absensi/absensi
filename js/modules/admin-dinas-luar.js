import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, confirmDialog } from "../core.js";
import { esc } from "../approvalHelper.js";
import { KIND_LABEL } from "./employee-dinas-luar.js";

// =======================================================================
// APPROVAL DINAS LUAR / WFH / KUNJUNGAN (atasan & admin).
// Yang boleh menekan Setujui/Tolak hanya approver di tahap yang sedang
// berjalan (atau Super Admin) — dicek di server oleh decide_field_work.
// Admin yang punya menu ini tapi bukan giliran hanya bisa MELIHAT.
// =======================================================================

const STATUS = {
  pending: ["warn", "Menunggu"],
  approved: ["ok", "Disetujui"],
  rejected: ["danger", "Ditolak"],
  cancelled: ["muted", "Dibatalkan"],
};

let me = null;
let filter = "pending";

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Approval Dinas Luar</h1>
        <p class="muted">Pengajuan dinas luar, WFH, dan kunjungan karyawan.</p>
      </div>
      <select id="fw-filter" aria-label="Filter status">
        <option value="pending">Menunggu</option>
        <option value="all">Semua</option>
        <option value="approved">Disetujui</option>
        <option value="rejected">Ditolak</option>
      </select>
    </div>
    <div id="fw-admin-list"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("fw-filter").addEventListener("change", e => { filter = e.target.value; load(); });
  filter = "pending";
  await load();
}

async function load() {
  const el = document.getElementById("fw-admin-list");
  let q = supabase.from("field_work_requests")
    .select("*, profiles!field_work_requests_user_id_fkey(full_name, department, employee_code)")
    .order("created_at", { ascending: false }).limit(150);
  if (filter !== "all") q = q.eq("status", filter);
  const { data, error } = await q;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Tidak ada pengajuan.</p></div>`; return; }

  const stepsBy = {};
  const { data: steps } = await supabase.from("field_work_approvals")
    .select("request_id, step_order, status, approver_ids, approver_names, notes")
    .in("request_id", data.map(r => r.id)).order("step_order");
  (steps || []).forEach(s => { (stepsBy[s.request_id] ||= []).push(s); });

  const isSuperUser = me.role === "super_admin";
  el.innerHTML = data.map(r => {
    const [tone, label] = STATUS[r.status] || ["muted", r.status];
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
        <div><strong>${KIND_LABEL[r.kind] || r.kind}</strong> · ${fmtDate(r.start_date)}${r.end_date !== r.start_date ? " – " + fmtDate(r.end_date) : ""}</div>
        ${r.destination ? `<div>📍 ${esc(r.destination)}</div>` : ""}
        <div class="muted" style="white-space:pre-line;">${esc(r.reason)}</div>
        ${chain.length > 1 ? `<div class="muted small" style="margin-top:6px;">Tahap: ${chain.map(s => `${s.step_order}. ${esc(s.approver_names || "-")} (${s.status})`).join(" → ")}</div>` : ""}
        ${r.status === "pending" && current && !myTurn ? `<div class="muted small" style="margin-top:6px;">Menunggu: ${esc(current.approver_names || "-")}</div>` : ""}
        ${r.review_notes && r.status !== "approved" ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${myTurn ? `
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button class="btn-primary btn-sm btn-approve" data-id="${r.id}">Setujui</button>
            <button class="btn-danger btn-sm btn-reject" data-id="${r.id}">Tolak</button>
          </div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-approve").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "approved")));
  el.querySelectorAll(".btn-reject").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "rejected")));
}

async function decide(id, decision) {
  let notes = null;
  if (decision === "rejected") {
    notes = window.prompt("Alasan penolakan (wajib diisi):", "");
    if (notes === null) return;
    if (!notes.trim()) { toast("Alasan penolakan wajib diisi", "error"); return; }
  } else {
    const ok = await confirmDialog({
      title: "Setujui pengajuan?",
      message: "Absen karyawan di luar radius kantor pada tanggal ini akan dianggap sah.",
      confirmLabel: "Setujui",
    });
    if (!ok) return;
  }
  const { error } = await supabase.rpc("decide_field_work", { p_request: id, p_decision: decision, p_notes: notes?.trim() || null });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast(decision === "approved" ? "Pengajuan disetujui" : "Pengajuan ditolak", "success");
  await load();
}
