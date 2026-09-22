import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtDate, fmtDateTime, confirmDialog, todayISO } from "../core.js";

// ---------------------------------------------------------------------
// Periode kenaikan — Harian: 2x setahun (Maret & September)
// ---------------------------------------------------------------------
function getCurrentPeriodHarian(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  if (month >= 3 && month <= 8) {
    return { label: `Periode 1 ${year}`, rangeLabel: `Maret–Agustus ${year}` };
  }
  const periodYear = month <= 2 ? year - 1 : year;
  return { label: `Periode 2 ${periodYear}`, rangeLabel: `September ${periodYear}–Februari ${periodYear + 1}` };
}

// Bulanan: 1x setahun, kenaikannya individual per karyawan (bukan per grade)
function getCurrentPeriodBulanan(date = new Date()) {
  const year = date.getFullYear();
  return { label: `Kenaikan Tahun ${year}`, rangeLabel: `Tahun ${year}` };
}

let activeTab = "harian";
let employeesHarian = [], levels = [], historyHarian = {};
let employeesBulanan = [], historyBulanan = {};

export async function render(container, user) {
  const periodHarian = getCurrentPeriodHarian();
  const periodBulanan = getCurrentPeriodBulanan();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Kenaikan Upah &amp; Gaji</h1>
        <p class="muted">Riwayat &amp; pengaturan upah/gaji karyawan, termasuk penerapan kenaikan berkala.</p>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="harian">Karyawan Harian</button>
      <button class="tab-btn" data-tab="bulanan">Karyawan Bulanan</button>
    </div>

    <div id="panel-harian">
      <div class="page-header">
        <p class="muted small" style="max-width:70ch;">Upah harian untuk karyawan berstatus "Harian". Kenaikan diterapkan 2x setahun (Maret &amp; September); nominalnya diinput manual saat menerapkan, bisa disesuaikan per karyawan.</p>
        <button id="btn-apply-period-harian" class="btn-primary">Terapkan Kenaikan — ${periodHarian.label}</button>
      </div>
      <p class="small muted" style="margin-top:-16px;">Periode berjalan saat ini: <strong>${periodHarian.rangeLabel}</strong></p>
      <div id="wage-table-harian" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>
    </div>

    <div id="panel-bulanan" class="hidden">
      <div class="page-header">
        <p class="muted small" style="max-width:70ch;">Gaji bulanan untuk karyawan berstatus "Bulanan". Gaji pokok bersifat individual per karyawan (bukan per grade) — atur lewat "Set Gaji Awal"/"Sesuaikan". Kenaikan tahunan (mengikuti UMK) diinput nominalnya saat menekan tombol di bawah, lalu ditambahkan ke gaji lama masing-masing.</p>
        <button id="btn-apply-period-bulanan" class="btn-primary">Terapkan Kenaikan — ${periodBulanan.label}</button>
      </div>
      <p class="small muted" style="margin-top:-16px;">Periode berjalan saat ini: <strong>${periodBulanan.rangeLabel}</strong></p>
      <div id="wage-table-bulanan" class="table-wrap" style="margin-top:16px;"><p class="muted">Memuat…</p></div>
    </div>

    <!-- Modal: set/sesuaikan upah harian -->
    <div id="modal-wage-harian" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title-harian">Atur Upah</h3>
        <form id="form-wage-harian">
          <input type="hidden" name="user_id">
          <div class="form-row">
            <label id="emp-name-label-harian" style="font-weight:600;"></label>
          </div>
          <div class="form-row two-col">
            <label>Upah Harian Baru (Rp) <input type="number" name="daily_wage" min="0" step="1" required></label>
            <label>Berlaku Mulai <input type="date" name="effective_date" required></label>
          </div>
          <div class="form-row">
            <label>Alasan <input name="reason" required placeholder="Contoh: Upah Awal / Penyesuaian Manual"></label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary btn-cancel-wage-harian">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>

    <div id="modal-preview-harian" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3>Terapkan Kenaikan — ${periodHarian.label}</h3>
        <p class="muted small">Masukkan nominal kenaikannya di sini. Kenaikan ditambahkan ke upah lama masing-masing karyawan. Karyawan yang sudah pernah menerima kenaikan periode ini tidak akan ditampilkan/diulang.</p>
        <div class="form-row two-col" style="align-items:flex-end;">
          <label>Kenaikan (Rp) — isi ke semua baris <input type="number" id="harian-nominal-default" min="0" step="1" placeholder="Contoh: 75000"></label>
          <button type="button" id="btn-fill-nominal-harian" class="btn-secondary">Terapkan Nominal ke Semua Baris</button>
        </div>
        <p class="small muted field-hint">Nilai "Kenaikan" per baris di bawah bisa disesuaikan lagi satu per satu kalau ada karyawan yang naiknya beda.</p>
        <div id="preview-content-harian" class="table-wrap" style="margin:16px 0;"></div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary btn-cancel-preview-harian">Batal</button>
          <button type="button" id="btn-confirm-preview-harian" class="btn-primary">Terapkan ke Semua</button>
        </div>
      </div>
    </div>

    <!-- Modal: set/sesuaikan gaji bulanan -->
    <div id="modal-wage-bulanan" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title-bulanan">Atur Gaji</h3>
        <form id="form-wage-bulanan">
          <input type="hidden" name="user_id">
          <div class="form-row">
            <label id="emp-name-label-bulanan" style="font-weight:600;"></label>
          </div>
          <div class="form-row two-col">
            <label>Gaji Bulanan Baru (Rp) <input type="number" name="monthly_salary" min="0" step="1" required></label>
            <label>Berlaku Mulai <input type="date" name="effective_date" required></label>
          </div>
          <div class="form-row">
            <label>Alasan <input name="reason" required placeholder="Contoh: Gaji Awal / Penyesuaian Manual"></label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary btn-cancel-wage-bulanan">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>

    <div id="modal-preview-bulanan" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3>Terapkan Kenaikan — ${periodBulanan.label}</h3>
        <p class="muted small">Karena besaran kenaikan gaji bulanan mengikuti UMK yang berubah tiap tahun, masukkan nominal kenaikannya di sini (bukan preset). Kenaikan ditambahkan ke gaji lama masing-masing karyawan. Karyawan yang sudah pernah menerima kenaikan tahun ini tidak ditampilkan.</p>
        <div class="form-row two-col" style="align-items:flex-end;">
          <label>Kenaikan (Rp) — isi ke semua baris <input type="number" id="bulanan-nominal-default" min="0" step="1" placeholder="Contoh: 150000"></label>
          <button type="button" id="btn-fill-nominal-bulanan" class="btn-secondary">Terapkan Nominal ke Semua Baris</button>
        </div>
        <p class="small muted field-hint">Nilai "Kenaikan" per baris di bawah bisa disesuaikan lagi satu per satu kalau ada karyawan yang naiknya beda.</p>
        <div id="preview-content-bulanan" class="table-wrap" style="margin:16px 0;"></div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary btn-cancel-preview-bulanan">Batal</button>
          <button type="button" id="btn-confirm-preview-bulanan" class="btn-primary">Terapkan ke Semua</button>
        </div>
      </div>
    </div>

    <!-- Modal: riwayat lengkap (dipakai untuk Harian & Bulanan) -->
    <div id="modal-history" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3 id="history-title">Riwayat</h3>
        <div id="history-content" class="table-wrap" style="margin:16px 0;"></div>
        <div class="modal-actions">
          <button type="button" id="btn-close-history" class="btn-secondary">Tutup</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btn-close-history").addEventListener("click", closeHistoryModal);

  // Tabs
  container.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Harian wiring
  container.querySelectorAll(".btn-cancel-wage-harian").forEach(b => b.addEventListener("click", closeModalHarian));
  document.getElementById("form-wage-harian").addEventListener("submit", e => onSubmitWageHarian(e, user));
  document.getElementById("btn-apply-period-harian").addEventListener("click", () => openPreviewHarian());
  container.querySelectorAll(".btn-cancel-preview-harian").forEach(b => b.addEventListener("click", closePreviewHarian));

  // Bulanan wiring
  container.querySelectorAll(".btn-cancel-wage-bulanan").forEach(b => b.addEventListener("click", closeModalBulanan));
  document.getElementById("form-wage-bulanan").addEventListener("submit", e => onSubmitWageBulanan(e, user));
  document.getElementById("btn-apply-period-bulanan").addEventListener("click", () => openPreviewBulanan());
  container.querySelectorAll(".btn-cancel-preview-bulanan").forEach(b => b.addEventListener("click", closePreviewBulanan));

  await loadHarian();
  renderTableHarian();
  await loadBulanan();
  renderTableBulanan();
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("panel-harian").classList.toggle("hidden", tab !== "harian");
  document.getElementById("panel-bulanan").classList.toggle("hidden", tab !== "bulanan");
}

