import { supabase } from "../supabaseClient.js";
import { toast, fmtDate } from "../core.js";
import {
  esc, fetchSteps, stepsHTML, rejectionReason, revisionBadge, revisionActionHTML,
  revisionBannerHTML, submitErrorMessage,
} from "../approvalHelper.js";

// Pengajuan Izin karyawan. Pengajuan yang DITOLAK bisa diajukan ulang: form
// terisi otomatis dengan data lama, karyawan memperbaiki yang salah, lalu
// terkirim sebagai pengajuan BARU (menaut lewat revision_of). Pengajuan lama
// tidak diubah, jadi riwayat ditolak/disetujui tetap tercatat semua.
let revising = null; // pengajuan ditolak yang sedang direvisi (null = pengajuan biasa)
let current = { data: [], steps: {} };

export async function render(container, user) {
  revising = null;
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Izin</h1>
      <p class="muted">Ajukan izin, sakit, atau cuti</p>
    </div>

    <div id="rev-banner" class="revisi-banner hidden"></div>
    <form id="form-izin" class="card form-card">
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
      </div>
      <button type="submit" id="btn-submit" class="btn-primary btn-block">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan</h2>
    <div id="izin-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("form-izin").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get("end_date") < fd.get("start_date")) {
      toast("Tanggal selesai tidak boleh lebih awal dari tanggal mulai", "error");
      return;
    }
    const payload = {
      user_id: user.id,
      type: fd.get("type"),
      start_date: fd.get("start_date"),
      end_date: fd.get("end_date"),
      reason: fd.get("reason"),
    };
    if (revising) payload.revision_of = revising.id;

    const { error } = await supabase.from("leave_requests").insert(payload);
    if (error) { toast(submitErrorMessage(error), "error"); if (revising) loadList(user); return; }
    toast(revising ? "Pengajuan ulang terkirim, menunggu approval" : "Pengajuan terkirim, menunggu approval", "success");
    stopRevision();
    loadList(user);
  });

  loadList(user);
}

function startRevision(id) {
  const r = current.data.find(x => x.id === id);
  if (!r) return;
  revising = r;
  const form = document.getElementById("form-izin");
  form.elements.type.value = r.type;
  form.elements.start_date.value = r.start_date;
  form.elements.end_date.value = r.end_date;
  form.elements.reason.value = r.reason;

  const banner = document.getElementById("rev-banner");
  banner.innerHTML = revisionBannerHTML(
    `Mengajukan ulang: ${r.type} ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`,
    rejectionReason(r, current.steps[r.id])
  );
  banner.classList.remove("hidden");
  banner.querySelector("#btn-cancel-revisi").addEventListener("click", stopRevision);
  document.getElementById("btn-submit").textContent = "Kirim Pengajuan Ulang";
  banner.scrollIntoView({ behavior: "smooth", block: "center" });
  form.elements.reason.focus();
}

function stopRevision() {
  revising = null;
  document.getElementById("form-izin").reset();
  const banner = document.getElementById("rev-banner");
  banner.classList.add("hidden");
  banner.innerHTML = "";
  document.getElementById("btn-submit").textContent = "Kirim Pengajuan";
}

async function loadList(user) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("izin-list");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan.</p>`; return; }

  const steps = await fetchSteps("leave", data.map(r => r.id));
  current = { data, steps };
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Jenis</th><th>Periode</th><th>Alasan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td class="capitalize">${esc(r.type)}</td>
            <td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
            <td>${esc(r.reason)}</td>
            <td>
              <span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span>
              ${revisionBadge(r)}
            </td>
            <td>${stepsHTML(r, steps[r.id])}</td>
            <td>${revisionActionHTML(r, data)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll(".btn-revisi").forEach(b => b.addEventListener("click", () => startRevision(b.dataset.id)));
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
