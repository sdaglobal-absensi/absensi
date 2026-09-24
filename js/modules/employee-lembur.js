import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, roundOvertimeHours, fmtJam, dayOfWeekFromDateStr } from "../core.js";
import {
  esc, fetchSteps, stepsHTML, rejectionReason, openRevisionModal, submitErrorMessage,
} from "../approvalHelper.js";
import { chainOf, employeeActionsHTML, employeeStatusTag, openChainModal } from "../requestHistory.js";

// Pengajuan Lembur karyawan. Pengajuan yang DITOLAK punya tombol "Ajukan
// Ulang" yang membuka popup berisi form terisi data lama. Hasilnya terkirim
// sebagai pengajuan BARU (menaut lewat revision_of); pengajuan lama tidak
// diubah, jadi riwayat ditolak/disetujui tetap tercatat semua.
let current = { data: [], steps: {} };

// Isi form (dipakai form utama & popup revisi) — nama field harus sama.
const FIELDS_HTML = `
  <div class="form-row">
    <label>Tanggal <input type="date" name="date" required></label>
  </div>
  <div class="form-row two-col">
    <label>Jam Mulai <input type="time" name="start_time" required></label>
    <label>Jam Selesai <input type="time" name="end_time" required></label>
  </div>
  <div class="form-row">
    <label>Keterangan <textarea name="reason" rows="3" required placeholder="Jelaskan pekerjaan yang dilemburkan"></textarea></label>
  </div>`;

// Validasi + kirim. Mengembalikan true kalau berhasil.
async function submitRequest(fd, user, revisionOf) {
  const date = fd.get("date");
  const startTime = fd.get("start_time");
  const endTime = fd.get("end_time");

  if (endTime <= startTime) {
    toast("Jam selesai harus lebih besar dari jam mulai", "error");
    return false;
  }

  const payload = {
    user_id: user.id,
    date,
    start_time: startTime,
    end_time: endTime,
    is_hari_libur: await determineIsHoliday(date),
    total_jam: roundOvertimeHours(startTime, endTime),
    reason: fd.get("reason"),
  };
  if (revisionOf) payload.revision_of = revisionOf;

  const { error } = await supabase.from("overtime_requests").insert(payload);
  if (error) {
    toast(submitErrorMessage(error), "error");
    if (revisionOf) loadList(user);
    return false;
  }
  toast(revisionOf ? "Pengajuan ulang terkirim, menunggu approval" : "Pengajuan lembur terkirim, menunggu approval", "success");
  loadList(user);
  return true;
}

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Lembur</h1>
      <p class="muted">Ajukan lembur untuk disetujui admin/HR</p>
    </div>

    <form id="form-lembur" class="card form-card">
      ${FIELDS_HTML}
      <button type="submit" class="btn-primary btn-block">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan Lembur</h2>
    <div id="lembur-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("form-lembur").addEventListener("submit", async e => {
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
    title: "Ajukan Ulang Lembur",
    subtitle: `${fmtDate(r.date)} · ${r.start_time?.slice(0, 5)} – ${r.end_time?.slice(0, 5)}`,
    reason: rejectionReason(r, current.steps[r.id]),
    fieldsHTML: FIELDS_HTML,
    values: { date: r.date, start_time: r.start_time?.slice(0, 5), end_time: r.end_time?.slice(0, 5), reason: r.reason },
    onSubmit: fd => submitRequest(fd, user, r.id),
  });
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
  if (!el) return;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan lembur.</p>`; return; }

  const steps = await fetchSteps("overtime", data.map(r => r.id));
  current = { data, steps };
  // Satu baris per "rantai" pengajuan: hanya yang TERBARU. Pengajuan lama yang
  // sudah diajukan ulang tidak jadi baris sendiri — dibuka lewat tombol "Riwayat".
  const heads = data.filter(r => !data.some(x => x.revision_of === r.id));
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal</th><th>Jam</th><th>Total Jam</th><th>Jenis Hari</th><th>Keterangan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${heads.map(r => {
          const n = chainOf(data, r).length;
          return `
          <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${esc(r.start_time?.slice(0, 5))} – ${esc(r.end_time?.slice(0, 5))}</td>
            <td>${fmtJam(r.total_jam ?? roundOvertimeHours(r.start_time, r.end_time))}</td>
            <td>${r.is_hari_libur ? "Hari Libur" : "Hari Biasa"}</td>
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
    if (r) openChainModal("Riwayat Pengajuan Lembur", data, r, steps, describe);
  }));
}

// Ringkasan satu pengajuan lembur untuk daftar riwayat.
function describe(r) {
  return `${fmtDate(r.date)} · ${esc(r.start_time?.slice(0, 5))} – ${esc(r.end_time?.slice(0, 5))} · ${fmtJam(r.total_jam ?? roundOvertimeHours(r.start_time, r.end_time))} · ${r.is_hari_libur ? "Hari Libur" : "Hari Biasa"}<div class="hist-reason">${esc(r.reason)}</div>`;
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
