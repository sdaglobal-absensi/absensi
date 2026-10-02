import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtDate, dateOnlyISO, exportXLSX } from "../core.js";

// =======================================================================
// INVOICE OUTSOURCING — tagihan PT vendor outsourcing, dipisah PER AREA
// (profiles.lokasi_kerja) di dalam tiap vendor.
//
// Angka dasar (Total Gaji Karyawan) diambil dari `payroll_slips.snapshot`
// = snapshot Slip Gaji yang sudah DIFINALISASI, bukan hitung ulang live.
// Rentang tanggal periode juga diambil dari `payroll_periods` (dibekukan
// saat finalisasi), jadi otomatis mengikuti cut-off (mis. 21 Nov - 20 Des).
//
// Rumus invoice per area (persentase diatur per vendor di Master PT):
//   Management Fee = Total Gaji x fee%
//   PPN            = Management Fee x ppn%
//   Total          = Total Gaji + Management Fee + PPN
//   PPh 23         = Management Fee x pph23%
//   Total Tagihan  = Total - PPh 23
// Persentase 0 = baris itu tidak ditampilkan di invoice.
//
// Nominal yang benar-benar tertulis di invoice vendor + No. Invoice +
// tanggal disimpan di `outsourcing_area_invoices` (lihat
// supabase-invoice-area.sql); selisih vs hitungan aplikasi ditampilkan.
// =======================================================================

// Penerima invoice (sementara tetap). Ubah di sini kalau berubah.
const KEPADA = { nama: "PT. SDA GLOBAL", alamat: "JL. MARGOMULYO INDAH BLOK 1A NO.7-8 GREGES, ASEM ROWO, KOTA SURABAYA" };

let period = "";
let employees = [];   // jenis_hubungan_kerja = 'outsourcing' & aktif
let periodInfo = null; // baris payroll_periods, null = belum final
let slipByUser = {};  // { [userId]: totalPendapatan }
let vendorCfg = {};   // { [nama vendor]: baris master_pt }
let savedByKey = {};  // { "vendor||area": outsourcing_area_invoices row }
let areas = [];       // [{ key, vendor, area, emps }]

export async function render(container) {
  period = dateOnlyISO(new Date()).slice(0, 7);

  container.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>Invoice Outsourcing</h1>
        <p class="pg-head-sub">
          Invoice tagihan PT vendor outsourcing, dipisah per area. Total gaji diambil dari Slip Gaji yang
          sudah difinalisasi; management fee, PPN, dan PPh 23 mengikuti pengaturan tiap vendor di Master PT / Vendor.
        </p>
      </div>
      <div class="filter-row pg-head-actions">
        <input type="month" id="filter-period" value="${period}">
        <button id="btn-export" class="btn-secondary no-print">Export Excel</button>
      </div>
    </div>
    <div id="invoice-status"></div>
    <div id="invoice-content"><p class="muted">Memuat…</p></div>
    <div id="modal-invoice" class="modal hidden">
      <div class="modal-box invoice-modal-box">
        <div id="invoice-preview"></div>
        <div class="modal-actions no-print">
          <button type="button" id="btn-close-invoice" class="btn-secondary">Tutup</button>
          <button type="button" id="btn-print-invoice" class="btn-primary">Cetak / Simpan PDF</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("filter-period").addEventListener("change", e => { period = e.target.value; load(); });
  document.getElementById("btn-export").addEventListener("click", doExport);
  document.getElementById("btn-close-invoice").addEventListener("click", closePreview);
  document.getElementById("btn-print-invoice").addEventListener("click", printInvoice);

  await load();
}

