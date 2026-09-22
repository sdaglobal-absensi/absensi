import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtJam, fmtDate, dateOnlyISO, roundOvertimeHours, exportXLSX, dayOfWeekFromDateStr, zonedMinutesOfDay, hmToMinutes } from "../core.js";

// =======================================================================
// SLIP GAJI — dihitung otomatis dari data yang sudah ada di sistem:
//   - Gaji pokok: Riwayat Upah Harian (x hari hadir) / Riwayat Gaji Bulanan
//   - Uang lembur: Pengajuan Lembur yang disetujui x tarif di Master Level
//   - Tunjangan Jabatan & Tunjangan Loyalitas: nominal tetap per grade/level
//     di Master Level, otomatis ditambahkan tiap slip.
//   - Denda keterlambatan & pulang cepat: tabel jam bertingkat, diatur
//     manual di menu "Master Denda Telat" (tabel late_penalty_rules).
//     Tier bertipe % dikalikan "Denda Terlambat & Pulang Cepat" (Rp) di
//     Master Level masing-masing grade/level; tier bertipe nominal tetap
//     tidak tergantung denda level. Rincian per-hari tidak ditampilkan di
//     slip gaji karyawan, hanya totalnya.
//   - BPJS, PPh21, uang dinas: tarif di Master Level
// Komponen yang tidak tercatat otomatis (dinas, tunjangan/potongan lain)
// diisi manual per periode lewat "Edit Tunjangan/Potongan" dan disimpan
// ke tabel payroll_adjustments supaya tidak hilang saat dibuka ulang.
// =======================================================================

// ---------------------------------------------------------------------
// POTONGAN KETERLAMBATAN & PULANG CEPAT
// Aturan (jam & persen/nominal) diambil dari tabel late_penalty_rules
// (di-load ke penaltyRules saat loadData), bukan hardcode lagi di sini.
// ---------------------------------------------------------------------

// Keterlambatan: tier diurutkan naik (jam paling pagi -> paling siang).
// Yang dipakai adalah tier PALING TERAKHIR yang jam absennya sudah
// terlampaui (jadi makin siang datangnya, makin besar potongannya).
function hitungDendaTelat(checkInAt, dayOfWeek, dendaDasar) {
  if (!checkInAt || dayOfWeek < 1 || dayOfWeek > 6) return null; // Minggu/tidak absen: tidak ada aturan
  const dayType = dayOfWeek === 6 ? "saturday" : "weekday";
  const rules = penaltyRules.telat[dayType] || [];
  const mins = zonedMinutesOfDay(checkInAt);
  let picked = null;
  for (const r of rules) {
    if (mins > hmToMinutes(r.jam)) picked = r;
  }
  if (!picked) return null;
  const amount = picked.tipe === "flat" ? picked.nominal : dendaDasar * picked.persen / 100;
  return { amount, label: picked.label };
}

// Pulang cepat: tier diurutkan naik (jam paling pagi -> paling siang).
// Yang dipakai adalah tier PERTAMA yang jam pulangnya masih di bawah
// batas (jadi makin awal pulangnya, makin besar potongannya).
function hitungDendaPulangCepat(checkOutAt, dayOfWeek, dendaDasar) {
  if (!checkOutAt || dayOfWeek < 1 || dayOfWeek > 6) return null;
  const dayType = dayOfWeek === 6 ? "saturday" : "weekday";
  const rules = penaltyRules.pulang_cepat[dayType] || [];
  const mins = zonedMinutesOfDay(checkOutAt);
  for (const r of rules) {
    if (mins < hmToMinutes(r.jam)) {
      const amount = r.tipe === "flat" ? r.nominal : dendaDasar * r.persen / 100;
      return { amount, label: r.label };
    }
  }
  return null;
}

let period = "";
let employees = [];
let jobLevels = [];
let wageByUser = {};
let salaryByUser = {};
let attendanceByUser = {};
let overtimeByUser = {};
let adjByUser = {};
let penaltyRules = { telat: { weekday: [], saturday: [] }, pulang_cepat: { weekday: [], saturday: [] } };
let currentSlip = null; // slip yang sedang dibuka di modal detail

