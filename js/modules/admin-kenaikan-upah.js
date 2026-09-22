import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtDate, confirmDialog } from "../core.js";

function getCurrentPeriod(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  if (month >= 3 && month <= 8) {
    return { label: `Periode 1 ${year}`, rangeLabel: `Maret–Agustus ${year}` };
  }
  const periodYear = month <= 2 ? year - 1 : year;
  return { label: `Periode 2 ${periodYear}`, rangeLabel: `September ${periodYear}–Februari ${periodYear + 1}` };
}

let employees = [], levels = [], historyByUser = {};

export async function render(container, user) {
  const period = getCurrentPeriod();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Kenaikan Upah Harian</h1>
        <p class="muted">Riwayat & pengaturan upah harian untuk karyawan berstatus "Harian". Kenaikan diterapkan 2x setahun (50% + 50%) sesuai Kenaikan Upah per Tahun di Master Level.</p>
      </div>
      <button id="btn-apply-period" class="btn-primary">Terapkan Kenaikan — ${period.label}</button>
    </div>
    <p class="small muted" style="margin-top:-16px;">Periode berjalan saat ini: <strong>${period.rangeLabel}</strong></p>
    <div id="wage-table" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>

    <div id="modal-wage" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Atur Upah</h3>
        <form id="form-wage">
          <input type="hidden" name="user_id">
          <div class="form-row">
            <label id="emp-name-label" style="font-weight:600;"></label>
          </div>
          <div class="form-row two-col">
            <label>Upah Harian Baru (Rp) <input type="number" name="daily_wage" min="0" step="1000" required></label>
            <label>Berlaku Mulai <input type="date" name="effective_date" required></label>
          </div>
          <div class="form-row">
            <label>Alasan <input name="reason" required placeholder="Contoh: Upah Awal / Penyesuaian Manual"></label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>

    <div id="modal-preview" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3>Pratinjau Kenaikan — ${period.label}</h3>
        <p class="muted small">Periksa dulu sebelum diterapkan. Karyawan yang sudah pernah menerima kenaikan periode ini tidak akan ditampilkan/diulang.</p>
        <div id="preview-content" class="table-wrap" style="margin:16px 0;"></div>
        <div class="modal-actions">
          <button type="button" id="btn-cancel-preview" class="btn-secondary">Batal</button>
          <button type="button" id="btn-confirm-preview" class="btn-primary">Terapkan ke Semua</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
  document.getElementById("form-wage").addEventListener("submit", e => onSubmitWage(e, user));
  document.getElementById("btn-apply-period").addEventListener("click", () => openPreview(user));
  document.getElementById("btn-cancel-preview").addEventListener("click", closePreview);

  await loadAll();
  renderTable();
}

async function loadAll() {
  const [{ data: emp }, { data: lvl }, { data: hist }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, grade, status_karyawan").eq("status_karyawan", "harian").eq("is_active", true).order("full_name"),
    supabase.from("job_levels").select("grade, upah_harian_pokok, kenaikan_upah_tahunan"),
    supabase.from("wage_history").select("*").order("effective_date", { ascending: false }).order("created_at", { ascending: false }),
  ]);
  employees = emp || [];
  levels = lvl || [];
  historyByUser = {};
  (hist || []).forEach(h => {
    if (!historyByUser[h.user_id]) historyByUser[h.user_id] = [];
    historyByUser[h.user_id].push(h);
  });
}

function latestWage(userId) {
  const rows = historyByUser[userId];
  return rows && rows.length ? rows[0] : null;
}

function renderTable() {
  const el = document.getElementById("wage-table");
  if (!employees.length) { el.innerHTML = `<p class="muted">Belum ada karyawan berstatus Harian.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Grade</th><th>Upah Saat Ini</th><th>Terakhir Diperbarui</th><th></th></tr></thead>
      <tbody>
        ${employees.map(emp => {
          const w = latestWage(emp.id);
          return `
            <tr>
              <td>${emp.full_name}</td>
              <td>${emp.grade || "-"}</td>
              <td>${w ? fmtRupiah(w.daily_wage) : `<span class="muted">Belum diatur</span>`}</td>
              <td>${w ? `${fmtDate(w.effective_date)} — ${w.reason}` : "-"}</td>
              <td><button class="btn-link btn-set-wage" data-id="${emp.id}">${w ? "Sesuaikan" : "Set Upah Awal"}</button></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-set-wage").forEach(btn => {
    btn.addEventListener("click", () => openModal(btn.dataset.id));
  });
}