// =======================================================================
// KARYAWAN HARIAN
// =======================================================================
async function loadHarian() {
  const [{ data: emp }, { data: lvl }, { data: hist }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, grade, status_karyawan").eq("status_karyawan", "harian").eq("is_active", true).order("full_name"),
    supabase.from("job_levels").select("grade, upah_harian_pokok"),
    supabase.from("wage_history").select("*").order("effective_date", { ascending: false }).order("created_at", { ascending: false }),
  ]);
  employeesHarian = emp || [];
  levels = lvl || [];
  historyHarian = {};
  (hist || []).forEach(h => {
    if (!historyHarian[h.user_id]) historyHarian[h.user_id] = [];
    historyHarian[h.user_id].push(h);
  });
}

function latestWageHarian(userId) {
  const rows = historyHarian[userId];
  return rows && rows.length ? rows[0] : null;
}

function renderTableHarian() {
  const el = document.getElementById("wage-table-harian");
  if (!employeesHarian.length) { el.innerHTML = `<p class="muted">Belum ada karyawan berstatus Harian.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Grade</th><th>Upah Saat Ini</th><th>Terakhir Diperbarui</th><th></th></tr></thead>
      <tbody>
        ${employeesHarian.map(emp => {
          const w = latestWageHarian(emp.id);
          return `
            <tr>
              <td>${emp.full_name}</td>
              <td>${emp.grade || "-"}</td>
              <td>${w ? fmtRupiah(w.daily_wage) : `<span class="muted">Belum diatur</span>`}</td>
              <td>${w ? `${fmtDate(w.effective_date)} — ${w.reason}` : "-"}</td>
              <td>
                <button class="btn-link btn-set-wage-harian" data-id="${emp.id}">${w ? "Sesuaikan" : "Set Upah Awal"}</button>
                ${w ? `<button class="btn-link btn-history-harian" data-id="${emp.id}" style="margin-left:10px;">Riwayat</button>` : ""}
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-set-wage-harian").forEach(btn => {
    btn.addEventListener("click", () => openModalHarian(btn.dataset.id));
  });
  el.querySelectorAll(".btn-history-harian").forEach(btn => {
    btn.addEventListener("click", () => openHistoryHarian(btn.dataset.id));
  });
}

