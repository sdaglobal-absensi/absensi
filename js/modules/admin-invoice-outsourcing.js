import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtDate, dateOnlyISO, exportXLSX } from "../core.js";

// =======================================================================
// INVOICE OUTSOURCING — mencocokkan tagihan dari PT vendor outsourcing
// dengan angka Slip Gaji internal untuk karyawan berstatus Outsourcing.
//
// Sengaja TIDAK menghitung ulang komponen gaji sendiri (itu logikanya ada
// di admin-slip-gaji.js) -- acuan internal di sini diambil dari
// `payroll_slips`, yaitu snapshot yang sudah DIBEKUKAN saat admin
// finalisasi periode itu di menu Slip Gaji. Alasannya: angka yang dipakai
// untuk cocokkan ke vendor harus angka yang sudah final/terkunci, bukan
// hasil hitung live yang masih bisa berubah kalau data absensi/lembur/tarif
// diedit lagi nanti. Kalau periode belum difinalisasi, halaman ini akan
// minta admin memfinalisasi dulu di menu Slip Gaji.
//
// Nominal tagihan dari vendor (+ No. Invoice, tanggal, catatan) disimpan
// manual per karyawan per periode di tabel `outsourcing_invoices` (lihat
// supabase-invoice-outsourcing.sql). Selisih dihitung otomatis: Nominal
// Tagihan Vendor - Total Pendapatan (acuan internal, sebelum potongan
// BPJS/PPh21/denda -- karena itu memang biasanya basis yang ditagihkan
// vendor ke perusahaan, bukan take-home pay karyawan).
// =======================================================================

let period = "";
let employees = []; // hanya yang jenis_hubungan_kerja = 'outsourcing' & aktif
let periodInfo = null; // baris payroll_periods utk periode terpilih, null = belum final
let slipByUser = {}; // { [userId]: { totalPendapatan, gajiBersih } } dari payroll_slips.snapshot
let invoiceByUser = {}; // { [userId]: outsourcing_invoices row }

export async function render(container) {
  period = dateOnlyISO(new Date()).slice(0, 7);

  container.innerHTML = `
    <div class="page-header">
      <h1>Invoice Outsourcing</h1>
      <div class="filter-row">
        <input type="month" id="filter-period" value="${period}">
        <button id="btn-export" class="btn-secondary no-print">Export Excel</button>
      </div>
    </div>
    <p class="small muted">
      Cocokkan tagihan PT vendor outsourcing dengan acuan internal (Total Pendapatan di Slip Gaji
      yang sudah difinalisasi). Input nominal tagihan vendor per karyawan -- selisih dihitung otomatis.
    </p>
    <div id="invoice-status"></div>
    <div id="invoice-content"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("filter-period").addEventListener("change", e => { period = e.target.value; load(); });
  document.getElementById("btn-export").addEventListener("click", doExport);

  await load();
}

async function load() {
  const content = document.getElementById("invoice-content");
  content.innerHTML = `<p class="muted">Memuat…</p>`;

  const [{ data: emps, error: empErr }, { data: pInfo }] = await Promise.all([
    supabase.from("profiles")
      .select("id, full_name, employee_code, position, department, bagian, unit_pt")
      .eq("jenis_hubungan_kerja", "outsourcing")
      .eq("is_active", true)
      .order("unit_pt"),
    supabase.from("payroll_periods").select("*").eq("period", period).maybeSingle(),
  ]);

  if (empErr) { content.innerHTML = `<p class="muted">Gagal memuat data: ${empErr.message}</p>`; return; }
  employees = emps || [];
  periodInfo = pInfo || null;

  renderStatus();

  if (!employees.length) {
    content.innerHTML = `<p class="muted">Belum ada karyawan dengan Jenis Hubungan Kerja "Outsourcing". Atur lewat menu Data Karyawan.</p>`;
    return;
  }

  if (!periodInfo) {
    slipByUser = {};
    content.innerHTML = `
      <p class="muted">
        Periode ini belum difinalisasi di menu <strong>Slip Gaji</strong>, jadi belum ada angka resmi
        untuk dicocokkan dengan tagihan vendor. Buka menu Slip Gaji, pilih periode ${periodLabelSimple(period)},
        lalu klik <strong>Finalisasi Periode Ini</strong> terlebih dahulu.
      </p>`;
    return;
  }

  const userIds = employees.map(e => e.id);
  const [{ data: slips }, { data: invoices }] = await Promise.all([
    supabase.from("payroll_slips").select("user_id, snapshot, gaji_bersih").eq("period", period).in("user_id", userIds),
    supabase.from("outsourcing_invoices").select("*").eq("period", period).in("user_id", userIds),
  ]);

  slipByUser = {};
  (slips || []).forEach(s => {
    slipByUser[s.user_id] = { totalPendapatan: s.snapshot?.totalPendapatan ?? 0, gajiBersih: s.gaji_bersih ?? 0 };
  });
  invoiceByUser = {};
  (invoices || []).forEach(i => { invoiceByUser[i.user_id] = i; });

  renderContent();
}

function renderStatus() {
  const el = document.getElementById("invoice-status");
  if (!employees.length) { el.innerHTML = ""; return; }
  if (periodInfo) {
    el.innerHTML = `<p class="small muted">🔒 Periode ${periodLabelSimple(period)} sudah final di Slip Gaji pada ${fmtDate(periodInfo.finalized_at)} -- angka acuan di bawah dibekukan (tidak berubah walau data absensi/tarif diubah lagi nanti).</p>`;
  } else {
    el.innerHTML = "";
  }
}

function groupByVendor() {
  const groups = {};
  for (const e of employees) {
    const vendor = e.unit_pt || "(Unit/PT belum diisi)";
    (groups[vendor] ??= []).push(e);
  }
  return groups;
}

function renderContent() {
  const content = document.getElementById("invoice-content");
  const groups = groupByVendor();
  const vendorNames = Object.keys(groups).sort();

  content.innerHTML = vendorNames.map(vendor => {
    const rows = groups[vendor];
    let vendorInternal = 0, vendorTagihan = 0;

    const rowsHtml = rows.map(e => {
      const slip = slipByUser[e.id];
      const inv = invoiceByUser[e.id] || { nominal_tagihan_vendor: 0, no_invoice: "", catatan: "" };
      const internal = slip?.totalPendapatan ?? null;
      const tagihan = Number(inv.nominal_tagihan_vendor) || 0;
      if (internal != null) vendorInternal += internal;
      vendorTagihan += tagihan;
      const selisih = internal != null ? tagihan - internal : null;

      return `
        <tr data-user-id="${e.id}">
          <td>${e.full_name}<br><span class="muted small">${e.employee_code || "-"}</span></td>
          <td>${e.position || "-"}</td>
          <td>${internal != null ? fmtRupiah(internal) : `<span class="muted">Tidak ada slip</span>`}</td>
          <td><input type="number" min="0" step="1" class="inv-tagihan" style="width:130px;" value="${inv.nominal_tagihan_vendor || 0}"></td>
          <td class="inv-selisih">${selisih == null ? "-" : selisihBadge(selisih)}</td>
          <td><input type="text" class="inv-noinvoice" style="width:120px;" placeholder="No. Invoice" value="${escapeAttr(inv.no_invoice || "")}"></td>
          <td><input type="text" class="inv-catatan" style="width:150px;" placeholder="Catatan" value="${escapeAttr(inv.catatan || "")}"></td>
          <td><button class="btn-link btn-save-invoice">Simpan</button></td>
        </tr>
      `;
    }).join("");

    const vendorSelisih = vendorTagihan - vendorInternal;

    return `
      <div class="table-wrap" style="margin-bottom:20px;">
        <h3 style="margin-bottom:8px;">${escapeHtml(vendor)}</h3>
        <table class="table">
          <thead>
            <tr><th>Nama</th><th>Jabatan</th><th>Total Pendapatan (Acuan Internal)</th><th>Nominal Tagihan Vendor</th><th>Selisih</th><th>No. Invoice</th><th>Catatan</th><th></th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot>
            <tr>
              <td colspan="2"><strong>Subtotal</strong></td>
              <td><strong>${fmtRupiah(vendorInternal)}</strong></td>
              <td><strong>${fmtRupiah(vendorTagihan)}</strong></td>
              <td>${selisihBadge(vendorSelisih)}</td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }).join("");

  content.querySelectorAll(".btn-save-invoice").forEach(btn => {
    btn.addEventListener("click", e => onSaveRow(e.target.closest("tr")));
  });
}