async function load() {
  const content = document.getElementById("invoice-content");
  content.innerHTML = `<p class="muted">Memuat…</p>`;

  const [{ data: emps, error: empErr }, { data: pInfo }, { data: pts }] = await Promise.all([
    supabase.from("profiles")
      .select("id, full_name, employee_code, position, department, bagian, unit_pt, lokasi_kerja")
      .eq("jenis_hubungan_kerja", "outsourcing")
      .eq("is_active", true)
      .order("full_name"),
    supabase.from("payroll_periods").select("*").eq("period", period).maybeSingle(),
    supabase.from("master_pt").select("*"),
  ]);

  if (empErr) { content.innerHTML = `<p class="muted">Gagal memuat data: ${empErr.message}</p>`; return; }
  employees = emps || [];
  periodInfo = pInfo || null;
  vendorCfg = {};
  (pts || []).forEach(p => { vendorCfg[p.nama] = p; });

  renderStatus();

  if (!employees.length) {
    content.innerHTML = `<p class="muted">Belum ada karyawan dengan Jenis Hubungan Kerja "Outsourcing". Atur lewat menu Data Karyawan.</p>`;
    return;
  }

  if (!periodInfo) {
    slipByUser = {};
    content.innerHTML = `
      <div class="pg-banner pg-banner-warn">
        <span class="pg-banner-icon">🔒</span>
        <div class="pg-banner-text">
          <strong>Periode ${periodLabelSimple(period)} belum difinalisasi</strong>
          <span>Belum ada angka resmi untuk dibuatkan invoice. Buka menu <strong>Slip Gaji</strong>, pilih periode ini, lalu klik <strong>Finalisasi Periode Ini</strong> terlebih dahulu.</span>
        </div>
      </div>`;
    return;
  }

  const userIds = employees.map(e => e.id);
  const [{ data: slips }, { data: saved }] = await Promise.all([
    supabase.from("payroll_slips").select("user_id, snapshot").eq("period", period).in("user_id", userIds),
    supabase.from("outsourcing_area_invoices").select("*").eq("period", period),
  ]);

  slipByUser = {};
  (slips || []).forEach(s => { slipByUser[s.user_id] = s.snapshot?.totalPendapatan ?? 0; });
  savedByKey = {};
  (saved || []).forEach(r => { savedByKey[keyOf(r.vendor, r.area)] = r; });

  buildAreas();
  renderContent();
}

function keyOf(vendor, area) { return `${vendor}||${area}`; }

function buildAreas() {
  const map = {};
  for (const e of employees) {
    const vendor = e.unit_pt || "(Unit/PT belum diisi)";
    const area = e.lokasi_kerja || "";
    const key = keyOf(vendor, area);
    (map[key] ??= { key, vendor, area, emps: [] }).emps.push(e);
  }
  areas = Object.values(map).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.area.localeCompare(b.area));
}

