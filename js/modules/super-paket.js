import { supabase } from "../supabaseClient.js";
import { getPlanInfo, fmtDate, fmtDateTime, fmtRupiah, toast, confirmDialog } from "../core.js";
import { callFunction } from "../accountApi.js";

// =======================================================================
// PAKET & FITUR — paket yang dipakai, masa aktif, pemakaian karyawan, dan
// fitur yang termasuk / belum termasuk (Tahap 4).
// Tahap 5: Pemilik usaha bisa membeli / memperpanjang paket lewat Midtrans
// Snap (Edge Function "billing") dan melihat riwayat tagihan. Harga dan
// pembayaran selalu dihitung di server.
// =======================================================================

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_BADGE = {
  active: `<span class="badge badge-ok">Aktif</span>`,
  trial: `<span class="badge badge-warn">Percobaan</span>`,
  suspended: `<span class="badge badge-danger">Ditangguhkan</span>`,
};

// Fitur dasar: selalu ada di semua paket (tidak ada di katalog database).
const BASIC_FEATURES = [
  "Profil, absensi (check-in/out dengan foto & lokasi), dan riwayat",
  "Data karyawan, monitor absensi, dan laporan",
  "Master lokasi, jadwal kerja, hari libur, level, dan departemen",
  "Approval perubahan data karyawan",
  "Pengaturan sistem (akses menu per role)",
];

export async function render(container) {
  const info = await getPlanInfo({ force: true });
  if (!info) {
    container.innerHTML = `
      <div class="page-header"><div><h1>Paket &amp; Fitur</h1></div></div>
      <div class="card"><p class="muted">Informasi paket belum bisa dimuat. Pastikan <code>004_tahap4_paket_fitur.sql</code> sudah dijalankan, lalu muat ulang halaman.</p></div>`;
    return;
  }

  const count = Number(info.karyawan_count) || 0;
  const max = info.max_karyawan;                       // null = tanpa batas
  const pct = max ? Math.min(100, Math.round((count / max) * 100)) : 0;
  const nearLimit = max && pct >= 90;
  const trialInfo = info.status === "trial" && info.trial_ends_at
    ? `<p class="small muted" style="margin-top:6px;">Masa percobaan sampai ${esc(fmtDate(info.trial_ends_at))}.</p>`
    : info.plan_expires_at
      ? `<p class="small muted" style="margin-top:6px;">Aktif sampai ${esc(fmtDate(info.plan_expires_at))}${info.days_left !== null && info.days_left <= 7 ? ` (${info.days_left} hari lagi)` : ""}.</p>`
      : "";
  const roleInfo = info.role_mode === "ringkas"
    ? "Template ringkas: 2 role (Pemilik dan Karyawan)"
    : "Template lengkap: Super Admin, Super Admin HR, Admin HR, Admin, Karyawan";

  const catalog = Array.isArray(info.catalog) ? info.catalog : [];
  const included = catalog.filter(f => f.included);
  const locked = catalog.filter(f => !f.included);

  const featureRow = f => `
    <tr>
      <td><b>${esc(f.nama)}</b><div class="small muted">${esc(f.deskripsi || "")}</div></td>
      <td>${f.included ? `<span class="badge badge-ok">Termasuk</span>` : `<span class="badge badge-muted">Tidak termasuk</span>`}</td>
    </tr>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Paket &amp; Fitur</h1>
        <p class="muted">Paket yang dipakai usahamu dan fitur yang tersedia di dalamnya.</p>
      </div>
    </div>

    <div class="status-grid">
      <div class="status-card">
        <div class="status-label">Paket</div>
        <div class="status-value">${esc(info.plan_nama || info.plan)}</div>
        <div style="margin-top:6px;">${STATUS_BADGE[info.status] || ""}</div>
        ${trialInfo}
      </div>
      <div class="status-card ${nearLimit ? "" : "done"}">
        <div class="status-label">Karyawan</div>
        <div class="status-value">${count}${max ? ` / ${max}` : ""}</div>
        ${max
          ? `<div class="paket-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="${nearLimit ? "paket-bar-warn" : ""}" style="width:${pct}%"></span></div>
             <div class="small muted" style="margin-top:6px;">${nearLimit ? "Hampir mencapai batas paket." : "Batas jumlah karyawan paket ini."}</div>`
          : `<div class="small muted" style="margin-top:6px;">Tanpa batas</div>`}
      </div>
      <div class="status-card">
        <div class="status-label">Susunan role</div>
        <div class="small" style="margin-top:6px;">${esc(roleInfo)}</div>
      </div>
    </div>

    <h2 class="section-title">Selalu termasuk di semua paket</h2>
    <div class="card">
      <ul class="paket-list">${BASIC_FEATURES.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>

    <h2 class="section-title">Fitur tambahan (${included.length} dari ${catalog.length} aktif)</h2>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Fitur</th><th>Status di paketmu</th></tr></thead>
        <tbody>${[...included, ...locked].map(featureRow).join("")}</tbody>
      </table>
    </div>

    <p id="paket-note" class="small muted" style="margin-top:14px;">${locked.length
      ? "Data yang sudah ada tidak hilang dan langsung bisa dipakai begitu fitur yang belum termasuk diaktifkan."
      : "Semua fitur tersedia di paketmu."}</p>

    <div id="billing-area"></div>
  `;

  if (info.is_owner && info.plan !== "internal") await renderBilling(container.querySelector("#billing-area"), info);
  else if (locked.length && !info.is_owner) {
    container.querySelector("#paket-note").textContent +=
      " Minta Pemilik usaha (Super Admin) untuk menaikkan paket.";
  }
}