function openModal(userId) {
  const emp = employees.find(e => e.id === userId);
  const level = levels.find(l => l.grade === emp.grade);
  const w = latestWage(userId);
  const form = document.getElementById("form-wage");
  form.reset();
  form.user_id.value = userId;
  document.getElementById("emp-name-label").textContent = `${emp.full_name} (Grade ${emp.grade || "-"})`;
  document.getElementById("modal-title").textContent = w ? "Sesuaikan Upah" : "Set Upah Awal";
  form.daily_wage.value = w ? w.daily_wage : (level?.upah_harian_pokok || "");
  form.effective_date.value = new Date().toISOString().slice(0, 10);
  form.reason.value = w ? "Penyesuaian Manual" : "Upah Awal";
  document.getElementById("modal-wage").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-wage").classList.add("hidden");
}

async function onSubmitWage(e, user) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    user_id: fd.get("user_id"),
    daily_wage: Number(fd.get("daily_wage")),
    effective_date: fd.get("effective_date"),
    reason: fd.get("reason"),
    created_by: user.id,
  };
  const { error } = await supabase.from("wage_history").insert(payload);
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }
  toast("Upah tersimpan", "success");
  closeModal();
  await loadAll();
  renderTable();
}

// ---------------------------------------------------------------------
// Terapkan kenaikan periode berjalan ke semua karyawan harian yang eligible
// ---------------------------------------------------------------------
function buildPreviewList() {
  const period = getCurrentPeriod();
  const list = [];
  for (const emp of employees) {
    const level = levels.find(l => l.grade === emp.grade);
    if (!level || !level.kenaikan_upah_tahunan) continue;
    const rows = historyByUser[emp.id] || [];
    if (!rows.length) continue; // belum ada upah awal, tidak bisa dihitung kenaikannya
    const already = rows.some(h => h.reason === period.label);
    if (already) continue; // sudah pernah diterapkan periode ini
    const current = rows[0].daily_wage;
    const increase = level.kenaikan_upah_tahunan / 2;
    list.push({ user_id: emp.id, name: emp.full_name, grade: emp.grade, current, increase, newWage: current + increase });
  }
  return { period, list };
}

function openPreview() {
  const { period, list } = buildPreviewList();
  const content = document.getElementById("preview-content");

  if (!list.length) {
    content.innerHTML = `<p class="muted">Tidak ada karyawan yang perlu diterapkan kenaikannya untuk ${period.label} — semua sudah pernah diterapkan, atau belum punya upah awal/kenaikan tahunan di Master Level.</p>`;
    document.getElementById("btn-confirm-preview").classList.add("hidden");
  } else {
    content.innerHTML = `
      <table class="table">
        <thead><tr><th>Nama</th><th>Grade</th><th>Upah Sekarang</th><th>Kenaikan</th><th>Upah Baru</th></tr></thead>
        <tbody>
          ${list.map(r => `
            <tr>
              <td>${r.name}</td><td>${r.grade}</td>
              <td>${fmtRupiah(r.current)}</td><td>+${fmtRupiah(r.increase)}</td><td><strong>${fmtRupiah(r.newWage)}</strong></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    document.getElementById("btn-confirm-preview").classList.remove("hidden");
  }

  document.getElementById("modal-preview").classList.remove("hidden");
  document.getElementById("btn-confirm-preview").onclick = () => confirmApply(period, list);
}

function closePreview() {
  document.getElementById("modal-preview").classList.add("hidden");
}

async function confirmApply(period, list) {
  const ok = await confirmDialog({
    title: `Terapkan kenaikan ${period.label} ke ${list.length} karyawan?`,
    message: "Tindakan ini akan menambah baris riwayat upah baru untuk semua karyawan di daftar. Tidak bisa dibatalkan otomatis setelah tersimpan.",
    confirmLabel: "Ya, Terapkan",
  });
  if (!ok) return;

  const today = new Date().toISOString().slice(0, 10);
  const rows = list.map(r => ({
    user_id: r.user_id,
    effective_date: today,
    daily_wage: r.newWage,
    reason: period.label,
  }));

  const { error } = await supabase.from("wage_history").insert(rows);
  if (error) { toast("Gagal menerapkan: " + error.message, "error"); return; }
  toast(`Kenaikan ${period.label} diterapkan ke ${list.length} karyawan`, "success");
  closePreview();
  await loadAll();
  renderTable();
}