export async function render(container, user) {
  period = dateOnlyISO(new Date()).slice(0, 7);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Slip Gaji</h1>
        <p class="muted">Dihitung otomatis dari absensi, lembur, riwayat upah/gaji, dan Master Level. Tunjangan/potongan yang tidak tercatat otomatis bisa ditambahkan manual per karyawan.</p>
      </div>
      <div class="filter-row">
        <input type="month" id="filter-period" value="${period}">
        <button id="btn-export" class="btn-secondary">Export Ringkasan (Excel)</button>
      </div>
    </div>

    <div id="slip-summary" class="status-grid"></div>
    <div id="slip-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <!-- Modal: detail & cetak slip -->
    <div id="modal-slip" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <div class="modal-actions no-print" style="justify-content:space-between; margin-bottom:14px;">
          <button type="button" id="btn-edit-adjust" class="btn-secondary">✏️ Edit Tunjangan/Potongan</button>
          <div style="display:flex; gap:10px;">
            <button type="button" id="btn-print-slip" class="btn-secondary">🖨️ Cetak / Simpan PDF</button>
            <button type="button" id="btn-close-slip" class="btn-primary">Tutup</button>
          </div>
        </div>
        <div id="slip-content" class="slip-print-area"></div>
      </div>
    </div>

    <!-- Modal: edit penyesuaian manual -->
    <div id="modal-adjust" class="modal hidden">
      <div class="modal-box">
        <h3>Tunjangan &amp; Potongan Manual</h3>
        <p class="muted small" id="adjust-emp-label" style="margin-top:-4px;"></p>
        <form id="form-adjust">
          <div class="form-row two-col">
            <label>Hari Perjalanan Dinas <input type="number" name="hari_dinas" min="0" step="1" value="0"></label>
            <label>Tunjangan Lain (Rp) <input type="number" name="tunjangan_lain" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Keterangan Tunjangan Lain <input name="keterangan_tunjangan" placeholder="Contoh: Bonus, THR, dsb"></label>
          </div>
          <div class="form-row">
            <label>Potongan Lain (Rp) <input type="number" name="potongan_lain" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Keterangan Potongan Lain <input name="keterangan_potongan" placeholder="Contoh: Kasbon, pinjaman, dsb"></label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-adjust" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("filter-period").addEventListener("change", e => { period = e.target.value; loadAndRender(); });
  document.getElementById("btn-export").addEventListener("click", doExport);
  document.getElementById("btn-close-slip").addEventListener("click", () => document.getElementById("modal-slip").classList.add("hidden"));
  document.getElementById("btn-print-slip").addEventListener("click", () => window.print());
  document.getElementById("btn-edit-adjust").addEventListener("click", () => openAdjustModal(currentSlip.emp.id));
  document.getElementById("btn-cancel-adjust").addEventListener("click", () => document.getElementById("modal-adjust").classList.add("hidden"));
  document.getElementById("form-adjust").addEventListener("submit", e => onSubmitAdjust(e, user));

  await loadAndRender();
}

// -----------------------------------------------------------------------
async function loadAndRender() {
  const el = document.getElementById("slip-table");
  el.innerHTML = `<p class="muted">Memuat…</p>`;
  await loadData(period);
  renderSummary();
  renderTable();
}

async function loadData(p) {
  const start = `${p}-01`;
  const [y, m] = p.split("-").map(Number);
  const end = dateOnlyISO(new Date(y, m, 0)); // tanggal terakhir bulan tsb

  const [{ data: emp, error: errEmp }, { data: levels }, { data: wages }, { data: salaries }, { data: att }, { data: ot }, { data: adj }, { data: rules }] = await Promise.all([
    supabase.from("profiles").select("*").eq("is_active", true).order("full_name"),
    supabase.from("job_levels").select("*"),
    supabase.from("wage_history").select("*").lte("effective_date", end).order("effective_date", { ascending: false }),
    supabase.from("salary_history").select("*").lte("effective_date", end).order("effective_date", { ascending: false }),
    supabase.from("attendance").select("*").gte("date", start).lte("date", end),
    supabase.from("overtime_requests").select("*").eq("status", "approved").gte("date", start).lte("date", end),
    supabase.from("payroll_adjustments").select("*").eq("period", p),
    supabase.from("late_penalty_rules").select("*").eq("is_active", true).order("jam", { ascending: true }),
  ]);

  if (errEmp) { toast("Gagal memuat data karyawan: " + errEmp.message, "error"); }

  employees = emp || []; // semua karyawan aktif, termasuk yg status/grade-nya belum diatur (biar admin tahu perlu dilengkapi)
  jobLevels = levels || [];

  wageByUser = groupByUserSorted(wages);
  salaryByUser = groupByUserSorted(salaries);

  attendanceByUser = {};
  (att || []).forEach(a => { (attendanceByUser[a.user_id] ??= []).push(a); });

  overtimeByUser = {};
  (ot || []).forEach(o => { (overtimeByUser[o.user_id] ??= []).push(o); });

  adjByUser = {};
  (adj || []).forEach(a => { adjByUser[a.user_id] = a; });

  penaltyRules = { telat: { weekday: [], saturday: [] }, pulang_cepat: { weekday: [], saturday: [] } };
  (rules || []).forEach(r => { (penaltyRules[r.jenis]?.[r.day_type] ?? []).push(r); });
}