function openModalHarian(userId) {
  const emp = employeesHarian.find(e => e.id === userId);
  const level = levels.find(l => l.grade === emp.grade);
  const w = latestWageHarian(userId);
  const form = document.getElementById("form-wage-harian");
  form.reset();
  form.user_id.value = userId;
  document.getElementById("emp-name-label-harian").textContent = `${emp.full_name} (Grade ${emp.grade || "-"})`;
  document.getElementById("modal-title-harian").textContent = w ? "Sesuaikan Upah" : "Set Upah Awal";
  form.daily_wage.value = w ? w.daily_wage : (level?.upah_harian_pokok || "");
  form.effective_date.value = todayISO();
  form.reason.value = w ? "Penyesuaian Manual" : "Upah Awal";
  document.getElementById("modal-wage-harian").classList.remove("hidden");
}

function closeModalHarian() {
  document.getElementById("modal-wage-harian").classList.add("hidden");
}

async function onSubmitWageHarian(e, user) {
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
  closeModalHarian();
  await loadHarian();
  renderTableHarian();
}

function buildEligibleListHarian() {
  // Karyawan yang sudah punya upah awal, dan belum pernah dapat kenaikan periode ini.
  const period = getCurrentPeriodHarian();
  const list = [];
  for (const emp of employeesHarian) {
    const rows = historyHarian[emp.id] || [];
    if (!rows.length) continue; // belum ada upah awal, tidak bisa dihitung kenaikannya
    const already = rows.some(h => h.reason === period.label);
    if (already) continue; // sudah pernah diterapkan periode ini
    list.push({ user_id: emp.id, name: emp.full_name, grade: emp.grade, current: rows[0].daily_wage });
  }
  return { period, list };
}

