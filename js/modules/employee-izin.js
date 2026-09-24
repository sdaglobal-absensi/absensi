import { supabase } from "../supabaseClient.js";
import { toast, fmtDate } from "../core.js";
import {
  esc, fetchSteps, stepsHTML, rejectionReason, openRevisionModal, submitErrorMessage,
} from "../approvalHelper.js";
import { chainOf, employeeActionsHTML, employeeStatusTag, openChainModal } from "../requestHistory.js";

// Pengajuan Izin karyawan. Pengajuan yang DITOLAK punya tombol "Ajukan Ulang"
// yang membuka popup berisi form terisi data lama. Hasilnya terkirim sebagai
// pengajuan BARU (menaut lewat revision_of); pengajuan lama tidak diubah,
// jadi riwayat ditolak/disetujui tetap tercatat semua.
let current = { data: [], steps: {} };

// Isi form (dipakai form utama & popup revisi) — nama field harus sama.
const FIELDS_HTML = `
  <div class="form-row">
    <label>Jenis
      <select name="type" required>
        <option value="izin">Izin</option>
        <option value="sakit">Sakit</option>
        <option value="cuti">Cuti</option>
      </select>
    </label>
  </div>
  <div class="form-row two-col">
    <label>Tanggal mulai <input type="date" name="start_date" required></label>
    <label>Tanggal selesai <input type="date" name="end_date" required></label>
  </div>
  <div class="form-row">
    <label>Alasan <textarea name="reason" rows="3" required placeholder="Jelaskan alasan pengajuan"></textarea></label>
  </div>`;

// Validasi + kirim. Mengembalikan true kalau berhasil.
async function submitRequest(fd, user, revisionOf) {
  if (fd.get("end_date") < fd.get("start_date")) {
    toast("Tanggal selesai tidak boleh lebih awal dari tanggal mulai", "error");
    return false;
  }
  const payload = {
    user_id: user.id,
    type: fd.get("type"),
    start_date: fd.get("start_date"),
    end_date: fd.get("end_date"),
    reason: fd.get("reason"),
  };
  if (revisionOf) payload.revision_of = revisionOf;

  const { error } = await supabase.from("leave_requests").insert(payload);
  if (error) {
    toast(submitErrorMessage(error), "error");
    if (revisionOf) loadList(user); // mis. sudah pernah diajukan ulang -> segarkan riwayat
    return false;
  }
  toast(revisionOf ? "Pengajuan ulang terkirim, menunggu approval" : "Pengajuan terkirim, menunggu approval", "success");
  loadList(user);
  return true;
}

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Izin</h1>
      <p class="muted">Ajukan izin, sakit, atau cuti</p>
    </div>

    <form id="form-izin" class="card form-card">
      ${FIELDS_HTML}
      <button type="submit" class="btn-primary btn-block">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan</h2>
    <div id="izin-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("form-izin").addEventListener("submit", async e => {
    e.preventDefault();
    const form = e.target;
    if (await submitRequest(new FormData(form), user, null)) form.reset();
  });

  loadList(user);
}

function startRevision(id, user) {
  const r = current.data.find(x => x.id === id);
  if (!r) return;
  openRevisionModal({
    title: "Ajukan Ulang Izin",
    subtitle: `${r.type} · ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`,
    reason: rejectionReason(r, current.steps[r.id]),
    fieldsHTML: FIELDS_HTML,
    values: { type: r.type, start_date: r.start_date, end_date: r.end_date, reason: r.reason },
    onSubmit: fd => submitRequest(fd, user, r.id),
  });
}

async function loadList(user) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("izin-list");
  if (!el) return;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan.</p>`; return; }

  const steps = await fetchSteps("leave", data.map(r => r.id));
  current = { data, steps };
  // Satu baris per "rantai" pengajuan: hanya yang TERBARU. Pengajuan lama yang
  // sudah diajukan ulang tidak jadi baris sendiri — dibuka lewat tombol "Riwayat".
  const heads = data.filter(r => !data.some(x => x.revision_of === r.id));
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Jenis</th><th>Periode</th><th>Alasan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${heads.map(r => {
          const n = chainOf(data, r).length;
          return `
          <tr>
            <td class="capitalize">${esc(r.type)}</td>
            <td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
            <td>${esc(r.reason)}</td>
            <td>
              <span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span>
              ${employeeStatusTag(n)}
            </td>
            <td>${stepsHTML(r, steps[r.id])}</td>
            <td>${employeeActionsHTML(r, n)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll(".btn-revisi").forEach(b => b.addEventListener("click", () => startRevision(b.dataset.id, user)));
  el.querySelectorAll(".btn-hist").forEach(b => b.addEventListener("click", () => {
    const r = data.find(x => x.id === b.dataset.id);
    if (r) openChainModal("Riwayat Pengajuan Izin", data, r, steps, describe);
  }));
}

// Ringkasan satu pengajuan izin untuk daftar riwayat.
function describe(r) {
  return `<span class="capitalize">${esc(r.type)}</span> · ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}<div class="hist-reason">${esc(r.reason)}</div>`;
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