function groupByUserSorted(rows) {
  const map = {};
  (rows || []).forEach(r => { (map[r.user_id] ??= []).push(r); });
  return map; // sudah urut desc dari query
}

// -----------------------------------------------------------------------
// PERHITUNGAN SATU SLIP
// -----------------------------------------------------------------------
function computeSlip(emp) {
  const level = jobLevels.find(l => l.grade === emp.grade && l.level === emp.level) || null;
  const attRows = attendanceByUser[emp.id] || [];
  const hariHadir = attRows.filter(a => a.check_in).length;
  const hariTelat = attRows.filter(a => a.check_in_status === "telat").length;

  const otRows = overtimeByUser[emp.id] || [];
  const jamHari = (o) => o.total_jam ?? roundOvertimeHours(o.start_time, o.end_time);
  const jamLemburBiasa = otRows.filter(o => !o.is_hari_libur).reduce((s, o) => s + jamHari(o), 0);
  const jamLemburLibur = otRows.filter(o => o.is_hari_libur).reduce((s, o) => s + jamHari(o), 0);

  // Denda keterlambatan & pulang cepat — dihitung per hari dari jam
  // check-in/check-out asli terhadap tabel jam bertingkat di Master Denda
  // Telat (bukan dari status telat/tepat-waktu jadwal kerja, yang dipakai
  // untuk keperluan monitoring absensi saja). Hanya totalnya yang tampil
  // di slip gaji karyawan, rincian per hari tidak dicetak.
  let dendaKeterlambatan = 0;
  let dendaPulangCepat = 0;
  const dendaDasar = level?.denda_terlambat || 0;
  for (const a of attRows) {
    const dow = dayOfWeekFromDateStr(a.date);
    const telat = hitungDendaTelat(a.check_in, dow, dendaDasar);
    if (telat) dendaKeterlambatan += telat.amount;
    const cepat = hitungDendaPulangCepat(a.check_out, dow, dendaDasar);
    if (cepat) dendaPulangCepat += cepat.amount;
  }

  const adj = adjByUser[emp.id] || { hari_dinas: 0, tunjangan_lain: 0, keterangan_tunjangan: "", potongan_lain: 0, keterangan_potongan: "" };

  let gajiPokok = 0;
  let gajiPokokLabel = "-";
  if (emp.status_karyawan === "bulanan") {
    const s = (salaryByUser[emp.id] || [])[0];
    gajiPokok = s ? s.monthly_salary : 0;
    gajiPokokLabel = "Gaji Bulanan";
  } else if (emp.status_karyawan === "harian") {
    const w = (wageByUser[emp.id] || [])[0];
    gajiPokok = w ? w.daily_wage * hariHadir : 0;
    gajiPokokLabel = w ? `Upah Harian (${fmtRupiah(w.daily_wage)} x ${hariHadir} hari)` : "Upah Harian";
  }

  const rateLemburBiasa = level?.upah_lembur_hari_biasa || 0;
  const rateLemburLibur = level?.upah_lembur_hari_libur || 0;
  const uangLembur = jamLemburBiasa * rateLemburBiasa + jamLemburLibur * rateLemburLibur;
  const uangDinas = (adj.hari_dinas || 0) * (level?.uang_perjalanan_dinas || 0);
  const tunjanganJabatan = level?.tunjangan_jabatan || 0;
  const tunjanganLoyalitas = level?.tunjangan_loyalitas || 0;
  const tunjanganLain = adj.tunjangan_lain || 0;
  const totalPendapatan = gajiPokok + uangLembur + uangDinas + tunjanganJabatan + tunjanganLoyalitas + tunjanganLain;

  const upahLapor = level?.upah_lapor_bpjs || 0;
  const bpjsKesKaryawan = upahLapor * (level?.bpjs_kesehatan_karyawan_persen || 0) / 100;
  const bpjsTkKaryawan = upahLapor * (level?.bpjs_tk_karyawan_persen || 0) / 100;
  const pph21 = totalPendapatan * (level?.pph21_persen || 0) / 100;
  const potonganLain = adj.potongan_lain || 0;
  const totalPotongan = dendaKeterlambatan + dendaPulangCepat + bpjsKesKaryawan + bpjsTkKaryawan + pph21 + potonganLain;

  const gajiBersih = totalPendapatan - totalPotongan;

  return {
    emp, level, adj, hariHadir, hariTelat, jamLemburBiasa, jamLemburLibur,
    gajiPokok, gajiPokokLabel, rateLemburBiasa, rateLemburLibur, uangLembur, uangDinas, tunjanganJabatan, tunjanganLoyalitas, tunjanganLain, totalPendapatan,
    dendaKeterlambatan, dendaPulangCepat, upahLapor, bpjsKesKaryawan, bpjsTkKaryawan, pph21, potonganLain, totalPotongan, gajiBersih,
  };
}