function rowInputIdHarian(userId) { return `harian-kenaikan-${userId}`; }
function rowNewWageIdHarian(userId) { return `harian-baru-${userId}`; }

function updateRowNewWageHarian(userId, current) {
  const input = document.getElementById(rowInputIdHarian(userId));
  const target = document.getElementById(rowNewWageIdHarian(userId));
  const increase = Number(input.value) || 0;
  target.textContent = fmtRupiah(current + increase);
}

function openPreviewHarian() {
  const { period, list } = buildEligibleListHarian();
  const content = document.getElementById("preview-content-harian");
  const nominalInput = document.getElementById("harian-nominal-default");
  nominalInput.value = "";

  if (!list.length) {
    content.innerHTML = `<p class="muted">Tidak ada karyawan yang perlu diterapkan kenaikannya untuk ${period.label} — semua sudah pernah diterapkan periode ini, atau belum punya upah awal.</p>`;
    document.getElementById("btn-confirm-preview-harian").classList.add("hidden");
    document.getElementById("btn-fill-nominal-harian").classList.add("hidden");
  } else {
    content.innerHTML = `
      <table class="table">
        <thead><tr><th>Nama</th><th>Grade</th><th>Upah Sekarang</th><th>Kenaikan (Rp)</th><th>Upah Baru</th></tr></thead>
        <tbody>
          ${list.map(r => `
            <tr>
              <td>${r.name}</td><td>${r.grade || "-"}</td>
              <td>${fmtRupiah(r.current)}</td>
              <td><input type="number" id="${rowInputIdHarian(r.user_id)}" min="0" step="1" value="0" style="width:130px;"></td>
              <td><strong id="${rowNewWageIdHarian(r.user_id)}">${fmtRupiah(r.current)}</strong></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    list.forEach(r => {
      document.getElementById(rowInputIdHarian(r.user_id)).addEventListener("input", () => updateRowNewWageHarian(r.user_id, r.current));
    });
    document.getElementById("btn-confirm-preview-harian").classList.remove("hidden");
    document.getElementById("btn-fill-nominal-harian").classList.remove("hidden");
  }

  document.getElementById("modal-preview-harian").classList.remove("hidden");
  document.getElementById("btn-fill-nominal-harian").onclick = () => {
    const val = nominalInput.value;
    list.forEach(r => {
      document.getElementById(rowInputIdHarian(r.user_id)).value = val;
      updateRowNewWageHarian(r.user_id, r.current);
    });
  };
  document.getElementById("btn-confirm-preview-harian").onclick = () => confirmApplyHarian(period, list);
}

function closePreviewHarian() {
  document.getElementById("modal-preview-harian").classList.add("hidden");
}

