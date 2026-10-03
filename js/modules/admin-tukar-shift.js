import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, confirmDialog, todayISO } from "../core.js";
import { esc } from "../approvalHelper.js";
import { SWAP_STATUS } from "./employee-tukar-shift.js";

// =======================================================================
// APPROVAL TUKAR SHIFT (atasan & admin).
// Setujui/Tolak hanya untuk approver di tahap yang sedang berjalan (atau
// Super Admin) — dicek di server oleh decide_shift_swap. Penukaran yang
// sudah disetujui tapi tanggalnya belum tiba bisa dibatalkan pengelola.
// =======================================================================

let me = null;
let filter = "pending";

export async function render(container, user) {
  me = user;
  filter = "pending";
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Approval Tukar Shift</h1>
        <p class="muted">Pengajuan tukar jadwal yang sudah disetujui rekannya.</p>
      </div>
      <select id="swap-filter" aria-label="Filter status">
        <option value="pending">Menunggu atasan</option>
        <option value="upcoming">Disetujui (belum berlaku)</option>
        <option value="approved">Disetujui (semua)</option>
        <option value="rejected">Ditolak atasan</option>
        <option value="all">Semua</option>
      </select>
    </div>
    <div id="swap-admin-list"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("swap-filter").addEventListener("change", e => { filter = e.target.value; load(); });
  await load();
}

async function load() {
  const el = document.getElementById("swap-admin-list");
  const today = todayISO();
  let q = supabase.from("shift_swaps").select("*").order("swap_date", { ascending: filter === "pending" || filter === "upcoming" }).limit(150);
  if (filter === "pending") q = q.eq("status", "pending");
  else if (filter === "upcoming") q = q.eq("status", "approved").gt("swap_date", today);
  else if (filter === "approved" || filter === "rejected") q = q.eq("status", filter);
  const { data, error } = await q;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Tidak ada pengajuan.</p></div>`; return; }

  const ids = data.map(r => r.id);
  const schedIds = [...new Set(data.flatMap(r => [r.requester_schedule_id, r.partner_schedule_id]).filter(Boolean))];
  const [{ data: steps }, { data: scheds }] = await Promise.all([
    supabase.from("shift_swap_approvals").select("swap_id, step_order, status, approver_ids, approver_names").in("swap_id", ids).order("step_order"),
    schedIds.length ? supabase.from("work_schedules").select("id, name").in("id", schedIds) : Promise.resolve({ data: [] }),
  ]);
  const stepsBy = {};
  (steps || []).forEach(s => { (stepsBy[s.swap_id] ||= []).push(s); });
  const names = Object.fromEntries((scheds || []).map(s => [s.id, s.name]));

  const isSuperUser = me.role === "super_admin";

  el.innerHTML = data.map(r => {
    const [tone, label] = SWAP_STATUS[r.status] || ["muted", r.status];
    const chain = stepsBy[r.id] || [];
    const current = chain.find(s => s.status === "pending");
    const involved = [r.requester_id, r.partner_id].includes(me.id);
    const myTurn = r.status === "pending" && !involved && (isSuperUser || (current && current.approver_ids.includes(me.id)));
    const canVoid = r.status === "approved" && r.swap_date > today;
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${fmtDate(r.swap_date)}</strong>
        </div>
        <div><strong>${esc(r.requester_name || "-")}</strong>: ${esc(names[r.requester_schedule_id] || "-")} → ${esc(names[r.partner_schedule_id] || "-")}</div>
        <div><strong>${esc(r.partner_name || "-")}</strong>: ${esc(names[r.partner_schedule_id] || "-")} → ${esc(names[r.requester_schedule_id] || "-")}</div>
        <div class="muted" style="white-space:pre-line; margin-top:4px;">${esc(r.reason)}</div>
        ${chain.length > 1 ? `<div class="muted small" style="margin-top:6px;">Tahap: ${chain.map(s => `${s.step_order}. ${esc(s.approver_names || "-")} (${s.status})`).join(" → ")}</div>` : ""}
        ${r.status === "pending" && current && !myTurn ? `<div class="muted small" style="margin-top:6px;">Menunggu: ${esc(current.approver_names || "-")}</div>` : ""}
        ${r.review_notes ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${myTurn ? `
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button class="btn-primary btn-sm btn-approve" data-id="${r.id}">Setujui</button>
            <button class="btn-danger btn-sm btn-reject" data-id="${r.id}">Tolak</button>
          </div>` : ""}
        ${canVoid ? `<div style="margin-top:10px;"><button class="btn-secondary btn-sm btn-void" data-id="${r.id}">Batalkan penukaran</button></div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-approve").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "approved")));
  el.querySelectorAll(".btn-reject").forEach(b => b.addEventListener("click", () => decide(b.dataset.id, "rejected")));
  el.querySelectorAll(".btn-void").forEach(b => b.addEventListener("click", () => voidSwap(b.dataset.id)));
}

async function decide(id, decision) {
  let notes = null;
  if (decision === "rejected") {
    notes = window.prompt("Alasan penolakan (wajib diisi):", "");
    if (notes === null) return;
    if (!notes.trim()) { toast("Alasan penolakan wajib diisi", "error"); return; }
  } else {
    const ok = await confirmDialog({
      title: "Setujui tukar shift?",
      message: "Pada tanggal itu kedua karyawan akan memakai jadwal satu sama lain.",
      confirmLabel: "Setujui",
    });
    if (!ok) return;
  }
  const { error } = await supabase.rpc("decide_shift_swap", { p_swap: id, p_decision: decision, p_notes: notes?.trim() || null });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast(decision === "approved" ? "Tukar shift disetujui" : "Tukar shift ditolak", "success");
  await load();
}

async function voidSwap(id) {
  const ok = await confirmDialog({
    title: "Batalkan penukaran?",
    message: "Jadwal kedua karyawan kembali ke jadwal dasar pada tanggal itu.",
    confirmLabel: "Batalkan penukaran",
    confirmClass: "btn-danger",
  });
  if (!ok) return;
  const { error } = await supabase.rpc("cancel_shift_swap", { p_swap: id });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast("Penukaran dibatalkan", "success");
  await load();
}
