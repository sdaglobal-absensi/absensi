import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtTime, resolveUserTimezone, zonedTimestamp, todayISO } from "../core.js";
import {
  esc, fetchSteps, stepsHTML, rejectionReason, openRevisionModal, submitErrorMessage,
} from "../approvalHelper.js";
import { chainOf, employeeActionsHTML, employeeStatusTag, openChainModal } from "../requestHistory.js";

// Pengajuan Koreksi Absen karyawan — dipakai kalau lupa absen MASUK atau
// PULANG. Lewat alur approval bertingkat yang sama dengan Izin/Lembur;
// begitu disetujui sampai tahap terakhir, jam yang diajukan otomatis
// diterapkan ke tabel attendance (baris absensi dibuatkan kalau memang
// belum ada sama sekali untuk tanggal itu). Pengajuan yang DITOLAK punya
// tombol "Ajukan Ulang" — sama seperti Izin/Lembur.
let current = { data: [], steps: {} };
let cachedTz;

// Isi form (dipakai form utama & popup revisi) — nama field harus sama.
const FIELDS_HTML = `
  <div class="form-row two-col">
    <label>Tanggal Absen <input type="date" name="attendance_date" required></label>
    <label>Jenis
      <select name="correction_type" required>
        <option value="masuk">Lupa Absen Masuk</option>
        <option value="pulang">Lupa Absen Pulang</option>
      </select>
    </label>
  </div>
  <div class="form-row">
    <label>Jam yang Seharusnya <input type="time" name="corrected_time" required></label>
  </div>
  <div class="form-row">
    <label>Alasan <textarea name="reason" rows="3" required placeholder="Jelaskan kenapa lupa absen"></textarea></label>
  </div>`;

// Validasi + kirim. Mengembalikan true kalau berhasil.
async function submitRequest(fd, user, revisionOf) {
  const attendanceDate = fd.get("attendance_date");
  const correctionType = fd.get("correction_type");
  const timeStr = fd.get("corrected_time");

  const tz = cachedTz ??= await resolveUserTimezone(user);
  if (attendanceDate > todayISO(tz)) {
    toast("Tanggal absen tidak boleh di masa depan", "error");
    return false;
  }

  const [hh, mm] = timeStr.split(":").map(Number);
  const correctedTime = new Date(zonedTimestamp(attendanceDate, hh, mm, 0, tz)).toISOString();

  const payload = {
    user_id: user.id,
    attendance_date: attendanceDate,
    correction_type: correctionType,
    corrected_time: correctedTime,
    reason: fd.get("reason"),
  };
  if (revisionOf) payload.revision_of = revisionOf;

  const { error } = await supabase.from("attendance_correction_requests").insert(payload);
  if (error) {
    toast(submitErrorMessage(error), "error");
    if (revisionOf) loadList(user);
    return false;
  }
  toast(revisionOf ? "Pengajuan ulang terkirim, menunggu approval" : "Pengajuan koreksi terkirim, menunggu approval", "success");
  loadList(user);
  return true;
}

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Koreksi Absen</h1>
      <p class="muted">Lupa absen masuk atau pulang? Ajukan koreksi di sini untuk disetujui admin/HR.</p>
    </div>

    <form id="form-koreksi" class="card form-card">
      ${FIELDS_HTML}
      <button type="submit" class="btn-primary btn-block">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan Koreksi</h2>
    <div id="koreksi-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("form-koreksi").addEventListener("submit", async e => {
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
    title: "Ajukan Ulang Koreksi Absen",
    subtitle: `${typeLabel(r.correction_type)} · ${fmtDate(r.attendance_date)}`,
    reason: rejectionReason(r, current.steps[r.id]),
    fieldsHTML: FIELDS_HTML,
    values: {
      attendance_date: r.attendance_date,
      correction_type: r.correction_type,
      corrected_time: localTimeInputValue(r.corrected_time),
      reason: r.reason,
    },
    onSubmit: fd => submitRequest(fd, user, r.id),
  });
}

// Nilai untuk <input type="time"> dari timestamptz — pakai jam device
// sekadar untuk MENGISI ULANG form revisi (bukan acuan perhitungan; saat
// dikirim ulang, jam ini dihitung lagi sesuai zona lokasi kerja karyawan).
function localTimeInputValue(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function loadList(user) {
  const { data, error } = await supabase
    .from("attendance_correction_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("koreksi-list");
  if (!el) return;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan koreksi absen.</p>`; return; }

  const steps = await fetchSteps("koreksi", data.map(r => r.id));
  current = { data, steps };
  // Satu baris per "rantai" pengajuan: hanya yang TERBARU. Pengajuan lama yang
  // sudah diajukan ulang tidak jadi baris sendiri — dibuka lewat tombol "Riwayat".
  const heads = data.filter(r => !data.some(x => x.revision_of === r.id));
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal</th><th>Jenis</th><th>Jam Seharusnya</th><th>Alasan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${heads.map(r => {
          const n = chainOf(data, r).length;
          return `
          <tr>
            <td>${fmtDate(r.attendance_date)}</td>
            <td>${esc(typeLabel(r.correction_type))}</td>
            <td>${fmtTime(r.corrected_time)}</td>
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
    if (r) openChainModal("Riwayat Pengajuan Koreksi Absen", data, r, steps, describe);
  }));
}

// Ringkasan satu pengajuan koreksi untuk daftar riwayat.
function describe(r) {
  return `${esc(typeLabel(r.correction_type))} · ${fmtDate(r.attendance_date)} · ${fmtTime(r.corrected_time)}<div class="hist-reason">${esc(r.reason)}</div>`;
}

function typeLabel(t) {
  return t === "masuk" ? "Lupa Absen Masuk" : "Lupa Absen Pulang";
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