async function confirmApplyHarian(period, list) {
  // Ambil nilai kenaikan terbaru dari masing-masing input di tabel pratinjau.
  const rowsToApply = list
    .map(r => ({ ...r, increase: Number(document.getElementById(rowInputIdHarian(r.user_id)).value) || 0 }))
    .filter(r => r.increase > 0); // karyawan dengan kenaikan 0/kosong dilewati, tidak dibuat riwayat baru

  if (!rowsToApply.length) {
    toast("Belum ada nominal kenaikan yang diisi.", "error");
    return;
  }

  const ok = await confirmDialog({
    title: `Terapkan kenaikan ${period.label} ke ${rowsToApply.length} karyawan?`,
    message: `${rowsToApply.length} dari ${list.length} karyawan akan mendapat riwayat upah baru (yang kenaikannya kosong/0 dilewati). Tidak bisa dibatalkan otomatis setelah tersimpan.`,
    confirmLabel: "Ya, Terapkan",
  });
  if (!ok) return;

  const today = todayISO();
  const rows = rowsToApply.map(r => ({
    user_id: r.user_id,
    effective_date: today,
    daily_wage: r.current + r.increase,
    reason: period.label,
  }));

  const { error } = await supabase.from("wage_history").insert(rows);
  if (error) { toast("Gagal menerapkan: " + error.message, "error"); return; }
  toast(`Kenaikan ${period.label} diterapkan ke ${rowsToApply.length} karyawan`, "success");
  closePreviewHarian();
  await loadHarian();
  renderTableHarian();
}

// =======================================================================
// KARYAWAN BULANAN
// =======================================================================
async function loadBulanan() {
  const [{ data: emp }, { data: hist }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, grade, status_karyawan").eq("status_karyawan", "bulanan").eq("is_active", true).order("full_name"),
    supabase.from("salary_history").select("*").order("effective_date", { ascending: false }).order("created_at", { ascending: false }),
  ]);
  employeesBulanan = emp || [];
  historyBulanan = {};
  (hist || []).forEach(h => {
    if (!historyBulanan[h.user_id]) historyBulanan[h.user_id] = [];
    historyBulanan[h.user_id].push(h);
  });
}

function latestSalaryBulanan(userId) {
  const rows = historyBulanan[userId];
  return rows && rows.length ? rows[0] : null;
}

function renderTableBulanan() {
  const el = document.getElementById("wage-table-bulanan");
  if (!employeesBulanan.length) { el.innerHTML = `<p class="muted">Belum ada karyawan berstatus Bulanan.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Grade</th><th>Gaji Saat Ini</th><th>Terakhir Diperbarui</th><th></th></tr></thead>
      <tbody>
        ${employeesBulanan.map(emp => {
          const s = latestSalaryBulanan(emp.id);
          return `
            <tr>
              <td>${emp.full_name}</td>
              <td>${emp.grade || "-"}</td>
              <td>${s ? fmtRupiah(s.monthly_salary) : `<span class="muted">Belum diatur</span>`}</td>
              <td>${s ? `${fmtDate(s.effective_date)} — ${s.reason}` : "-"}</td>
              <td>
                <button class="btn-link btn-set-wage-bulanan" data-id="${emp.id}">${s ? "Sesuaikan" : "Set Gaji Awal"}</button>
                ${s ? `<button class="btn-link btn-history-bulanan" data-id="${emp.id}" style="margin-left:10px;">Riwayat</button>` : ""}
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-set-wage-bulanan").forEach(btn => {
    btn.addEventListener("click", () => openModalBulanan(btn.dataset.id));
  });
  el.querySelectorAll(".btn-history-bulanan").forEach(btn => {
    btn.addEventListener("click", () => openHistoryBulanan(btn.dataset.id));
  });
}

function openModalBulanan(userId) {
  const emp = employeesBulanan.find(e => e.id === userId);
  const s = latestSalaryBulanan(userId);
  const form = document.getElementById("form-wage-bulanan");
  form.reset();
  form.user_id.value = userId;
  document.getElementById("emp-name-label-bulanan").textContent = `${emp.full_name} (Grade ${emp.grade || "-"})`;
  document.getElementById("modal-title-bulanan").textContent = s ? "Sesuaikan Gaji" : "Set Gaji Awal";
  form.monthly_salary.value = s ? s.monthly_salary : "";
  form.effective_date.value = todayISO();
  form.reason.value = s ? "Penyesuaian Manual" : "Gaji Awal";
  document.getElementById("modal-wage-bulanan").classList.remove("hidden");
}

