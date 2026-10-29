import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtDate, dateOnlyISO, exportXLSX, STAFF_ROLES, confirmDialog, escapeHtml } from "../core.js";
import { printSlip } from "./admin-slip-gaji.js";
import { computeThr, addMonthsISO } from "../thrRules.js";

// =======================================================================
// THR (TUNJANGAN HARI RAYA)
//
// Satu "Pembayaran THR" per tahun untuk SEMUA karyawan aktif (bukan per agama).
// Slip THR TERPISAH dari slip gaji bulanan. Tabel: thr_payments & thr_items
// (SQL 023_thr.sql).
//
// Aturan hitung (Permenaker 6/2016, bisa disesuaikan kebijakan perusahaan):
//   - Berhak: masa kerja >= 1 bulan terus-menerus pada TANGGAL ACUAN.
//   - Masa kerja >= 12 bulan  -> 1 bulan upah.
//     Masa kerja 1..11 bulan  -> masa kerja / 12 x 1 bulan upah (prorata).
//   - Upah sebulan = gaji pokok + tunjangan tetap (Master Tunjangan aktif),
//     tunjangan bisa dimatikan per pembayaran (include_tunjangan).
//       * Bulanan : gaji bulanan terbaru yang berlaku pada tanggal acuan.
//       * Harian  : rata-rata (gaji pokok + tunjangan) dari slip gaji FINAL,
//                   maksimal 12 bulan terakhir sebelum tanggal acuan.
//   - PPh21 = persentase khusus THR yang diisi per pembayaran.
//   - BPJS TIDAK dipotong dari THR.
// Status draft bisa dihitung ulang & diedit; final = dikunci & tampil ke karyawan.
// =======================================================================

const esc = escapeHtml;
const NUM = n => Math.round(Number(n) || 0);

// ---------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------
// Supabase membatasi 1000 baris per permintaan -> ambil bertahap.
async function fetchAllRows(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function loadBase(pay) {
  const ref = pay.reference_date;
  const [emps, salaries, typesRes, alw, periodsRes] = await Promise.all([
    fetchAllRows(() => supabase.from("profiles").select("*").eq("is_active", true).order("full_name")),
    fetchAllRows(() => supabase.from("salary_history").select("user_id, effective_date, monthly_salary").lte("effective_date", ref).order("effective_date", { ascending: false })),
    supabase.from("allowance_types").select("id, nama").eq("is_active", true),
    fetchAllRows(() => supabase.from("employee_allowances").select("user_id, allowance_type_id, nominal").eq("is_active", true)),
    supabase.from("payroll_periods").select("period, period_end"),
  ]);
  const salaryBy = {};
  salaries.forEach(r => { if (!salaryBy[r.user_id]) salaryBy[r.user_id] = r; }); // urut terbaru dulu
  const typeName = {};
  (typesRes.data || []).forEach(t => { typeName[t.id] = t.nama; });
  const allowBy = {};
  alw.forEach(a => { const nama = typeName[a.allowance_type_id]; if (nama) (allowBy[a.user_id] ??= []).push({ nama, nominal: a.nominal || 0 }); });

  // Slip final pekerja harian: periode yang berakhir dalam 12 bulan sebelum tanggal acuan.
  const slipsBy = {};
  const harianIds = emps.filter(e => e.status_karyawan === "harian").map(e => e.id);
  const windowStart = addMonthsISO(ref, -12);
  const periodKeys = (periodsRes.data || []).filter(p => p.period_end <= ref && p.period_end > windowStart).map(p => p.period);
  if (harianIds.length && periodKeys.length) {
    for (const ids of chunk(harianIds, 80)) {
      const rows = await fetchAllRows(() => supabase.from("payroll_slips").select("user_id, period, snapshot").in("period", periodKeys).in("user_id", ids).order("period", { ascending: false }));
      rows.forEach(r => (slipsBy[r.user_id] ??= []).push({ period: r.period, pokok: r.snapshot?.gajiPokok || 0, tunjangan: r.snapshot?.tunjanganTambahan || 0 }));
    }
    Object.keys(slipsBy).forEach(k => { slipsBy[k] = slipsBy[k].sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 12); });
  }
  return { emps, salaryBy, allowBy, slipsBy };
}