function selisihBadge(selisih) {
  if (selisih === 0) return `<span class="badge badge-ok">Cocok</span>`;
  const tone = Math.abs(selisih) < 1 ? "ok" : "warn";
  const sign = selisih > 0 ? "+" : "";
  return `<span class="badge badge-${tone}">${sign}${fmtRupiah(selisih)}</span>`;
}

async function onSaveRow(tr) {
  const userId = tr.dataset.userId;
  const nominal = Number(tr.querySelector(".inv-tagihan").value) || 0;
  const noInvoice = tr.querySelector(".inv-noinvoice").value.trim() || null;
  const catatan = tr.querySelector(".inv-catatan").value.trim() || null;

  const payload = {
    user_id: userId,
    period,
    nominal_tagihan_vendor: nominal,
    no_invoice: noInvoice,
    catatan,
    updated_at: new Date().toISOString(),
  };
  const { data: authUser } = await supabase.auth.getUser();
  payload.updated_by = authUser?.user?.id || null;

  const { error } = await supabase.from("outsourcing_invoices").upsert(payload, { onConflict: "user_id,period" });
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  invoiceByUser[userId] = payload;
  toast("Invoice tersimpan", "success");
  renderContent();
}

function doExport() {
  if (!employees.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  if (!periodInfo) { toast("Periode ini belum difinalisasi di Slip Gaji", "error"); return; }

  const rows = employees.map(e => {
    const slip = slipByUser[e.id];
    const inv = invoiceByUser[e.id] || { nominal_tagihan_vendor: 0, no_invoice: "", catatan: "" };
    const internal = slip?.totalPendapatan ?? 0;
    const tagihan = Number(inv.nominal_tagihan_vendor) || 0;
    return {
      "Nama": e.full_name,
      "Kode Karyawan": e.employee_code || "-",
      "Unit / PT (Vendor)": e.unit_pt || "-",
      "Jabatan": e.position || "-",
      "Total Pendapatan (Acuan Internal)": internal,
      "Nominal Tagihan Vendor": tagihan,
      "Selisih": tagihan - internal,
      "No. Invoice": inv.no_invoice || "-",
      "Catatan": inv.catatan || "-",
    };
  });
  exportXLSX(`invoice-outsourcing-${period}.xlsx`, rows, "Invoice Outsourcing");
}

function periodLabelSimple(p) {
  const [y, m] = p.split("-").map(Number);
  const names = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  return `${names[m - 1]} ${y}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