function closeModalBulanan() {
  document.getElementById("modal-wage-bulanan").classList.add("hidden");
}

async function onSubmitWageBulanan(e, user) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    user_id: fd.get("user_id"),
    monthly_salary: Number(fd.get("monthly_salary")),
    annual_increase: 0,
    effective_date: fd.get("effective_date"),
    reason: fd.get("reason"),
    created_by: user.id,
  };
  const { error } = await supabase.from("salary_history").insert(payload);
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }
  toast("Gaji tersimpan", "success");
  closeModalBulanan();
  await loadBulanan();
  renderTableBulanan();
}

function buildEligibleListBulanan() {
  // Karyawan yang sudah punya gaji awal, dan belum pernah dapat kenaikan periode ini.
  const period = getCurrentPeriodBulanan();
  const list = [];
  for (const emp of employeesBulanan) {
    const rows = historyBulanan[emp.id] || [];
    if (!rows.length) continue; // belum ada gaji awal, tidak bisa dihitung kenaikannya
    const already = rows.some(h => h.reason === period.label);
    if (already) continue; // sudah pernah diterapkan tahun ini
    list.push({ user_id: emp.id, name: emp.full_name, grade: emp.grade, current: rows[0].monthly_salary });
  }
  return { period, list };
}

function rowInputId(userId) { return `bulanan-kenaikan-${userId}`; }
function rowNewSalaryId(userId) { return `bulanan-baru-${userId}`; }

function updateRowNewSalary(userId, current) {
  const input = document.getElementById(rowInputId(userId));
  const target = document.getElementById(rowNewSalaryId(userId));
  const increase = Number(input.value) || 0;
  target.textContent = fmtRupiah(current + increase);
}

function openPreviewBulanan() {
  const { period, list } = buildEligibleListBulanan();
  const content = document.getElementById("preview-content-bulanan");
  const nominalInput = document.getElementById("bulanan-nominal-default");
  nominalInput.value = "";

  if (!list.length) {
    content.innerHTML = `<p class="muted">Tidak ada karyawan yang perlu diterapkan kenaikannya untuk ${period.label} — semua sudah pernah diterapkan tahun ini, atau belum punya gaji awal.</p>`;
    document.getElementById("btn-confirm-preview-bulanan").classList.add("hidden");
    document.getElementById("btn-fill-nominal-bulanan").classList.add("hidden");
  } else {
    content.innerHTML = `
      <table class="table">
        <thead><tr><th>Nama</th><th>Grade</th><th>Gaji Sekarang</th><th>Kenaikan (Rp)</th><th>Gaji Baru</th></tr></thead>
        <tbody>
          ${list.map(r => `
            <tr>
              <td>${r.name}</td><td>${r.grade || "-"}</td>
              <td>${fmtRupiah(r.current)}</td>
              <td><input type="number" id="${rowInputId(r.user_id)}" min="0" step="1" value="0" style="width:130px;"></td>
              <td><strong id="${rowNewSalaryId(r.user_id)}">${fmtRupiah(r.current)}</strong></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    list.forEach(r => {
      document.getElementById(rowInputId(r.user_id)).addEventListener("input", () => updateRowNewSalary(r.user_id, r.current));
    });
    document.getElementById("btn-confirm-preview-bulanan").classList.remove("hidden");
    document.getElementById("btn-fill-nominal-bulanan").classList.remove("hidden");
  }

  document.getElementById("modal-preview-bulanan").classList.remove("hidden");
  document.getElementById("btn-fill-nominal-bulanan").onclick = () => {
    const val = nominalInput.value;
    list.forEach(r => {
      document.getElementById(rowInputId(r.user_id)).value = val;
      updateRowNewSalary(r.user_id, r.current);
    });
  };
  document.getElementById("btn-confirm-preview-bulanan").onclick = () => confirmApplyBulanan(period, list);
}

