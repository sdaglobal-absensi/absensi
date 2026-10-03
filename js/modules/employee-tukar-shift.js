import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, confirmDialog, todayISO } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// TUKAR SHIFT / GANTI JADWAL (sisi karyawan).
// A mengajak B bertukar jadwal pada SATU tanggal -> B menerima/menolak ->
// atasan A menyetujui (rantai approval unit). Setelah disetujui, pada
// tanggal itu A memakai jadwal B dan sebaliknya (tabel schedule_overrides);
// jadwal dasar di profil tidak berubah. Lihat SQL 013_tukar_shift.sql.
// =======================================================================

export const SWAP_STATUS = {
  pending_partner: ["warn", "Menunggu rekan"],
  pending: ["warn", "Menunggu atasan"],
  approved: ["ok", "Disetujui"],
  rejected: ["danger", "Ditolak atasan"],
  declined: ["danger", "Ditolak rekan"],
  cancelled: ["muted", "Dibatalkan"],
};

let me = null;
let candidates = [];

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Tukar Shift</h1>
        <p class="muted">Bertukar jadwal kerja dengan rekan pada satu tanggal. Rekan harus setuju, lalu atasan menyetujui.</p>
      </div>
      <button id="btn-new-swap" class="btn-primary">+ Ajukan Tukar Shift</button>
    </div>
    <div id="swap-list"><p class="muted">Memuat…</p></div>

    <div id="modal-swap" class="modal hidden">
      <div class="modal-box">
        <h3>Ajukan Tukar Shift</h3>
        <form id="form-swap">
          <div class="form-row"><label>Tukar dengan
            <select name="partner" required><option value="">Memuat…</option></select></label></div>
          <div class="form-row"><label>Tanggal <input type="date" name="date" required></label></div>
          <div class="form-row"><label>Alasan <textarea name="reason" rows="3" required maxlength="500" placeholder="Contoh: ada acara keluarga, sudah sepakat dengan rekan"></textarea></label></div>
          <p class="muted small" style="margin:0 0 8px;">Hanya tanggal itu yang ditukar. Kalian berdua harus sudah punya jadwal kerja, dan jadwalnya harus berbeda.</p>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-swap-modal" class="btn-secondary">Batal</button>
            <button type="submit" id="btn-save-swap" class="btn-primary">Kirim Ajakan</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("btn-new-swap").addEventListener("click", openModal);
  document.getElementById("btn-cancel-swap-modal").addEventListener("click", closeModal);
  document.getElementById("form-swap").addEventListener("submit", onSubmit);
  await load();
}

