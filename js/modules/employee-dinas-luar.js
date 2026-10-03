import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, confirmDialog, todayISO } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// DINAS LUAR / WFH / KUNJUNGAN (sisi karyawan).
// Ajukan rentang tanggal -> atasan menyetujui (rantai approval unit).
// Setelah DISETUJUI, absen pada tanggal itu otomatis ditandai oleh trigger
// database (008/009) sehingga absen di luar radius kantor sah dan tidak
// perlu ditinjau manual. Persetujuan lewat decide_field_work (SQL 009).
// =======================================================================

export const KIND_LABEL = { dinas_luar: "Dinas Luar", wfh: "WFH", kunjungan: "Kunjungan" };
const STATUS = {
  pending: ["warn", "Menunggu"],
  approved: ["ok", "Disetujui"],
  rejected: ["danger", "Ditolak"],
  cancelled: ["muted", "Dibatalkan"],
};

let me = null;

export async function render(container, user) {
  me = user;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Dinas Luar / WFH / Kunjungan</h1>
        <p class="muted">Ajukan sebelum berangkat. Kalau disetujui atasan, absen Anda di luar radius kantor dianggap sah.</p>
      </div>
      <button id="btn-new" class="btn-primary">+ Ajukan</button>
    </div>
    <div id="fw-list"><p class="muted">Memuat…</p></div>

    <div id="modal-fw" class="modal hidden">
      <div class="modal-box">
        <h3>Pengajuan Dinas Luar / WFH / Kunjungan</h3>
        <form id="form-fw">
          <div class="form-row">
            <label>Jenis
              <select name="kind" required>
                <option value="dinas_luar">Dinas Luar (tugas ke luar kantor)</option>
                <option value="kunjungan">Kunjungan (klien / pelanggan / lapangan)</option>
                <option value="wfh">WFH (bekerja dari rumah)</option>
              </select>
            </label>
          </div>
          <div class="form-row"><label>Tanggal mulai <input type="date" name="start" required></label></div>
          <div class="form-row"><label>Tanggal selesai <input type="date" name="end" required></label></div>
          <div class="form-row"><label>Tujuan / lokasi <input name="destination" maxlength="150" placeholder="Contoh: PT Maju Jaya, Sidoarjo"></label></div>
          <div class="form-row"><label>Keperluan <textarea name="reason" rows="3" required maxlength="1000" placeholder="Jelaskan keperluan singkat"></textarea></label></div>
          <p class="muted small" style="margin:0 0 8px;">Maksimal 32 hari per pengajuan. Absen tetap wajib dilakukan.</p>
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
  document.getElementById("form-fw").addEventListener("submit", onSubmit);
  await load();
}

async function load() {
  const el = document.getElementById("fw-list");
  const { data, error } = await supabase.from("field_work_requests")
    .select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(100);
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}</p>`; return; }
  if (!data.length) { el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada pengajuan.</p></div>`; return; }

  const ids = data.filter(r => r.status === "pending").map(r => r.id);
  const stepsBy = {};
  if (ids.length) {
    const { data: steps } = await supabase.from("field_work_approvals")
      .select("request_id, step_order, status, approver_names").in("request_id", ids).order("step_order");
    (steps || []).forEach(s => { (stepsBy[s.request_id] ||= []).push(s); });
  }

  const today = todayISO();
  el.innerHTML = data.map(r => {
    const [tone, label] = STATUS[r.status] || ["muted", r.status];
    const waiting = (stepsBy[r.id] || []).find(s => s.status === "pending");
    const canCancel = r.status === "pending" || (r.status === "approved" && r.start_date > today);
    return `
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          <span class="badge badge-${tone}">${label}</span>
          <strong>${KIND_LABEL[r.kind] || r.kind}</strong>
          <span class="muted small">${fmtDate(r.start_date)}${r.end_date !== r.start_date ? " – " + fmtDate(r.end_date) : ""}</span>
        </div>
        ${r.destination ? `<div>📍 ${esc(r.destination)}</div>` : ""}
        <div class="muted" style="white-space:pre-line;">${esc(r.reason)}</div>
        ${waiting ? `<div class="muted small" style="margin-top:6px;">Menunggu persetujuan: ${esc(waiting.approver_names || "-")}</div>` : ""}
        ${r.review_notes && r.status !== "approved" ? `<div class="small" style="margin-top:6px;">Catatan: ${esc(r.review_notes)}</div>` : ""}
        <div class="muted small" style="margin-top:6px;">Diajukan ${fmtDateTime(r.created_at)}</div>
        ${canCancel ? `<div style="margin-top:8px;"><button class="btn-link btn-cancel-req" data-id="${r.id}" style="color:var(--danger,#dc2626);">Batalkan</button></div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-cancel-req").forEach(b => b.addEventListener("click", () => cancelReq(b.dataset.id)));
}

function openModal() {
  const form = document.getElementById("form-fw");
  form.reset();
  const t = todayISO();
  form.start.value = t;
  form.end.value = t;
  document.getElementById("modal-fw").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal-fw").classList.add("hidden"); }

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const start = fd.get("start"), end = fd.get("end");
  if (end < start) { toast("Tanggal selesai tidak boleh sebelum tanggal mulai", "error"); return; }
  const days = (new Date(end) - new Date(start)) / 86400000;
  if (days > 31) { toast("Maksimal 32 hari per pengajuan", "error"); return; }

  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  try {
    const { error } = await supabase.from("field_work_requests").insert({
      user_id: me.id,
      kind: fd.get("kind"),
      start_date: start,
      end_date: end,
      destination: String(fd.get("destination") || "").trim() || null,
      reason: String(fd.get("reason")).trim(),
    });
    if (error) throw error;
    toast("Pengajuan terkirim ke atasan", "success");
    closeModal();
    await load();
  } catch (err) {
    toast("Gagal mengirim: " + (err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function cancelReq(id) {
  const ok = await confirmDialog({ title: "Batalkan pengajuan?", message: "Pengajuan ini akan dibatalkan.", confirmLabel: "Batalkan", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.rpc("cancel_field_work", { p_request: id });
  if (error) { toast("Gagal membatalkan: " + error.message, "error"); return; }
  toast("Pengajuan dibatalkan", "success");
  await load();
}