// Hitung ulang semua item draft. Item yang diubah manual dipertahankan
// (hanya PPh21-nya disesuaikan kalau persentasenya berubah).
async function recalc(pay) {
  const base = await loadBase(pay);
  const existing = await fetchAllRows(() => supabase.from("thr_items").select("id, user_id, snapshot").eq("thr_id", pay.id));
  const manual = new Map(existing.filter(i => i.snapshot?.manual).map(i => [i.user_id, i]));

  for (const ids of chunk(existing.filter(i => !i.snapshot?.manual).map(i => i.id), 100)) {
    const { error } = await supabase.from("thr_items").delete().in("id", ids);
    if (error) throw error;
  }

  const rows = [];
  for (const emp of base.emps) {
    if (manual.has(emp.id)) continue;
    const r = computeThr({ emp, pay, salary: base.salaryBy[emp.id], allowances: base.allowBy[emp.id] || [], slips: base.slipsBy[emp.id] || [] });
    rows.push({ thr_id: pay.id, user_id: emp.id, thr_bruto: r.thr_bruto, pph21: r.pph21, thr_neto: r.thr_neto, snapshot: r.snapshot });
  }
  for (const part of chunk(rows, 200)) {
    const { error } = await supabase.from("thr_items").insert(part);
    if (error) throw error;
  }
  for (const it of manual.values()) {
    const persen = Number(pay.pph21_persen) || 0;
    const bruto = NUM(it.snapshot.thr_bruto);
    const pph = NUM(bruto * persen / 100);
    const { error } = await supabase.from("thr_items").update({ pph21: pph, thr_neto: bruto - pph, snapshot: { ...it.snapshot, pph21_persen: persen, pph21: pph, thr_neto: bruto - pph } }).eq("id", it.id);
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------
// STATE & ENTRY
// ---------------------------------------------------------------------
let root = null;
let me = null;
let isSuper = false;
let current = null;   // pembayaran yang sedang dibuka (detail)
let items = [];       // item milik pembayaran itu
let editingPay = null; // pembayaran yang sedang diubah pengaturannya (null = buat baru)

export async function render(container, user, opts = {}) {
  root = container;
  me = user;
  isSuper = user.role === "super_admin";
  current = null;
  const selfOnly = !!opts.forceSelfOnly || !STAFF_ROLES.includes(user.role);
  return selfOnly ? renderSelf() : renderList();
}

const slipModalHtml = `
  <div id="modal-slip" class="modal hidden">
    <div class="modal-box modal-box-lg">
      <div class="modal-actions no-print" style="justify-content:flex-end; margin-bottom:14px; gap:10px;">
        <button type="button" id="btn-print-slip" class="btn-secondary">🖨️ Cetak / Simpan PDF</button>
        <button type="button" id="btn-close-slip" class="btn-primary">Tutup</button>
      </div>
      <div id="slip-content" class="slip-print-area"></div>
    </div>
  </div>`;

function bindSlipModal() {
  document.getElementById("btn-close-slip").addEventListener("click", () => document.getElementById("modal-slip").classList.add("hidden"));
  document.getElementById("btn-print-slip").addEventListener("click", printSlip);
}

// ---------------------------------------------------------------------
// SLIP THR
// ---------------------------------------------------------------------
function renderSlipContent(item, pay) {
  const s = item.snapshot || {};
  const e = s.emp || {};
  const harian = s.basis === "harian";
  document.getElementById("slip-content").innerHTML = `
    <div class="slip-box">
      <div class="slip-header">
        <div>
          <h2>${esc(e.unit_pt || "Slip THR")}</h2>
          <p class="muted small" style="margin-top:2px;">Slip Tunjangan Hari Raya (THR)</p>
        </div>
        <div class="slip-period">
          <div class="muted small">${esc(pay.name)}</div>
          <div style="font-weight:600;">Dibayar ${pay.pay_date ? fmtDate(pay.pay_date) : "-"}</div>
        </div>
      </div>

      <div class="slip-emp-grid">
        <div><span class="label">Nama</span>${esc(e.full_name || "-")}</div>
        <div><span class="label">Kode Karyawan</span>${esc(e.employee_code || "-")}</div>
        <div><span class="label">Jabatan</span>${esc(e.position || "-")}</div>
        <div><span class="label">Departemen</span>${esc(e.department || "-")}${e.bagian ? ` / ${esc(e.bagian)}` : ""}</div>
        <div><span class="label">Status Karyawan</span>${e.status_karyawan === "bulanan" ? "Bulanan" : e.status_karyawan === "harian" ? "Harian" : "-"}</div>
        <div><span class="label">Tanggal Masuk</span>${e.join_date ? fmtDate(e.join_date) : "-"}</div>
        <div><span class="label">Tanggal Acuan</span>${fmtDate(pay.reference_date)}</div>
        <div><span class="label">Masa Kerja</span>${s.masa_kerja_bulan ?? 0} bulan${s.masa_kerja_sisa_hari ? ` ${s.masa_kerja_sisa_hari} hari` : ""}</div>
      </div>

      <div class="slip-cols">
        <div class="slip-col">
          <h4>Dasar Perhitungan</h4>
          <div class="slip-line"><span>${harian ? `Rata-rata Gaji Pokok (${s.slip_count || 0} slip)` : "Gaji Pokok"}</span><span>${fmtRupiah(s.gaji_pokok)}</span></div>
          ${(s.tunjangan || []).map(t => `<div class="slip-line"><span>${esc(t.nama)}</span><span>${fmtRupiah(t.nominal)}</span></div>`).join("")}
          <div class="slip-line total"><span>Upah Sebulan</span><span>${fmtRupiah(s.upah_sebulan)}</span></div>
          <div class="slip-line"><span>Perhitungan</span><span style="text-align:right; max-width:60%;">${esc(s.rumus || "-")}</span></div>
        </div>
        <div class="slip-col">
          <h4>THR</h4>
          <div class="slip-line"><span>THR (bruto)</span><span>${fmtRupiah(item.thr_bruto)}</span></div>
          <div class="slip-line"><span>PPh21 (${Number(s.pph21_persen ?? pay.pph21_persen) || 0}%)</span><span>${fmtRupiah(item.pph21)}</span></div>
          <div class="slip-line total"><span>Total Potongan</span><span>${fmtRupiah(item.pph21)}</span></div>
        </div>
      </div>

      <div class="slip-net">
        <span class="label">THR Diterima (Neto)</span>
        <span class="value">${fmtRupiah(item.thr_neto)}</span>
      </div>
      ${s.catatan ? `<p class="small muted" style="margin-top:12px;">Catatan: ${esc(s.catatan)}</p>` : ""}
      <p class="small muted" style="margin-top:16px;">Dicetak ${fmtDate(new Date())} — dihasilkan otomatis oleh sistem, tidak memerlukan tanda tangan basah. Potongan BPJS tidak dikenakan pada THR.</p>
    </div>`;
}

function openSlip(item, pay) {
  renderSlipContent(item, pay);
  document.getElementById("modal-slip").classList.remove("hidden");
}

// ---------------------------------------------------------------------
// TAMPILAN KARYAWAN (menu "Slip THR Saya")
// ---------------------------------------------------------------------
async function renderSelf() {
  root.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>Slip THR Saya</h1>
        <p class="pg-head-sub">Slip Tunjangan Hari Raya yang sudah diterbitkan HR untukmu. Kalau ada yang dirasa keliru, hubungi HR/Admin.</p>
      </div>
    </div>
    <div id="thr-body" class="table-wrap"><p class="muted" style="padding:16px;">Memuat…</p></div>
    ${slipModalHtml}`;
  bindSlipModal();

  const { data, error } = await supabase.from("thr_items")
    .select("*, thr:thr_payments(id, name, reference_date, pay_date, pph21_persen, status)")
    .eq("user_id", me.id);
  const body = document.getElementById("thr-body");
  if (error) { body.innerHTML = `<p class="muted" style="padding:16px;">Gagal memuat slip THR: ${esc(error.message)}</p>`; return; }
  const mine = (data || [])
    .filter(i => i.thr?.status === "final" && Number(i.thr_bruto) > 0)
    .sort((a, b) => (a.thr.reference_date < b.thr.reference_date ? 1 : -1));
  if (!mine.length) { body.innerHTML = `<p class="muted" style="padding:16px;">Belum ada slip THR yang diterbitkan.</p>`; return; }
  body.innerHTML = `
    <table class="table">
      <thead><tr><th>THR</th><th>Tanggal Bayar</th><th style="text-align:right">THR Bruto</th><th style="text-align:right">PPh21</th><th style="text-align:right">THR Diterima</th><th></th></tr></thead>
      <tbody>${mine.map((i, idx) => `<tr>
        <td>${esc(i.thr.name)}</td><td>${i.thr.pay_date ? fmtDate(i.thr.pay_date) : "-"}</td>
        <td style="text-align:right">${fmtRupiah(i.thr_bruto)}</td><td style="text-align:right">${fmtRupiah(i.pph21)}</td>
        <td style="text-align:right"><b>${fmtRupiah(i.thr_neto)}</b></td>
        <td><button type="button" class="btn-secondary btn-lihat" data-i="${idx}">Lihat &amp; Cetak</button></td></tr>`).join("")}</tbody>
    </table>`;
  body.querySelectorAll(".btn-lihat").forEach(b => b.addEventListener("click", () => {
    const i = mine[Number(b.dataset.i)];
    openSlip(i, i.thr);
  }));
}

// ---------------------------------------------------------------------
// TAMPILAN PENGELOLA: DAFTAR PEMBAYARAN THR
// ---------------------------------------------------------------------
const payFormHtml = `
  <div id="modal-pay" class="modal hidden">
    <div class="modal-box">
      <h3 id="pay-title">Buat THR Baru</h3>
      <form id="form-pay">
        <div class="form-row">
          <label>Nama THR <input name="name" required maxlength="100" placeholder="Contoh: THR 2027"></label>
        </div>
        <div class="form-row two-col">
          <label>Tanggal Acuan Masa Kerja <input type="date" name="reference_date" required></label>
          <label>Tanggal Dibayarkan <input type="date" name="pay_date"></label>
        </div>
        <p class="small muted" style="margin:-4px 0 10px;">Masa kerja dihitung sampai tanggal acuan (biasanya tanggal hari raya). Berhak: masa kerja minimal 1 bulan.</p>
        <div class="form-row two-col">
          <label>PPh21 THR (%) <input type="number" name="pph21_persen" min="0" max="100" step="0.01" value="0"></label>
          <label>Pembulatan Masa Kerja
            <select name="pembulatan">
              <option value="bawah">Bulan penuh saja</option>
              <option value="atas15">Sisa 15 hari atau lebih dibulatkan ke atas</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" name="include_tunjangan" checked style="width:auto;"> Sertakan tunjangan tetap (Master Tunjangan) dalam dasar upah</label>
        </div>
        <div class="form-row">
          <label>Catatan <input name="notes" maxlength="300" placeholder="Opsional"></label>
        </div>
        <div class="modal-actions">
          <button type="button" id="btn-cancel-pay" class="btn-secondary">Batal</button>
          <button type="submit" class="btn-primary" id="btn-save-pay">Simpan &amp; Hitung</button>
        </div>
      </form>
    </div>
  </div>`;

function bindPayModal() {
  const f = document.getElementById("form-pay");
  // Nama bawaan ("THR 2027") ikut tahun tanggal acuan selama belum diubah manual.
  f.reference_date.addEventListener("change", () => {
    if (/^THR \d{4}$/.test(f.name.value.trim()) && f.reference_date.value) f.name.value = `THR ${f.reference_date.value.slice(0, 4)}`;
  });
  document.getElementById("btn-cancel-pay").addEventListener("click", () => document.getElementById("modal-pay").classList.add("hidden"));
  document.getElementById("form-pay").addEventListener("submit", onSubmitPay);
}

function openPayModal(pay = null) {
  editingPay = pay;
  const f = document.getElementById("form-pay");
  document.getElementById("pay-title").textContent = pay ? "Ubah Pengaturan THR" : "Buat THR Baru";
  const ref = pay?.reference_date || dateOnlyISO(new Date());
  f.name.value = pay?.name || `THR ${ref.slice(0, 4)}`;
  f.reference_date.value = ref;
  f.pay_date.value = pay?.pay_date || "";
  f.pph21_persen.value = pay?.pph21_persen ?? 0;
  f.pembulatan.value = pay?.pembulatan || "bawah";
  f.include_tunjangan.checked = pay ? pay.include_tunjangan !== false : true;
  f.notes.value = pay?.notes || "";
  document.getElementById("modal-pay").classList.remove("hidden");
}

async function onSubmitPay(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById("btn-save-pay");
  const row = {
    name: f.name.value.trim(),
    reference_date: f.reference_date.value,
    pay_date: f.pay_date.value || null,
    pph21_persen: Number(f.pph21_persen.value) || 0,
    pembulatan: f.pembulatan.value,
    include_tunjangan: f.include_tunjangan.checked,
    notes: f.notes.value.trim() || null,
  };
  if (!row.name || !row.reference_date) { toast("Nama dan tanggal acuan wajib diisi.", "error"); return; }
  btn.disabled = true; btn.textContent = "Menghitung…";
  try {
    let pay;
    if (editingPay) {
      const { data, error } = await supabase.from("thr_payments").update(row).eq("id", editingPay.id).select().single();
      if (error) throw error;
      pay = data;
    } else {
      const { data, error } = await supabase.from("thr_payments").insert(row).select().single();
      if (error) throw error;
      pay = data;
    }
    await recalc(pay);
    document.getElementById("modal-pay").classList.add("hidden");
    toast(editingPay ? "Pengaturan THR disimpan & dihitung ulang." : "THR dibuat & dihitung.", "success");
    await openDetail(pay.id);
  } catch (err) {
    toast("Gagal menyimpan THR: " + (err.message || err), "error");
  } finally {
    btn.disabled = false; btn.textContent = "Simpan & Hitung";
  }
}

async function renderList() {
  current = null;
  root.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>THR (Tunjangan Hari Raya)</h1>
        <p class="pg-head-sub">Satu pembayaran THR per tahun untuk semua karyawan aktif. Dihitung otomatis dari masa kerja dan upah (gaji pokok + tunjangan tetap), bisa dicek dan diubah sebelum dikunci. Slip THR terpisah dari slip gaji bulanan.</p>
      </div>
      <div class="filter-row pg-head-actions"><button id="btn-new" class="btn-primary">+ Buat THR Baru</button></div>
    </div>
    <div id="thr-body" class="table-wrap"><p class="muted" style="padding:16px;">Memuat…</p></div>
    ${payFormHtml}${slipModalHtml}`;
  bindPayModal();
  bindSlipModal();
  document.getElementById("btn-new").addEventListener("click", () => openPayModal());

  const body = document.getElementById("thr-body");
  let pays, its;
  try {
    pays = await fetchAllRows(() => supabase.from("thr_payments").select("*").order("reference_date", { ascending: false }));
    its = await fetchAllRows(() => supabase.from("thr_items").select("id, thr_id, thr_bruto, pph21, thr_neto").order("id"));
  } catch (err) {
    body.innerHTML = `<p class="muted" style="padding:16px;">Gagal memuat THR: ${esc(err.message || err)}. Pastikan SQL <b>023_thr.sql</b> sudah dijalankan.</p>`;
    return;
  }
  const agg = {};
  its.forEach(i => { const a = (agg[i.thr_id] ??= { n: 0, bruto: 0, neto: 0 }); if (Number(i.thr_bruto) > 0) { a.n++; a.bruto += Number(i.thr_bruto); a.neto += Number(i.thr_neto); } });
  if (!pays.length) { body.innerHTML = `<p class="muted" style="padding:16px;">Belum ada pembayaran THR. Klik "Buat THR Baru" untuk memulai.</p>`; return; }
  body.innerHTML = `
    <table class="table">
      <thead><tr><th>THR</th><th>Tanggal Acuan</th><th>Tanggal Bayar</th><th style="text-align:right">Penerima</th><th style="text-align:right">Total Bruto</th><th style="text-align:right">Total Diterima</th><th>Status</th><th></th></tr></thead>
      <tbody>${pays.map(p => { const a = agg[p.id] || { n: 0, bruto: 0, neto: 0 }; return `<tr>
        <td><b>${esc(p.name)}</b></td><td>${fmtDate(p.reference_date)}</td><td>${p.pay_date ? fmtDate(p.pay_date) : "-"}</td>
        <td style="text-align:right">${a.n}</td><td style="text-align:right">${fmtRupiah(a.bruto)}</td><td style="text-align:right">${fmtRupiah(a.neto)}</td>
        <td><span class="badge ${p.status === "final" ? "badge-ok" : "badge-warn"}">${p.status === "final" ? "Final" : "Draft"}</span></td>
        <td><button type="button" class="btn-secondary btn-buka" data-id="${p.id}">Buka</button></td></tr>`; }).join("")}</tbody>
    </table>`;
  body.querySelectorAll(".btn-buka").forEach(b => b.addEventListener("click", () => openDetail(b.dataset.id)));
}

// ---------------------------------------------------------------------
// TAMPILAN PENGELOLA: RINCIAN SATU PEMBAYARAN
// ---------------------------------------------------------------------
const itemFormHtml = `
  <div id="modal-item" class="modal hidden">
    <div class="modal-box">
      <h3>Ubah THR Karyawan</h3>
      <p class="muted small" id="item-emp-label" style="margin-top:-4px;"></p>
      <form id="form-item">
        <div class="form-row">
          <label>THR Bruto (Rp) <input type="number" name="thr_bruto" min="0" step="1" required></label>
        </div>
        <div class="form-row">
          <label>Catatan (tampil di slip) <input name="catatan" maxlength="200" placeholder="Contoh: disesuaikan sesuai kebijakan"></label>
        </div>
        <p class="small muted" style="margin:-4px 0 10px;">PPh21 dihitung otomatis dari persentase THR ini. Angka yang diubah manual tidak ikut berubah saat "Hitung Ulang".</p>
        <div class="modal-actions" style="justify-content:space-between;">
          <button type="button" id="btn-item-auto" class="btn-secondary">Kembalikan ke hitungan otomatis</button>
          <span style="display:flex; gap:10px;">
            <button type="button" id="btn-cancel-item" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </span>
        </div>
      </form>
    </div>
  </div>`;

async function openDetail(id) {
  const { data: pay, error } = await supabase.from("thr_payments").select("*").eq("id", id).single();
  if (error) { toast("Gagal membuka THR: " + error.message, "error"); return; }
  current = pay;
  await renderDetail();
}

async function renderDetail() {
  const pay = current;
  const draft = pay.status === "draft";
  root.innerHTML = `
    <div class="pg-head">
      <div>
        <button type="button" id="btn-back" class="btn-link" style="margin-bottom:6px;">← Semua THR</button>
        <h1>${esc(pay.name)} <span class="badge ${draft ? "badge-warn" : "badge-ok"}" style="vertical-align:middle;">${draft ? "Draft" : "Final"}</span></h1>
        <p class="pg-head-sub">Tanggal acuan ${fmtDate(pay.reference_date)} • dibayar ${pay.pay_date ? fmtDate(pay.pay_date) : "-"} • PPh21 THR ${Number(pay.pph21_persen) || 0}% • ${pay.include_tunjangan ? "gaji pokok + tunjangan tetap" : "gaji pokok saja"} • pembulatan ${pay.pembulatan === "atas15" ? "sisa ≥ 15 hari naik" : "bulan penuh"}${pay.notes ? ` • ${esc(pay.notes)}` : ""}</p>
      </div>
      <div class="filter-row pg-head-actions" style="flex-wrap:wrap; gap:8px;">
        ${draft ? `<button id="btn-edit-pay" class="btn-secondary">Ubah Pengaturan</button><button id="btn-recalc" class="btn-secondary">Hitung Ulang</button>` : ""}
        <button id="btn-export" class="btn-secondary">Ekspor Excel</button>
        ${draft ? `<button id="btn-finalize" class="btn-primary">Kunci &amp; Terbitkan</button><button id="btn-delete" class="btn-secondary" style="color:var(--danger);">Hapus</button>` : ""}
        ${!draft && isSuper ? `<button id="btn-unlock" class="btn-secondary">Buka Kunci</button>` : ""}
      </div>
    </div>
    <div id="thr-sum" class="status-grid" style="margin-bottom:16px;"></div>
    <div class="filter-row" style="margin-bottom:10px;"><input type="text" id="thr-search" placeholder="Cari nama karyawan…" style="max-width:280px;"></div>
    <div id="thr-body" class="table-wrap"><p class="muted" style="padding:16px;">Memuat…</p></div>
    ${payFormHtml}${itemFormHtml}${slipModalHtml}`;
  bindPayModal();
  bindSlipModal();
  document.getElementById("btn-back").addEventListener("click", renderList);
  document.getElementById("btn-export").addEventListener("click", doExport);
  document.getElementById("btn-edit-pay")?.addEventListener("click", () => openPayModal(pay));
  document.getElementById("btn-recalc")?.addEventListener("click", onRecalc);
  document.getElementById("btn-finalize")?.addEventListener("click", onFinalize);
  document.getElementById("btn-delete")?.addEventListener("click", onDelete);
  document.getElementById("btn-unlock")?.addEventListener("click", onUnlock);
  document.getElementById("btn-cancel-item").addEventListener("click", () => document.getElementById("modal-item").classList.add("hidden"));
  document.getElementById("form-item").addEventListener("submit", onSubmitItem);
  document.getElementById("btn-item-auto").addEventListener("click", onItemAuto);
  document.getElementById("thr-search").addEventListener("input", renderItems);

  try {
    items = await fetchAllRows(() => supabase.from("thr_items").select("*").eq("thr_id", pay.id).order("id"));
  } catch (err) {
    document.getElementById("thr-body").innerHTML = `<p class="muted" style="padding:16px;">Gagal memuat data: ${esc(err.message || err)}</p>`;
    return;
  }
  items.sort((a, b) => (a.snapshot?.emp?.full_name || "").localeCompare(b.snapshot?.emp?.full_name || ""));
  renderSummary();
  renderItems();
}

function renderSummary() {
  const rec = items.filter(i => Number(i.thr_bruto) > 0);
  const sum = k => rec.reduce((s, i) => s + Number(i[k] || 0), 0);
  const cek = items.filter(i => (i.snapshot?.warnings || []).length).length;
  const skip = items.filter(i => i.snapshot?.eligible === false).length;
  const card = (label, value, sub = "") => `<div class="status-card"><span class="status-label">${label}</span><span class="status-value">${value}</span>${sub ? `<span class="muted small">${sub}</span>` : ""}</div>`;
  document.getElementById("thr-sum").innerHTML =
    card("Penerima THR", rec.length, `${skip} karyawan belum berhak / perlu dilengkapi`) +
    card("Total THR Bruto", fmtRupiah(sum("thr_bruto"))) +
    card("Total PPh21", fmtRupiah(sum("pph21"))) +
    card("Total Diterima", fmtRupiah(sum("thr_neto"))) +
    card("Perlu Dicek", cek, cek ? "ada peringatan di kolom Catatan" : "semua terhitung wajar");
}

function renderItems() {
  const q = (document.getElementById("thr-search")?.value || "").trim().toLowerCase();
  const draft = current.status === "draft";
  const rows = items.filter(i => !q || (i.snapshot?.emp?.full_name || "").toLowerCase().includes(q));
  const body = document.getElementById("thr-body");
  if (!rows.length) { body.innerHTML = `<p class="muted" style="padding:16px;">${items.length ? "Tidak ada karyawan yang cocok." : "Belum ada karyawan aktif."}</p>`; return; }
  body.innerHTML = `
    <table class="table" style="min-width:880px;">
      <thead><tr><th>Karyawan</th><th>Status</th><th>Tgl Masuk</th><th style="text-align:right">Masa Kerja</th><th style="text-align:right">Upah Sebulan</th><th style="text-align:right">THR Bruto</th><th style="text-align:right">PPh21</th><th style="text-align:right">THR Diterima</th><th>Catatan</th><th></th></tr></thead>
      <tbody>${rows.map(i => {
        const s = i.snapshot || {}, e = s.emp || {};
        const ok = s.eligible !== false;
        const notes = [s.eligible === false ? s.alasan : "", ...(s.warnings || []), s.manual ? "Diubah manual" : ""].filter(Boolean);
        return `<tr style="${ok ? "" : "opacity:.65;"}">
          <td>${esc(e.full_name || "-")}<div class="muted small">${esc(e.employee_code || "")}${e.department ? " • " + esc(e.department) : ""}</div></td>
          <td>${e.status_karyawan === "bulanan" ? "Bulanan" : e.status_karyawan === "harian" ? "Harian" : "-"}</td>
          <td>${e.join_date ? fmtDate(e.join_date) : "-"}</td>
          <td style="text-align:right">${s.masa_kerja_bulan ?? 0} bln</td>
          <td style="text-align:right">${ok ? fmtRupiah(s.upah_sebulan) : "-"}</td>
          <td style="text-align:right">${fmtRupiah(i.thr_bruto)}</td>
          <td style="text-align:right">${fmtRupiah(i.pph21)}</td>
          <td style="text-align:right"><b>${fmtRupiah(i.thr_neto)}</b></td>
          <td class="small ${ok && !(s.warnings || []).length ? "muted" : ""}" style="min-width:180px; white-space:normal;">${notes.length ? notes.map(n => `<div>${(s.warnings || []).includes(n) || !ok ? "⚠️ " : ""}${esc(n)}</div>`).join("") : "-"}</td>
          <td style="white-space:nowrap;">
            ${Number(i.thr_bruto) > 0 ? `<button type="button" class="btn-link btn-slip" data-id="${i.id}">Slip</button>` : ""}
            ${draft ? `<button type="button" class="btn-link btn-edit" data-id="${i.id}">Ubah</button>` : ""}
          </td></tr>`;
      }).join("")}</tbody>
    </table>`;
  body.querySelectorAll(".btn-slip").forEach(b => b.addEventListener("click", () => openSlip(items.find(x => x.id === b.dataset.id), current)));
  body.querySelectorAll(".btn-edit").forEach(b => b.addEventListener("click", () => openItemModal(b.dataset.id)));
}

// ---------------------------------------------------------------------
// AKSI
// ---------------------------------------------------------------------
async function onRecalc() {
  const ok = await confirmDialog({ title: "Hitung Ulang THR", message: "Seluruh angka otomatis akan dihitung ulang dari data terbaru (gaji, tunjangan, tanggal masuk). Angka yang kamu ubah manual tetap dipertahankan.", confirmLabel: "Hitung Ulang" });
  if (!ok) return;
  try { await recalc(current); toast("THR dihitung ulang.", "success"); await renderDetail(); }
  catch (err) { toast("Gagal menghitung ulang: " + (err.message || err), "error"); }
}

async function onFinalize() {
  const rec = items.filter(i => Number(i.thr_bruto) > 0);
  const cek = items.filter(i => (i.snapshot?.warnings || []).length).length;
  const total = rec.reduce((s, i) => s + Number(i.thr_neto), 0);
  const ok = await confirmDialog({
    title: "Kunci & Terbitkan THR",
    message: `${rec.length} karyawan akan menerima slip THR dengan total diterima ${fmtRupiah(total)}.${cek ? ` Masih ada ${cek} karyawan dengan peringatan — pastikan sudah dicek.` : ""} Setelah dikunci, slip langsung tampil ke karyawan dan angkanya tidak bisa diubah (hanya Super Admin yang bisa membuka kunci).`,
    confirmLabel: "Kunci & Terbitkan",
  });
  if (!ok) return;
  const { data, error } = await supabase.from("thr_payments").update({ status: "final", finalized_by: me.id, finalized_at: new Date().toISOString() }).eq("id", current.id).select().single();
  if (error) { toast("Gagal mengunci THR: " + error.message, "error"); return; }
  current = data;
  toast("THR dikunci & diterbitkan.", "success");
  await renderDetail();
}

async function onUnlock() {
  const ok = await confirmDialog({ title: "Buka Kunci THR", message: "THR akan kembali ke Draft dan slipnya TIDAK lagi tampil ke karyawan sampai dikunci ulang. Lanjutkan?", confirmLabel: "Buka Kunci", confirmClass: "btn-danger" });
  if (!ok) return;
  const { data, error } = await supabase.from("thr_payments").update({ status: "draft", finalized_by: null, finalized_at: null }).eq("id", current.id).select().single();
  if (error) { toast("Gagal membuka kunci: " + error.message, "error"); return; }
  current = data;
  toast("Kunci THR dibuka.", "success");
  await renderDetail();
}

async function onDelete() {
  const ok = await confirmDialog({ title: "Hapus THR", message: `Hapus "${current.name}" beserta seluruh hitungannya? Tindakan ini tidak bisa dibatalkan.`, confirmLabel: "Hapus", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.from("thr_payments").delete().eq("id", current.id);
  if (error) { toast("Gagal menghapus: " + error.message, "error"); return; }
  toast("THR dihapus.", "success");
  await renderList();
}

let editingItem = null;
function openItemModal(id) {
  editingItem = items.find(i => i.id === id);
  if (!editingItem) return;
  const s = editingItem.snapshot || {};
  const f = document.getElementById("form-item");
  document.getElementById("item-emp-label").textContent = `${s.emp?.full_name || "-"} — ${current.name}`;
  f.thr_bruto.value = NUM(editingItem.thr_bruto);
  f.catatan.value = s.catatan || "";
  document.getElementById("btn-item-auto").style.display = s.manual ? "" : "none";
  document.getElementById("modal-item").classList.remove("hidden");
}

async function onSubmitItem(e) {
  e.preventDefault();
  const f = e.target;
  const bruto = NUM(f.thr_bruto.value);
  const persen = Number(current.pph21_persen) || 0;
  const pph = NUM(bruto * persen / 100);
  const s = editingItem.snapshot || {};
  const snapshot = { ...s, manual: true, catatan: f.catatan.value.trim(), thr_bruto: bruto, pph21_persen: persen, pph21: pph, thr_neto: bruto - pph, rumus: "Diatur manual oleh admin", eligible: bruto > 0 ? true : s.eligible };
  const { error } = await supabase.from("thr_items").update({ thr_bruto: bruto, pph21: pph, thr_neto: bruto - pph, snapshot }).eq("id", editingItem.id);
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }
  document.getElementById("modal-item").classList.add("hidden");
  toast("THR karyawan disimpan.", "success");
  await renderDetail();
}

async function onItemAuto() {
  const { error } = await supabase.from("thr_items").update({ snapshot: { ...(editingItem.snapshot || {}), manual: false } }).eq("id", editingItem.id);
  if (error) { toast("Gagal: " + error.message, "error"); return; }
  document.getElementById("modal-item").classList.add("hidden");
  try { await recalc(current); toast("Dikembalikan ke hitungan otomatis.", "success"); await renderDetail(); }
  catch (err) { toast("Gagal menghitung ulang: " + (err.message || err), "error"); }
}

function doExport() {
  const rows = items.map(i => {
    const s = i.snapshot || {}, e = s.emp || {};
    return {
      "Nama": e.full_name || "", "Kode": e.employee_code || "", "Departemen": e.department || "",
      "Status": e.status_karyawan || "", "Tanggal Masuk": e.join_date || "", "Masa Kerja (bulan)": s.masa_kerja_bulan ?? 0,
      "Gaji Pokok": NUM(s.gaji_pokok), "Tunjangan Tetap": NUM(s.tunjangan_total), "Upah Sebulan": NUM(s.upah_sebulan),
      "Faktor": Math.round((s.faktor || 0) * 10000) / 10000, "THR Bruto": NUM(i.thr_bruto),
      "PPh21 (%)": Number(s.pph21_persen) || 0, "PPh21": NUM(i.pph21), "THR Diterima": NUM(i.thr_neto),
      "Catatan": [s.eligible === false ? s.alasan : "", ...(s.warnings || []), s.manual ? "Diubah manual" : "", s.catatan || ""].filter(Boolean).join("; "),
    };
  });
  const slug = String(current.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "thr";
  exportXLSX(`${slug}.xlsx`, rows, "THR");
}