// -----------------------------------------------------------------------
function renderSummary() {
  const slips = employees.map(computeSlip);
  const totalBersih = slips.reduce((s, x) => s + x.gajiBersih, 0);
  const totalLembur = slips.reduce((s, x) => s + x.jamLemburBiasa + x.jamLemburLibur, 0);
  const belumDiatur = slips.filter(x => !x.emp.status_karyawan).length;

  document.getElementById("slip-summary").innerHTML = `
    <div class="status-card">
      <span class="status-label">Karyawan Aktif</span>
      <span class="status-value">${slips.length}</span>
    </div>
    <div class="status-card done">
      <span class="status-label">Total Gaji Bersih</span>
      <span class="status-value">${fmtRupiah(totalBersih)}</span>
    </div>
    <div class="status-card">
      <span class="status-label">Total Jam Lembur</span>
      <span class="status-value">${fmtJam(totalLembur)}</span>
    </div>
    ${belumDiatur ? `
    <div class="status-card">
      <span class="status-label">Status Karyawan Belum Diatur</span>
      <span class="status-value">${belumDiatur}</span>
    </div>` : ""}
  `;
}

function renderTable() {
  const el = document.getElementById("slip-table");
  if (!employees.length) { el.innerHTML = `<p class="muted">Belum ada data karyawan aktif.</p>`; return; }

  const slips = employees.map(computeSlip);

  el.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Nama</th><th>Grade</th><th>Status</th>
          <th>Hadir / Telat</th><th>Lembur</th>
          <th>Gaji Pokok</th><th>Gaji Bersih</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${slips.map(s => `
          <tr>
            <td>${s.emp.full_name}</td>
            <td>${s.emp.grade ? `${s.emp.grade} — ${s.emp.level || "-"}` : `<span class="muted">-</span>`}</td>
            <td>${s.emp.status_karyawan
              ? `<span class="badge badge-ok">${s.emp.status_karyawan === "bulanan" ? "Bulanan" : "Harian"}</span>`
              : `<span class="badge badge-warn">Belum diatur</span>`}</td>
            <td>${s.hariHadir} / ${s.hariTelat}</td>
            <td>${fmtJam(s.jamLemburBiasa + s.jamLemburLibur)}</td>
            <td>${fmtRupiah(s.gajiPokok)}</td>
            <td><strong>${fmtRupiah(s.gajiBersih)}</strong></td>
            <td><button class="btn-link btn-detail" data-id="${s.emp.id}">Detail &amp; Cetak</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-detail").forEach(btn => {
    btn.addEventListener("click", () => openSlipModal(btn.dataset.id));
  });
}

// -----------------------------------------------------------------------
// MODAL DETAIL SLIP
// -----------------------------------------------------------------------
function periodLabel(p) {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

function openSlipModal(userId) {
  const emp = employees.find(e => e.id === userId);
  currentSlip = computeSlip(emp);
  renderSlipContent(currentSlip);
  document.getElementById("modal-slip").classList.remove("hidden");
}

function renderSlipContent(s) {
  const e = s.emp;
  document.getElementById("slip-content").innerHTML = `
    <div class="slip-box">
      <div class="slip-header">
        <div>
          <h2>${e.unit_pt || "Slip Gaji"}</h2>
          <p class="muted small" style="margin-top:2px;">Slip Gaji Karyawan</p>
        </div>
        <div class="slip-period">
          <div class="muted small">Periode</div>
          <div style="font-weight:600;">${periodLabel(period)}</div>
        </div>
      </div>

      <div class="slip-emp-grid">
        <div><span class="label">Nama</span>${e.full_name}</div>
        <div><span class="label">Kode Karyawan</span>${e.employee_code || "-"}</div>
        <div><span class="label">Jabatan</span>${e.position || "-"}</div>
        <div><span class="label">Departemen</span>${e.department || "-"}${e.bagian ? ` / ${e.bagian}` : ""}</div>
        <div><span class="label">Grade / Level</span>${e.grade ? `${e.grade} — ${e.level || "-"}` : "-"}</div>
        <div><span class="label">Status Karyawan</span>${e.status_karyawan === "bulanan" ? "Bulanan" : e.status_karyawan === "harian" ? "Harian" : "Belum diatur"}</div>
        <div><span class="label">Hari Hadir / Telat</span>${s.hariHadir} / ${s.hariTelat}</div>
        <div><span class="label">Jam Lembur (Biasa/Libur)</span>${fmtJam(s.jamLemburBiasa)} / ${fmtJam(s.jamLemburLibur)}</div>
      </div>

      <div class="slip-cols">
        <div class="slip-col">
          <h4>Pendapatan</h4>
          <div class="slip-line"><span>${s.gajiPokokLabel}</span><span>${fmtRupiah(s.gajiPokok)}</span></div>
          <div class="slip-line"><span>Uang Lembur (${fmtJam(s.jamLemburBiasa)} biasa + ${fmtJam(s.jamLemburLibur)} libur)</span><span>${fmtRupiah(s.uangLembur)}</span></div>
          <div class="slip-line"><span>Uang Perjalanan Dinas (${s.adj.hari_dinas || 0} hari)</span><span>${fmtRupiah(s.uangDinas)}</span></div>
          <div class="slip-line"><span>Tunjangan Jabatan</span><span>${fmtRupiah(s.tunjanganJabatan)}</span></div>
          <div class="slip-line"><span>Tunjangan Loyalitas</span><span>${fmtRupiah(s.tunjanganLoyalitas)}</span></div>
          <div class="slip-line"><span>${s.adj.keterangan_tunjangan || "Tunjangan Lain"}</span><span>${fmtRupiah(s.tunjanganLain)}</span></div>
          <div class="slip-line total"><span>Total Pendapatan</span><span>${fmtRupiah(s.totalPendapatan)}</span></div>
        </div>
        <div class="slip-col">
          <h4>Potongan</h4>
          <div class="slip-line"><span>Denda Keterlambatan</span><span>${fmtRupiah(s.dendaKeterlambatan)}</span></div>
          <div class="slip-line"><span>Denda Pulang Cepat</span><span>${fmtRupiah(s.dendaPulangCepat)}</span></div>
          <div class="slip-line"><span>BPJS Kesehatan (${s.level?.bpjs_kesehatan_karyawan_persen ?? 0}%)</span><span>${fmtRupiah(s.bpjsKesKaryawan)}</span></div>
          <div class="slip-line"><span>BPJS Ketenagakerjaan (${s.level?.bpjs_tk_karyawan_persen ?? 0}%)</span><span>${fmtRupiah(s.bpjsTkKaryawan)}</span></div>
          <div class="slip-line"><span>PPh21 (${s.level?.pph21_persen ?? 0}%)</span><span>${fmtRupiah(s.pph21)}</span></div>
          <div class="slip-line"><span>${s.adj.keterangan_potongan || "Potongan Lain"}</span><span>${fmtRupiah(s.potonganLain)}</span></div>
          <div class="slip-line total"><span>Total Potongan</span><span>${fmtRupiah(s.totalPotongan)}</span></div>
        </div>
      </div>

      <div class="slip-net">
        <span class="label">Gaji Bersih (Take Home Pay)</span>
        <span class="value">${fmtRupiah(s.gajiBersih)}</span>
      </div>

      ${!s.level ? `<p class="small muted" style="margin-top:16px;">⚠️ Grade/Level karyawan ini belum cocok dengan data di Master Level — denda, lembur, BPJS, PPh21, dan uang dinas dihitung Rp 0. Lengkapi Master Level &amp; Data Karyawan terlebih dahulu.</p>` : ""}
      ${!e.status_karyawan ? `<p class="small muted" style="margin-top:8px;">⚠️ Status Karyawan (Bulanan/Harian) belum diatur di Data Karyawan, sehingga Gaji Pokok belum bisa dihitung.</p>` : ""}
      <p class="small muted" style="margin-top:16px;">Dicetak ${fmtDate(new Date())} — dihasilkan otomatis oleh sistem, tidak memerlukan tanda tangan basah.</p>
    </div>
  `;
}

// -----------------------------------------------------------------------
// PENYESUAIAN MANUAL (payroll_adjustments)
// -----------------------------------------------------------------------
function openAdjustModal(userId) {
  const emp = employees.find(e => e.id === userId);
  const adj = adjByUser[userId] || { hari_dinas: 0, tunjangan_lain: 0, keterangan_tunjangan: "", potongan_lain: 0, keterangan_potongan: "" };
  const form = document.getElementById("form-adjust");
  form.dataset.userId = userId;
  form.hari_dinas.value = adj.hari_dinas || 0;
  form.tunjangan_lain.value = adj.tunjangan_lain || 0;
  form.keterangan_tunjangan.value = adj.keterangan_tunjangan || "";
  form.potongan_lain.value = adj.potongan_lain || 0;
  form.keterangan_potongan.value = adj.keterangan_potongan || "";
  document.getElementById("adjust-emp-label").textContent = `${emp.full_name} — ${periodLabel(period)}`;
  document.getElementById("modal-adjust").classList.remove("hidden");
}

async function onSubmitAdjust(e, user) {
  e.preventDefault();
  const form = e.target;
  const userId = form.dataset.userId;
  const fd = new FormData(form);
  const payload = {
    user_id: userId,
    period,
    hari_dinas: Number(fd.get("hari_dinas")) || 0,
    tunjangan_lain: Number(fd.get("tunjangan_lain")) || 0,
    keterangan_tunjangan: fd.get("keterangan_tunjangan") || null,
    potongan_lain: Number(fd.get("potongan_lain")) || 0,
    keterangan_potongan: fd.get("keterangan_potongan") || null,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("payroll_adjustments").upsert(payload, { onConflict: "user_id,period" });
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  toast("Tunjangan/potongan tersimpan", "success");
  document.getElementById("modal-adjust").classList.add("hidden");

  const { data: adj } = await supabase.from("payroll_adjustments").select("*").eq("period", period);
  adjByUser = {};
  (adj || []).forEach(a => { adjByUser[a.user_id] = a; });

  const emp = employees.find(x => x.id === userId);
  currentSlip = computeSlip(emp);
  renderSlipContent(currentSlip);
  renderSummary();
  renderTable();
}

// -----------------------------------------------------------------------
function doExport() {
  const slips = employees.map(computeSlip);
  if (!slips.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const rows = slips.map(s => ({
    "Nama": s.emp.full_name,
    "Kode Karyawan": s.emp.employee_code || "-",
    "Grade": s.emp.grade || "-",
    "Level": s.emp.level || "-",
    "Status": s.emp.status_karyawan || "-",
    "Hari Hadir": s.hariHadir,
    "Hari Telat": s.hariTelat,
    "Jam Lembur Biasa": s.jamLemburBiasa,
    "Jam Lembur Libur": s.jamLemburLibur,
    "Gaji Pokok": s.gajiPokok,
    "Uang Lembur": s.uangLembur,
    "Uang Dinas": s.uangDinas,
    "Tunjangan Jabatan": s.tunjanganJabatan,
    "Tunjangan Loyalitas": s.tunjanganLoyalitas,
    "Tunjangan Lain": s.tunjanganLain,
    "Total Pendapatan": s.totalPendapatan,
    "Denda Keterlambatan": s.dendaKeterlambatan,
    "Denda Pulang Cepat": s.dendaPulangCepat,
    "BPJS Kesehatan": s.bpjsKesKaryawan,
    "BPJS Ketenagakerjaan": s.bpjsTkKaryawan,
    "PPh21": s.pph21,
    "Potongan Lain": s.potonganLain,
    "Total Potongan": s.totalPotongan,
    "Gaji Bersih": s.gajiBersih,
  }));
  exportXLSX(`slip-gaji-ringkasan-${period}.xlsx`, rows, "Slip Gaji");
}
