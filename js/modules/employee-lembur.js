import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtTime, roundOvertimeHours, fmtJam, dayOfWeekFromDateStr } from "../core.js";
import { fetchSteps, stepsHTML } from "../approvalHelper.js";

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Lembur</h1>
      <p class="muted">Ajukan lembur untuk disetujui admin/HR</p>
    </div>

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
      <button type="submit" class="btn-primary btn-block">Kirim Pengajuan</button>
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
    const { error } = await supabase.from("overtime_requests").insert(payload);
    if (error) { toast("Gagal mengirim: " + error.message, "error"); return; }
    toast("Pengajuan lembur terkirim, menunggu approval", "success");
    e.target.reset();
    loadList(user);
  });

  loadList(user);
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
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal</th><th>Jam</th><th>Total Jam</th><th>Jenis Hari</th><th>Keterangan</th><th>Status</th><th>Tahap Approval</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${fmtDate(r.date)}</td>
            <td>${r.start_time?.slice(0, 5)} – ${r.end_time?.slice(0, 5)}</td>
            <td>${fmtJam(r.total_jam ?? roundOvertimeHours(r.start_time, r.end_time))}</td>
            <td>${r.is_hari_libur ? "Hari Libur" : "Hari Biasa"}</td>
            <td>${escapeHtml(r.reason)}</td>
            <td><span class="badge badge-${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${statusLabel(r.status)}</span></td>
            <td>${stepsHTML(r, steps[r.id])}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