async function scheduleNames(rows) {
  const ids = [...new Set(rows.flatMap(r => [r.requester_schedule_id, r.partner_schedule_id]).filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await supabase.from("work_schedules").select("id, name").in("id", ids);
  return Object.fromEntries((data || []).map(s => [s.id, s.name]));
}

async function load() {
  const el = document.getElementById("swap-list");
  const { data, error } = await supabase.from("shift_swaps")
    .select("*").or(`requester_id.eq.${me.id},partner_id.eq.${me.id}`)
    .order("created_at", { ascending: false }).limit(100);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada pengajuan tukar shift.</p></div>`; return; }

  const names = await scheduleNames(data);
  const pendingIds = data.filter(r => r.status === "pending").map(r => r.id);
  const stepsBy = {};
  if (pendingIds.length) {
    const { data: steps } = await supabase.from("shift_swap_approvals")
      .select("swap_id, step_order, status, approver_names").in("swap_id", pendingIds).order("step_order");
    (steps || []).forEach(s => { (stepsBy[s.swap_id] ||= []).push(s); });
  }
  const today = todayISO();

  el.innerHTML = data.map(r => {
    const mine = r.requester_id === me.id;
    const [tone, label] = SWAP_STATUS[r.status] || ["muted", r.status];
    const other = mine ? r.partner_name : r.requester_name;
    const myNew = mine ? names[r.partner_schedule_id] : names[r.requester_schedule_id];
    const myOld = mine ? names[r.requester_schedule_id] : names[r.partner_schedule_id];
    const waiting = (stepsBy[r.id] || []).find(s => s.status === "pending");
    const canCancel = mine && ["pending_partner", "pending"].includes(r.status)
      || (r.status === "approved" && r.swap_date > today);
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${fmtDate(r.swap_date)}</strong>
          <span class="muted small">${mine ? "Kamu mengajak" : "Diajak oleh"} ${esc(other || "-")}</span>
        </div>
        <div class="small">Jadwalmu <strong>${esc(myOld || "-")}</strong> → <strong>${esc(myNew || "-")}</strong></div>
        <div class="muted" style="white-space:pre-line; margin-top:4px;">${esc(r.reason)}</div>
        ${waiting ? `<div class="muted small" style="margin-top:6px;">Menunggu persetujuan: ${esc(waiting.approver_names || "-")}</div>` : ""}
        ${r.review_notes ? `<div class="small" style="margin-top:6px;">Catatan atasan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        <div style="margin-top:8px; display:flex; gap:12px; flex-wrap:wrap;">
          ${!mine && r.status === "pending_partner" ? `
            <button class="btn-primary btn-swap-accept" data-id="${r.id}">Terima</button>
            <button class="btn-secondary btn-swap-decline" data-id="${r.id}">Tolak</button>` : ""}
          ${canCancel ? `<button class="btn-link btn-swap-cancel" data-id="${r.id}" style="color:var(--danger,#dc2626);">${r.status === "approved" ? "Batalkan penukaran" : "Batalkan"}</button>` : ""}
        </div>
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-swap-accept").forEach(b => b.addEventListener("click", () => respond(b.dataset.id, true)));
  el.querySelectorAll(".btn-swap-decline").forEach(b => b.addEventListener("click", () => respond(b.dataset.id, false)));
  el.querySelectorAll(".btn-swap-cancel").forEach(b => b.addEventListener("click", () => cancelSwap(b.dataset.id)));
}

async function openModal() {
  const form = document.getElementById("form-swap");
  form.reset();
  form.date.min = todayISO();
  document.getElementById("modal-swap").classList.remove("hidden");

  const sel = form.partner;
  sel.innerHTML = `<option value="">Memuat…</option>`;
  const { data, error } = await supabase.rpc("swap_candidates");
  if (error) { sel.innerHTML = `<option value="">Gagal memuat</option>`; toast("Gagal memuat daftar rekan: " + error.message, "error"); return; }
  const myBase = me.base_schedule_id ?? me.schedule_id;
  candidates = (data || []).filter(c => c.schedule_id !== myBase);
  if (!myBase) {
    sel.innerHTML = `<option value="">Kamu belum punya jadwal kerja</option>`;
    return;
  }
  sel.innerHTML = `<option value="">Pilih rekan…</option>` + candidates.map(c =>
    `<option value="${c.id}">${esc(c.full_name)}${c.employee_code ? " (" + esc(c.employee_code) + ")" : ""} — ${esc(c.schedule_name || "")}</option>`).join("");
}
function closeModal() { document.getElementById("modal-swap").classList.add("hidden"); }

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const partner = fd.get("partner");
  if (!partner) { toast("Pilih rekan dulu", "error"); return; }
  const btn = document.getElementById("btn-save-swap");
  btn.disabled = true;
  try {
    const { error } = await supabase.from("shift_swaps").insert({
      partner_id: partner,
      swap_date: fd.get("date"),
      reason: String(fd.get("reason")).trim(),
    });
    if (error) throw error;
    toast("Ajakan terkirim ke rekan", "success");
    closeModal();
    await load();
  } catch (err) {
    toast("Gagal mengirim: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function respond(id, accept) {
  if (!accept) {
    const ok = await confirmDialog({ title: "Tolak ajakan?", message: "Pengajuan tukar shift ini akan ditolak.", confirmLabel: "Tolak", confirmClass: "btn-danger" });
    if (!ok) return;
  }
  const { error } = await supabase.rpc("respond_shift_swap", { p_swap: id, p_accept: accept });
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  toast(accept ? "Diterima, menunggu persetujuan atasan" : "Ajakan ditolak", "success");
  await load();
}

async function cancelSwap(id) {
  const ok = await confirmDialog({ title: "Batalkan tukar shift?", message: "Jadwal kembali seperti semula.", confirmLabel: "Batalkan", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.rpc("cancel_shift_swap", { p_swap: id });
  if (error) { toast("Gagal membatalkan: " + error.message, "error"); return; }
  toast("Dibatalkan", "success");
  await load();
}