function renderStatus() {
  const el = document.getElementById("invoice-status");
  if (!employees.length || !periodInfo) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="pg-banner pg-banner-ok">
      <span class="pg-banner-icon">🔒</span>
      <div class="pg-banner-text">
        <strong>Periode ${periodLabelSimple(period)} sudah final</strong>
        <span>Periode invoice: ${fmtRange(periodInfo.period_start, periodInfo.period_end)}. Difinalisasi di Slip Gaji pada ${fmtDate(periodInfo.finalized_at)}; angka acuan dibekukan.</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// HITUNG INVOICE untuk satu area
// ---------------------------------------------------------------------
function calc(a) {
  const cfg = vendorCfg[a.vendor] || {};
  const feeP = Number(cfg.fee_persen) || 0;
  const ppnP = Number(cfg.ppn_persen) || 0;
  const pphP = Number(cfg.pph23_persen) || 0;
  const gaji = a.emps.reduce((s, e) => s + (slipByUser[e.id] || 0), 0);
  const fee = Math.round(gaji * feeP / 100);
  const ppn = Math.round(fee * ppnP / 100);
  const total = gaji + fee + ppn;
  const pph = Math.round(fee * pphP / 100);
  const tagihan = total - pph;
  return { cfg, feeP, ppnP, pphP, gaji, fee, ppn, total, pph, tagihan };
}

function rupiahPlain(n) { return Number(n).toLocaleString("id-ID"); }

// ---------------------------------------------------------------------
// TAMPILAN HALAMAN
// ---------------------------------------------------------------------
function renderContent() {
  const content = document.getElementById("invoice-content");
  content.innerHTML = areas.map((a, i) => cardHtml(a, i)).join("");
  content.querySelectorAll(".area-card").forEach(bindCard);
}

function cardHtml(a, i) {
  const c = calc(a);
  const saved = savedByKey[a.key] || {};
  const areaLabel = a.area || "(Area belum diisi)";
  const noSlip = a.emps.filter(e => slipByUser[e.id] == null).length;

  const empRows = a.emps.map(e => `
    <tr>
      <td>${escapeHtml(e.full_name)}<br><span class="muted small">${escapeHtml(e.employee_code || "-")}</span></td>
      <td>${escapeHtml(e.position || "-")}</td>
      <td>${slipByUser[e.id] != null ? fmtRupiah(slipByUser[e.id]) : `<span class="muted">Tidak ada slip</span>`}</td>
    </tr>`).join("");

  const noRates = !c.cfg.id
    ? `Vendor ini belum ada di Master PT / Vendor.`
    : (!c.feeP && !c.ppnP && !c.pphP ? `Management fee, PPN, dan PPh 23 vendor ini masih 0% — atur di Master PT / Vendor bila perlu.` : "");

  const lines = [
    [`Total gaji karyawan`, c.gaji],
    c.feeP ? [`Management fee ${pct(c.feeP)}%`, c.fee] : null,
    c.ppnP ? [`PPN ${pct(c.ppnP)}%`, c.ppn] : null,
  ].filter(Boolean);

  return `
    <div class="table-wrap area-card" data-idx="${i}" style="margin-bottom:20px;">
      <div class="area-head">
        <div>
          <h3>${escapeHtml(a.vendor)}</h3>
          <span class="badge badge-muted">Area: ${escapeHtml(areaLabel)}</span>
          <span class="muted small">${a.emps.length} karyawan</span>
        </div>
      </div>
      ${noRates ? `<p class="muted small area-note">⚠ ${noRates}</p>` : ""}
      ${noSlip ? `<p class="muted small area-note">⚠ ${noSlip} karyawan tidak punya slip pada periode ini (dihitung Rp 0).</p>` : ""}
      <table class="table">
        <thead><tr><th>Nama</th><th>Jabatan</th><th>Total Pendapatan (Slip Final)</th></tr></thead>
        <tbody>${empRows}</tbody>
      </table>

      <div class="area-calc">
        ${lines.map(([l, v]) => `<div class="slip-line"><span>${l}</span><span>${fmtRupiah(v)}</span></div>`).join("")}
        ${c.feeP || c.ppnP ? `<div class="slip-line"><span>Total</span><span>${fmtRupiah(c.total)}</span></div>` : ""}
        ${c.pphP ? `<div class="slip-line"><span>PPh 23 ${pct(c.pphP)}%</span><span>(${fmtRupiah(c.pph)})</span></div>` : ""}
        <div class="slip-line total"><span>Total Tagihan (hitungan aplikasi)</span><span>${fmtRupiah(c.tagihan)}</span></div>
      </div>

      <div class="area-form">
        <label>No. Invoice <input type="text" class="inv-noinvoice" placeholder="No. Invoice" value="${escapeAttr(saved.no_invoice || "")}"></label>
        <label>Tanggal Invoice <input type="date" class="inv-tanggal" value="${escapeAttr(saved.tanggal_invoice || "")}"></label>
        <label>Nominal di Invoice Vendor <input type="number" min="0" step="1" class="inv-tagihan" value="${saved.nominal_tagihan_vendor || 0}"></label>
        <label>Selisih <span class="inv-selisih">${selisihBadge((Number(saved.nominal_tagihan_vendor) || 0) - c.tagihan)}</span></label>
        <label class="area-form-wide">Catatan <input type="text" class="inv-catatan" placeholder="Catatan" value="${escapeAttr(saved.catatan || "")}"></label>
        <div class="area-actions">
          <button class="btn-secondary btn-view-invoice">Lihat / Cetak Invoice</button>
          <button class="btn-primary btn-save-invoice">Simpan</button>
        </div>
      </div>
    </div>`;
}

function bindCard(card) {
  const a = areas[Number(card.dataset.idx)];
  const c = calc(a);
  card.querySelector(".inv-tagihan").addEventListener("input", e => {
    card.querySelector(".inv-selisih").innerHTML = selisihBadge((Number(e.target.value) || 0) - c.tagihan);
  });
  card.querySelector(".btn-save-invoice").addEventListener("click", () => onSave(card));
  card.querySelector(".btn-view-invoice").addEventListener("click", () => openPreview(card));
}

function readDraft(card) {
  return {
    no_invoice: card.querySelector(".inv-noinvoice").value.trim() || null,
    tanggal_invoice: card.querySelector(".inv-tanggal").value || null,
    nominal_tagihan_vendor: Number(card.querySelector(".inv-tagihan").value) || 0,
    catatan: card.querySelector(".inv-catatan").value.trim() || null,
  };
}

async function onSave(card) {
  const idx = Number(card.dataset.idx);
  const a = areas[idx];
  const { data: authUser } = await supabase.auth.getUser();
  const payload = {
    vendor: a.vendor,
    area: a.area,
    period,
    ...readDraft(card),
    updated_by: authUser?.user?.id || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("outsourcing_area_invoices").upsert(payload, { onConflict: "tenant_id,vendor,area,period" });
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  savedByKey[a.key] = payload;
  toast("Invoice tersimpan", "success");
  // Ganti kartu ini saja supaya isian di area lain yang belum disimpan tidak hilang.
  const tmp = document.createElement("div");
  tmp.innerHTML = cardHtml(a, idx);
  const fresh = tmp.firstElementChild;
  card.replaceWith(fresh);
  bindCard(fresh);
}

function selisihBadge(selisih) {
  if (selisih === 0) return `<span class="badge badge-ok">Cocok</span>`;
  const sign = selisih > 0 ? "+" : "";
  return `<span class="badge badge-warn">${sign}${fmtRupiah(selisih)}</span>`;
}

// ---------------------------------------------------------------------
// LEMBAR INVOICE (pratinjau + cetak)
// ---------------------------------------------------------------------
function invoiceHtml(a, draft) {
  const c = calc(a);
  const cfg = c.cfg;
  const rows = [];
  rows.push([`TOTAL GAJI KARYAWAN<br>PERIODE ${escapeHtml(fmtRangeUpper(periodInfo.period_start, periodInfo.period_end))}`, c.gaji]);
  if (c.feeP) rows.push([`MANAGEMENT FEE ${pct(c.feeP)}%`, c.fee]);
  if (c.ppnP) rows.push([`PPN ${pct(c.ppnP)}%`, c.ppn]);

  const bodyRows = rows.map((r, i) => `
    <tr><td class="c">${i + 1}</td><td>${r[0]}</td><td class="r">${rupiahPlain(r[1])}</td></tr>`).join("");

  return `
    <div class="invoice-doc">
      <h2 class="invoice-title">INVOICE</h2>
      <table class="invoice-meta">
        <tr><td>No</td><td>:</td><td>${escapeHtml(draft.no_invoice || "-")}</td></tr>
        <tr><td>Tanggal</td><td>:</td><td>${escapeHtml(fmtLongDate(draft.tanggal_invoice))}</td></tr>
        <tr><td>Penagih</td><td>:</td><td>${escapeHtml(a.vendor)}</td></tr>
        <tr><td>Kepada</td><td>:</td><td>${escapeHtml(KEPADA.nama)}</td></tr>
        <tr><td>Alamat</td><td>:</td><td>${escapeHtml(KEPADA.alamat)}</td></tr>
        <tr><td>Area</td><td>:</td><td>${escapeHtml((a.area || "-").toUpperCase())}</td></tr>
      </table>
      <table class="invoice-table">
        <thead><tr><th style="width:44px;">NO</th><th>KETERANGAN</th><th style="width:150px;">JUMLAH</th></tr></thead>
        <tbody>
          ${bodyRows}
          <tr class="strong"><td></td><td class="r">TOTAL</td><td class="r">${rupiahPlain(c.total)}</td></tr>
          ${c.pphP ? `<tr><td></td><td class="r">PPH 23 ${pct(c.pphP)}%</td><td class="r">(${rupiahPlain(c.pph)})</td></tr>` : ""}
          <tr class="strong"><td></td><td class="r">TOTAL TAGIHAN</td><td class="r">${rupiahPlain(c.tagihan)}</td></tr>
        </tbody>
      </table>
      <div class="invoice-foot">
        <div class="invoice-bank">
          <div>${escapeHtml(a.vendor)}</div>
          ${cfg.bank_rekening ? `<div>${escapeHtml(cfg.bank_rekening)}</div>` : ""}
        </div>
        <div class="invoice-sign">
          <div>MENGETAHUI</div>
          <div class="invoice-sign-space"></div>
          <div class="invoice-sign-name">${escapeHtml((cfg.nama_penandatangan || "").toUpperCase())}</div>
        </div>
      </div>
    </div>`;
}

function openPreview(card) {
  const a = areas[Number(card.dataset.idx)];
  document.getElementById("invoice-preview").innerHTML = invoiceHtml(a, readDraft(card));
  document.getElementById("modal-invoice").classList.remove("hidden");
}

function closePreview() {
  document.getElementById("modal-invoice").classList.add("hidden");
}

// Sama seperti printSlip(): salin ke #print-root lalu sembunyikan seluruh app saat print.
function printInvoice() {
  const src = document.getElementById("invoice-preview");
  let root = document.getElementById("print-root");
  if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
  root.innerHTML = `<div class="slip-print-area">${src.innerHTML}</div>`;
  document.body.classList.add("printing-slip");
  const cleanup = () => { document.body.classList.remove("printing-slip"); root.innerHTML = ""; window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  setTimeout(() => window.print(), 50);
}

// ---------------------------------------------------------------------
// EXPORT EXCEL — satu baris per area
// ---------------------------------------------------------------------
function doExport() {
  if (!employees.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  if (!periodInfo) { toast("Periode ini belum difinalisasi di Slip Gaji", "error"); return; }

  const rows = areas.map(a => {
    const c = calc(a);
    const s = savedByKey[a.key] || {};
    const vendorNominal = Number(s.nominal_tagihan_vendor) || 0;
    return {
      "Vendor": a.vendor,
      "Area": a.area || "-",
      "Periode": fmtRange(periodInfo.period_start, periodInfo.period_end),
      "Jumlah Karyawan": a.emps.length,
      "Total Gaji Karyawan": c.gaji,
      [`Management Fee (${pct(c.feeP)}%)`]: c.fee,
      [`PPN (${pct(c.ppnP)}%)`]: c.ppn,
      "Total": c.total,
      [`PPh 23 (${pct(c.pphP)}%)`]: c.pph,
      "Total Tagihan (Hitungan)": c.tagihan,
      "No. Invoice": s.no_invoice || "-",
      "Tanggal Invoice": s.tanggal_invoice || "-",
      "Nominal di Invoice Vendor": vendorNominal,
      "Selisih": vendorNominal - c.tagihan,
      "Catatan": s.catatan || "-",
    };
  });
  exportXLSX(`invoice-outsourcing-${period}.xlsx`, rows, "Invoice per Area");
}

// ---------------------------------------------------------------------
// HELPER
// ---------------------------------------------------------------------
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function periodLabelSimple(p) {
  const [y, m] = p.split("-").map(Number);
  return `${BULAN[m - 1]} ${y}`;
}

function parseYMD(s) { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return { y, m, d }; }

function fmtLongDate(s) {
  if (!s) return "-";
  const { y, m, d } = parseYMD(s);
  return `${d} ${BULAN[m - 1]} ${y}`;
}

// "21 November - 20 Desember 2025" (tahun awal dihilangkan bila sama)
function fmtRange(start, end) {
  if (!start || !end) return "-";
  const a = parseYMD(start), b = parseYMD(end);
  const left = a.y === b.y ? `${a.d} ${BULAN[a.m - 1]}` : `${a.d} ${BULAN[a.m - 1]} ${a.y}`;
  return `${left} - ${b.d} ${BULAN[b.m - 1]} ${b.y}`;
}
function fmtRangeUpper(start, end) { return fmtRange(start, end).toUpperCase(); }

function pct(n) { return String(Number(n) || 0).replace(".", ","); }

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
