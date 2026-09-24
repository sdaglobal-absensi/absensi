import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, roundOvertimeHours, fmtJam, dayOfWeekFromDateStr } from "../core.js";
import {
  esc, fetchSteps, stepsHTML, rejectionReason, revisionBadge, revisionActionHTML,
  revisionBannerHTML, submitErrorMessage,
} from "../approvalHelper.js";

// Pengajuan Lembur karyawan. Pengajuan yang DITOLAK bisa diajukan ulang:
// form terisi otomatis dengan data lama, diperbaiki, lalu terkirim sebagai
// pengajuan BARU (menaut lewat revision_of) — pengajuan lama tidak diubah,
// jadi riwayat ditolak/disetujui tetap tercatat semua.
let revising = null;
let current = { data: [], steps: {} };

export async function render(container, user) {
  revising = null;
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Lembur</h1>
      <p class="muted">Ajukan lembur untuk disetujui admin/HR</p>
    </div>

    <div id="rev-banner" class="revisi-banner hidden"></div>
    <form id="form-lembur" class="card form-card">
      <div class="form-row">
        <label>Tanggal <input type="date" name="date" required></label>
      </div>
      <div class="form-row two-col">
        <label>Jam Mulai <input type="time" name="start_time" required></label>
        <label>Jam Selesai <input type="time" name="end_time" required></label>
      </div>
      <div class="form-row">
        <label>Keterangan <textarea name="reason" rows="3" required placeholder="Jelaskan pekerjaan yang dilemburkan"></textarea></label>
      </div>
      <button type="submit" id="btn-submit" class="btn-primary btn-block">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan Lembur</h2>
    <div id="lembur-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("form-lembur").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const date = fd.get("date");
    const startTime = fd.get("start_time");
    const endTime = fd.get("end_time");

    if (endTime <= startTime) {
      toast("Jam selesai harus lebih besar dari jam mulai", "error");
      return;
    }

    const isHariLibur = await determineIsHoliday(date);
    const totalJam = roundOvertimeHours(startTime, endTime);

    const payload = {
      user_id: user.id,
      date,
      start_time: startTime,
      end_time: endTime,
      is_hari_libur: isHariLibur,
      total_jam: totalJam,
      reason: fd.get("reason"),
    };
    if (revising) payload.revision_of = revising.id;

    const { error } = await supabase.from("overtime_requests").insert(payload);
    if (error) { toast(submitErrorMessage(error), "error"); if (revising) loadList(user); return; }
    toast(revising ? "Pengajuan ulang terkirim, menunggu approval" : "Pengajuan lembur terkirim, menunggu approval", "success");
    stopRevision();
    loadList(user);
  });

  loadList(user);
}

function startRevision(id) {
  const r = current.data.find(x => x.id === id);
  if (!r) return;
  revising = r;
  const form = document.getElementById("form-lembur");
  form.elements.date.value = r.date;
  form.elements.start_time.value = r.start_time?.slice(0, 5) || "";
  form.elements.end_time.value = r.end_time?.slice(0, 5) || "";
  form.elements.reason.value = r.reason;

  const banner = document.getElementById("rev-banner");
  banner.innerHTML = revisionBannerHTML(
    `Mengajukan ulang: lembur ${fmtDate(r.date)}, ${r.start_time?.slice(0, 5)} – ${r.end_time?.slice(0, 5)}`,
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
  document.getElementById("form-lembur").reset();
  const banner = document.getElementById("rev-banner");
  banner.classList.add("hidden");
  banner.innerHTML = "";
  document.getElementById("btn-submit").textContent = "Kirim Pengajuan";
}

// Tanggal Minggu, atau tanggal yang ada di Master Hari Libur (aktif) -> dianggap hari libur
async function determineIsHoliday(dateStr) {
  const dow = dayOfWeekFromDateStr(dateStr);
  if (dow === 0) return true;
  const { data } = await supabase.from("holidays").select("id").eq("date", dateStr).eq("is_active", true).maybeSingle();
  return !!data;
}

async function loadList(user) {
  const { data, error } = await supabase
    .from("overtime_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("lembur-list");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan lembur.</p>`; return; }

  const steps = await fetchSteps("overtime", data.map(r => r.id));
  current = { data, steps };
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal</th><th>Jam</th><th>Total Jam</th><th>Jenis Hari</th><th>Keterangan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${esc(r.start_time?.slice(0, 5))} – ${esc(r.end_time?.slice(0, 5))}</td>
            <td>${fmtJam(r.total_jam ?? roundOvertimeHours(r.start_time, r.end_time))}</td>
            <td>${r.is_hari_libur ? "Hari Libur" : "Hari Biasa"}</td>
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