// =======================================================================
// LANGGANAN (Tahap 5) — hanya untuk Pemilik usaha
// =======================================================================
const ORDER_BADGE = {
  paid: `<span class="badge badge-ok">Lunas</span>`,
  pending: `<span class="badge badge-warn">Menunggu bayar</span>`,
  expired: `<span class="badge badge-muted">Kedaluwarsa</span>`,
  failed: `<span class="badge badge-danger">Gagal</span>`,
  canceled: `<span class="badge badge-muted">Dibatalkan</span>`,
};

let snapLoading = null;
function loadSnap(src, clientKey) {
  if (window.snap) return Promise.resolve();
  if (!snapLoading) {
    snapLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.setAttribute("data-client-key", clientKey);
      s.onload = () => resolve();
      s.onerror = () => { snapLoading = null; reject(new Error("Gagal memuat Midtrans. Periksa koneksi internet.")); };
      document.head.appendChild(s);
    });
  }
  return snapLoading;
}

async function renderBilling(el, info) {
  const { data, error } = await supabase.rpc("billing_overview");
  if (error || !data) {
    console.warn("billing_overview gagal (SQL Tahap 5 sudah dijalankan?):", error?.message);
    el.innerHTML = `<p class="small muted" style="margin-top:14px;">Pembelian paket belum tersedia. Hubungi penyedia aplikasi.</p>`;
    return;
  }

  const plans = (data.plans || []).filter(p => p.harga_bulanan || p.harga_tahunan);
  const orders = data.orders || [];
  let period = "monthly";

  const draw = () => {
    const hasYearly = plans.some(p => p.harga_tahunan);
    const planCard = p => {
      const price = period === "yearly" ? p.harga_tahunan : p.harga_bulanan;
      const isCurrent = info.plan === p.kode;
      const cur = plans.find(x => x.kode === info.plan);
      const lower = !!(info.plan_expires_at && cur && cur.sort_order > p.sort_order);
      const perMonth = period === "yearly" && price ? ` <small>≈ ${esc(fmtRupiah(Math.round(price / 12)))}/bulan</small>` : "";
      const save = period === "yearly" && p.harga_bulanan && p.harga_tahunan && p.harga_tahunan < p.harga_bulanan * 12
        ? `<span class="badge badge-ok">Hemat ${Math.round((1 - p.harga_tahunan / (p.harga_bulanan * 12)) * 100)}%</span>` : "";
      const feats = (info.catalog || []).filter(f => (p.features || []).includes(f.kode)).map(f => f.nama);
      const label = isCurrent && info.plan_expires_at ? "Perpanjang" : lower ? "Tidak tersedia" : "Pilih paket";
      return `
        <div class="plan-card ${isCurrent ? "current" : ""}">
          <h3>${esc(p.nama)} ${isCurrent ? `<span class="badge badge-ok">Paketmu</span>` : ""} ${save}</h3>
          <div class="plan-price">${price ? esc(fmtRupiah(price)) : "—"}<small> / ${period === "yearly" ? "tahun" : "bulan"}</small>${perMonth}</div>
          <div class="small muted">${esc(p.deskripsi || "")}</div>
          <div class="small">Karyawan: <b>${p.max_karyawan ? "maks. " + p.max_karyawan : "tanpa batas"}</b></div>
          <ul>${feats.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
          <button class="btn-primary" data-buy="${esc(p.kode)}" ${!price || lower ? "disabled" : ""}>${price ? label : "Belum dijual"}</button>
          ${lower ? `<div class="small muted">Paket ${esc(cur.nama)} masih aktif; turun paket bisa setelah masa aktifnya habis.</div>` : ""}
        </div>`;
    };

    el.innerHTML = `
      <h2 class="section-title">Langganan</h2>
      ${plans.length ? `
        <div class="period-toggle" role="group" aria-label="Periode">
          <button type="button" data-period="monthly" class="${period === "monthly" ? "active" : ""}">Bulanan</button>
          ${hasYearly ? `<button type="button" data-period="yearly" class="${period === "yearly" ? "active" : ""}">Tahunan</button>` : ""}
        </div>
        <div class="plan-grid">${plans.map(planCard).join("")}</div>
        <p class="small muted" style="margin-top:10px;">Pembayaran lewat Midtrans (transfer bank, e-wallet, QRIS, kartu). Paket aktif otomatis setelah pembayaran terkonfirmasi. Memperpanjang paket yang sama menambah masa aktif; naik paket berlaku langsung dan masa aktif dihitung ulang dari hari ini (tanpa prorata).</p>`
        : `<p class="small muted">Belum ada paket berbayar yang dijual. Hubungi penyedia aplikasi.</p>`}

      ${orders.length ? `
      <h2 class="section-title">Riwayat tagihan</h2>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Tanggal</th><th>Paket</th><th>Nominal</th><th>Status</th><th></th></tr></thead>
          <tbody>${orders.map(o => `
            <tr>
              <td>${esc(fmtDateTime(o.created_at))}<div class="small muted">${esc(o.order_code)}</div></td>
              <td>${esc(o.plan_nama || o.plan)} <span class="small muted">· ${o.period === "yearly" ? "1 tahun" : "1 bulan"}</span></td>
              <td>${esc(fmtRupiah(o.amount))}</td>
              <td>${ORDER_BADGE[o.status] || esc(o.status)}${o.paid_at ? `<div class="small muted">${esc(fmtDate(o.paid_at))}</div>` : ""}</td>
              <td>${o.status === "pending"
                ? `${o.snap_token ? `<button class="btn-secondary btn-sm" data-pay="${esc(o.order_code)}" data-token="${esc(o.snap_token)}">Lanjut bayar</button> ` : ""}<button class="btn-link" data-sync="${esc(o.order_code)}">Cek status</button>`
                : ""}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>` : ""}`;

    el.querySelectorAll("[data-period]").forEach(b => b.addEventListener("click", () => { period = b.dataset.period; draw(); }));
    el.querySelectorAll("[data-buy]").forEach(b => b.addEventListener("click", () => buy(b, b.dataset.buy)));
    el.querySelectorAll("[data-pay]").forEach(b => b.addEventListener("click", () => openSnap(b.dataset.token, b.dataset.pay)));
    el.querySelectorAll("[data-sync]").forEach(b => b.addEventListener("click", () => syncOrder(b.dataset.sync, true)));
  };

  async function buy(btn, planKode) {
    const p = plans.find(x => x.kode === planKode);
    const price = period === "yearly" ? p.harga_tahunan : p.harga_bulanan;
    const ok = await confirmDialog({
      title: `Beli paket ${p.nama}?`,
      message: `${fmtRupiah(price)} untuk ${period === "yearly" ? "12 bulan" : "1 bulan"}. Kamu akan diarahkan ke jendela pembayaran Midtrans.`,
      confirmLabel: "Lanjut ke pembayaran",
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const r = await callFunction("billing", { action: "create-order", plan: planKode, period });
      await loadSnap(r.snap_js, r.client_key);
      openSnap(r.snap_token, r.order_code);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function openSnap(token, orderCode) {
    try {
      if (!window.snap) {
        const c = await callFunction("billing", { action: "config" });
        await loadSnap(c.snap_js, c.client_key);
      }
    } catch (e) {
      toast(e.message, "error");
      return;
    }
    window.snap.pay(token, {
      onSuccess: () => syncOrder(orderCode, false),
      onPending: () => syncOrder(orderCode, false),
      onError: () => { toast("Pembayaran gagal. Coba lagi atau pakai metode lain.", "error"); syncOrder(orderCode, false); },
      onClose: () => syncOrder(orderCode, false),
    });
  }

  async function syncOrder(orderCode, verbose) {
    try {
      const r = await callFunction("billing", { action: "sync-order", order_code: orderCode });
      if (r.status === "paid") {
        toast("Pembayaran diterima. Paket aktif!", "success");
        // Muat ulang supaya sidebar, banner, dan fitur ikut berubah.
        setTimeout(() => location.reload(), 900);
      } else if (verbose) {
        toast(r.status === "pending" ? "Pembayaran belum diterima." : `Status pesanan: ${r.status}.`, "info");
      }
    } catch (e) {
      if (verbose) toast(e.message, "error");
    }
  }

  draw();
}