function closePreviewBulanan() {
  document.getElementById("modal-preview-bulanan").classList.add("hidden");
}

async function confirmApplyBulanan(period, list) {
  // Ambil nilai kenaikan terbaru dari masing-masing input di tabel pratinjau.
  const rowsToApply = list
    .map(r => ({ ...r, increase: Number(document.getElementById(rowInputId(r.user_id)).value) || 0 }))
    .filter(r => r.increase > 0); // karyawan dengan kenaikan 0/kosong dilewati, tidak dibuat riwayat baru

  if (!rowsToApply.length) {
    toast("Belum ada nominal kenaikan yang diisi.", "error");
    return;
  }

  const ok = await confirmDialog({
    title: `Terapkan kenaikan ${period.label} ke ${rowsToApply.length} karyawan?`,
    message: `${rowsToApply.length} dari ${list.length} karyawan akan mendapat riwayat gaji baru (yang kenaikannya kosong/0 dilewati). Tidak bisa dibatalkan otomatis setelah tersimpan.`,
    confirmLabel: "Ya, Terapkan",
  });
  if (!ok) return;

  const today = todayISO();
  const rows = rowsToApply.map(r => ({
    user_id: r.user_id,
    effective_date: today,
    monthly_salary: r.current + r.increase,
    annual_increase: r.increase,
    reason: period.label,
  }));

  const { error } = await supabase.from("salary_history").insert(rows);
  if (error) { toast("Gagal menerapkan: " + error.message, "error"); return; }
  toast(`Kenaikan ${period.label} diterapkan ke ${rowsToApply.length} karyawan`, "success");
  closePreviewBulanan();
  await loadBulanan();
  renderTableBulanan();
}

// =======================================================================
// MODAL RIWAYAT (dipakai bersama Harian & Bulanan)
// =======================================================================
function openHistoryHarian(userId) {
  const emp = employeesHarian.find(e => e.id === userId);
  const rows = historyHarian[userId] || [];
  document.getElementById("history-title").textContent = `Riwayat Upah — ${emp.full_name}`;
  document.getElementById("history-content").innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal Berlaku</th><th>Upah Harian</th><th>Alasan</th><th>Dicatat</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => {
          const prev = rows[i + 1]; // baris sesudahnya = lebih lama, karena urut desc
          const delta = prev ? r.daily_wage - prev.daily_wage : null;
          return `
            <tr>
              <td>${fmtDate(r.effective_date)}</td>
              <td>${fmtRupiah(r.daily_wage)}${delta ? ` <span class="muted small">(${delta > 0 ? "+" : ""}${fmtRupiah(delta)})</span>` : ""}</td>
              <td>${r.reason}</td>
              <td>${fmtDateTime(r.created_at)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
  document.getElementById("modal-history").classList.remove("hidden");
}

function openHistoryBulanan(userId) {
  const emp = employeesBulanan.find(e => e.id === userId);
  const rows = historyBulanan[userId] || [];
  document.getElementById("history-title").textContent = `Riwayat Gaji — ${emp.full_name}`;
  document.getElementById("history-content").innerHTML = `
    <table class="table">
      <thead><tr><th>Tanggal Berlaku</th><th>Gaji Bulanan</th><th>Alasan</th><th>Dicatat</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => {
          const prev = rows[i + 1];
          const delta = prev ? r.monthly_salary - prev.monthly_salary : null;
          return `
            <tr>
              <td>${fmtDate(r.effective_date)}</td>
              <td>${fmtRupiah(r.monthly_salary)}${delta ? ` <span class="muted small">(${delta > 0 ? "+" : ""}${fmtRupiah(delta)})</span>` : ""}</td>
              <td>${r.reason}</td>
              <td>${fmtDateTime(r.created_at)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
  document.getElementById("modal-history").classList.remove("hidden");
}

function closeHistoryModal() {
  document.getElementById("modal-history").classList.add("hidden");
}
