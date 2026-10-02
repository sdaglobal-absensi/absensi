import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, fmtRupiah, confirmDialog } from "../core.js";

// =======================================================================
// ADMIN PLATFORM (Tahap 5) — khusus pemilik aplikasi (baris di
// platform_admins). Kelola semua usaha: paket, masa aktif, trial, status,
// fitur tambahan, harga paket, dan lihat pesanan serta log perubahan.
// Penjaga sebenarnya ada di database: setiap fungsi pa_* memeriksa
// is_platform_admin(); menu ini hanya menyembunyikan tampilan.
// =======================================================================

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_BADGE = {
  active: `<span class="badge badge-ok">Aktif</span>`,
  trial: `<span class="badge badge-warn">Trial</span>`,
  suspended: `<span class="badge badge-danger">Ditangguhkan</span>`,
};
const ORDER_BADGE = {
  paid: `<span class="badge badge-ok">Lunas</span>`,
  pending: `<span class="badge badge-warn">Menunggu</span>`,
  expired: `<span class="badge badge-muted">Kedaluwarsa</span>`,
  failed: `<span class="badge badge-danger">Gagal</span>`,
  canceled: `<span class="badge badge-muted">Dibatalkan</span>`,
};
const ACTION_LABEL = {
  set_plan: "Ubah paket", extend: "Perpanjang", start_trial: "Mulai trial", set_status: "Ubah status",
  set_feature: "Fitur tambahan", set_price: "Ubah harga", set_trial: "Pengaturan trial",
  expire: "Paket habis (otomatis)", payment: "Pembayaran (otomatis)",
};

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

const state = { overview: null, tenants: [], orders: null, audit: null, tab: "ringkasan", query: "" };

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Admin Platform</h1>
        <p class="muted">Kelola semua usaha, paket, dan pembayaran. Hanya terlihat oleh pemilik aplikasi.</p>
      </div>
    </div>
    <div class="tabs" id="pa-tabs">
      <button class="tab-btn" data-tab="ringkasan">Ringkasan</button>
      <button class="tab-btn" data-tab="usaha">Usaha</button>
      <button class="tab-btn" data-tab="pesanan">Pesanan</button>
      <button class="tab-btn" data-tab="harga">Harga &amp; Trial</button>
      <button class="tab-btn" data-tab="log">Log</button>
    </div>
    <div id="pa-body"><p class="muted">Memuat…</p></div>`;

  container.querySelector("#pa-tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab-btn");
    if (b) { state.tab = b.dataset.tab; draw(container); }
  });

  try {
    await reloadCore();
  } catch (e) {
    container.querySelector("#pa-body").innerHTML =
      `<div class="card"><p class="muted">Tidak bisa memuat: ${esc(e.message)}. Pastikan <code>005_tahap5_billing.sql</code> sudah dijalankan dan akunmu terdaftar di <code>platform_admins</code>.</p></div>`;
    return;
  }
  draw(container);
}

async function reloadCore() {
  const [overview, tenants] = await Promise.all([rpc("pa_overview"), rpc("pa_tenants")]);
  state.overview = overview;
  state.tenants = tenants;
  state.orders = null;   // dimuat ulang saat tab dibuka
  state.audit = null;
}

async function draw(container) {
  container.querySelectorAll("#pa-tabs .tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === state.tab));
  const body = container.querySelector("#pa-body");
  try {
    if (state.tab === "ringkasan") drawSummary(body);
    else if (state.tab === "usaha") drawTenants(body, container);
    else if (state.tab === "pesanan") await drawOrders(body);
    else if (state.tab === "harga") drawPricing(body, container);
    else if (state.tab === "log") await drawLog(body);
  } catch (e) {
    body.innerHTML = `<div class="card"><p class="muted">Gagal memuat: ${esc(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------- Ringkasan
function endOf(t) { return t.status === "trial" ? t.trial_ends_at : t.plan_expires_at; }

function drawSummary(body) {
  const o = state.overview;
  const st = o.by_status || {};
  const soon = state.tenants
    .filter(t => !t.is_default && t.status !== "suspended" && endOf(t))
    .filter(t => new Date(endOf(t)) - Date.now() < 7 * 864e5)
    .sort((a, b) => new Date(endOf(a)) - new Date(endOf(b)));

  body.innerHTML = `
    <div class="status-grid">
      <div class="status-card"><div class="status-label">Usaha</div><div class="status-value">${o.tenants_total}</div>
        <div class="small muted" style="margin-top:6px;">${st.active || 0} aktif · ${st.trial || 0} trial · ${st.suspended || 0} ditangguhkan</div></div>
      <div class="status-card done"><div class="status-label">Pendapatan bulan ini</div><div class="status-value">${esc(fmtRupiah(o.revenue_month))}</div>
        <div class="small muted" style="margin-top:6px;">30 hari terakhir: ${esc(fmtRupiah(o.revenue_30d))}</div></div>
      <div class="status-card"><div class="status-label">Pesanan menunggu bayar</div><div class="status-value">${o.pending_orders}</div>
        <div class="small muted" style="margin-top:6px;">${o.paid_orders} pesanan lunas sepanjang waktu</div></div>
      <div class="status-card ${o.expiring_7d ? "" : "done"}"><div class="status-label">Berakhir ≤ 7 hari</div><div class="status-value">${o.expiring_7d}</div></div>
    </div>

    <h2 class="section-title">Sebaran paket</h2>
    <div class="card"><div class="pa-inline">${Object.entries(o.by_plan || {}).map(([k, n]) =>
      `<span class="badge badge-muted">${esc(k)}: ${n}</span>`).join(" ") || "—"}</div></div>

    <h2 class="section-title">Segera berakhir atau sudah lewat</h2>
    ${soon.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Usaha</th><th>Paket</th><th>Berakhir</th></tr></thead>
      <tbody>${soon.map(t => `<tr><td><b>${esc(t.nama)}</b><div class="small muted">${esc(t.kode)}</div></td>
        <td>${esc(t.plan_nama || t.plan)} ${STATUS_BADGE[t.status] || ""}</td>
        <td>${esc(fmtDate(endOf(t)))}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="small muted">Tidak ada.</p>`}
    <p class="small muted" style="margin-top:14px;">Mode pendaftaran publik: <b>${o.settings?.public_mode ? "terbuka" : "tertutup"}</b> (diubah lewat SQL Editor, lihat README Tahap 3).</p>`;
}

// ---------------------------------------------------------------- Usaha
function drawTenants(body, container) {
  body.innerHTML = `
    <input type="search" id="pa-q" class="pa-search" placeholder="Cari nama atau kode usaha…" value="${esc(state.query)}">
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Usaha</th><th>Paket</th><th>Karyawan</th><th>Dibuat</th><th></th></tr></thead>
      <tbody id="pa-rows"></tbody>
    </table></div>`;

  const rows = body.querySelector("#pa-rows");
  const paint = () => {
    const q = state.query.trim().toLowerCase();
    const list = state.tenants.filter(t => !q || t.nama.toLowerCase().includes(q) || t.kode.toLowerCase().includes(q));
    rows.innerHTML = list.length ? list.map(t => {
      const end = endOf(t);
      const lapsed = t.effective_plan !== t.plan;
      return `<tr>
        <td><b>${esc(t.nama)}</b>${t.is_default ? ` <span class="badge badge-muted">Utama</span>` : ""}
          <div class="small muted">${esc(t.kode)} · ${esc(t.owner_email || "tanpa pemilik")}</div></td>
        <td>${esc(t.plan_nama || t.plan)} ${STATUS_BADGE[t.status] || ""}
          ${end ? `<div class="small muted">${t.status === "trial" ? "Trial" : "Aktif"} sampai ${esc(fmtDate(end))}${lapsed ? " (sudah lewat)" : ""}</div>` : ""}</td>
        <td>${t.karyawan}${t.max_karyawan ? ` / ${t.max_karyawan}` : ""}</td>
        <td>${esc(fmtDate(t.created_at))}</td>
        <td><button class="btn-secondary btn-sm" data-manage="${esc(t.kode)}">Kelola</button></td>
      </tr>`;
    }).join("") : `<tr><td colspan="5" class="muted">Tidak ada usaha yang cocok.</td></tr>`;
  };
  paint();
  body.querySelector("#pa-q").addEventListener("input", e => { state.query = e.target.value; paint(); });
  rows.addEventListener("click", e => {
    const b = e.target.closest("[data-manage]");
    if (b) openManage(state.tenants.find(t => t.kode === b.dataset.manage), container);
  });
}

function modal(html) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box modal-box-lg">${html}</div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.addEventListener("mousedown", e => { if (e.target === m) close(); });
  return { el: m, close };
}

// "2026-11-30" -> akhir hari itu di WIB.
const endOfDayWIB = d => (d ? `${d}T23:59:59+07:00` : null);

function openManage(t, container) {
  const o = state.overview;
  const paidPlans = o.plans.filter(p => p.is_active && !["free", "internal"].includes(p.kode));
  const allPlans = o.plans.filter(p => p.is_active && p.kode !== "internal");
  const locked = t.is_default;
  const { el, close } = modal(`
    <h3>${esc(t.nama)} <span class="small muted">· ${esc(t.kode)}</span></h3>
    <p class="small muted">${esc(t.plan_nama || t.plan)} ${STATUS_BADGE[t.status] || ""} · ${t.karyawan} karyawan${t.max_karyawan ? ` (maks. ${t.max_karyawan})` : ""}</p>
    ${locked ? `<p class="small" style="color:var(--warn);">Usaha utama: paket dan status tidak bisa diubah dari sini. Fitur tambahan tetap bisa diatur.</p>` : ""}

    <div class="pa-section"><h4>Ubah paket</h4>
      <div class="pa-inline">
        <label>Paket <select id="m-plan" ${locked ? "disabled" : ""}>${allPlans.map(p => `<option value="${esc(p.kode)}" ${p.kode === t.plan ? "selected" : ""}>${esc(p.nama)}</option>`).join("")}</select></label>
        <label>Berlaku sampai <input type="date" id="m-exp" ${locked ? "disabled" : ""}></label>
        <label class="checkbox-row"><input type="checkbox" id="m-keep" ${locked ? "disabled" : ""}> Pertahankan batas karyawan lama</label>
        <button class="btn-primary" id="m-setplan" ${locked ? "disabled" : ""}>Terapkan</button>
      </div>
      <p class="small muted">Tanggal kosong = tanpa kedaluwarsa (mis. mitra atau hadiah). Paket Gratis selalu tanpa tanggal.</p>
    </div>

    <div class="pa-section"><h4>Perpanjang / kurangi masa aktif</h4>
      <div class="pa-inline">
        <label>Hari (negatif = kurangi) <input type="number" id="m-days" value="30" step="1"></label>
        <button class="btn-secondary" id="m-extend" ${locked ? "disabled" : ""}>Terapkan</button>
      </div>
    </div>

    <div class="pa-section"><h4>Mulai trial</h4>
      <div class="pa-inline">
        <label>Paket <select id="m-tplan" ${locked ? "disabled" : ""}>${paidPlans.map(p => `<option value="${esc(p.kode)}">${esc(p.nama)}</option>`).join("")}</select></label>
        <label>Lama (hari) <input type="number" id="m-tdays" value="14" min="1" max="365"></label>
        <button class="btn-secondary" id="m-trial" ${locked ? "disabled" : ""}>Mulai trial</button>
      </div>
    </div>

    <div class="pa-section"><h4>Status usaha</h4>
      ${t.status === "suspended"
        ? `<button class="btn-primary" id="m-status" data-to="active" ${locked ? "disabled" : ""}>Aktifkan kembali</button>`
        : `<button class="btn-outline-danger" id="m-status" data-to="suspended" ${locked ? "disabled" : ""}>Tangguhkan usaha</button>`}
      <p class="small muted" style="margin-top:6px;">Usaha yang ditangguhkan tidak bisa membaca data apa pun sampai diaktifkan lagi.</p>
    </div>

    <div class="pa-section"><h4>Fitur tambahan / dicabut</h4>
      <div class="pa-feat-grid">${o.features.map(f => {
        const cur = t.override?.[f.kode];
        const v = cur === true ? "on" : cur === false ? "off" : "";
        return `<span>${esc(f.nama)}</span>
          <select data-feat="${esc(f.kode)}" data-orig="${v}">
            <option value="" ${v === "" ? "selected" : ""}>Ikut paket</option>
            <option value="on" ${v === "on" ? "selected" : ""}>Tambahkan</option>
            <option value="off" ${v === "off" ? "selected" : ""}>Cabut</option>
          </select>`;
      }).join("")}</div>
      <div style="margin-top:10px;"><button class="btn-secondary" id="m-feats">Simpan fitur</button></div>
    </div>

    <div class="modal-actions"><button class="btn-secondary" id="m-close">Tutup</button></div>`);

  const run = async (fn, okMsg) => {
    try {
      await fn();
      toast(okMsg, "success");
      close();
      await reloadCore();
      draw(container);
    } catch (e) { toast(e.message, "error"); }
  };
  const $ = id => el.querySelector(id);

  $("#m-close").addEventListener("click", close);

  $("#m-setplan").addEventListener("click", () => run(
    () => rpc("pa_set_plan", {
      p_kode: t.kode, p_plan: $("#m-plan").value, p_keep_limit: $("#m-keep").checked,
      p_expires_at: endOfDayWIB($("#m-exp").value),
    }), "Paket diubah"));

  $("#m-extend").addEventListener("click", () => run(
    () => rpc("pa_extend", { p_kode: t.kode, p_days: parseInt($("#m-days").value, 10) }), "Masa aktif diubah"));

  $("#m-trial").addEventListener("click", () => run(
    () => rpc("pa_start_trial", { p_kode: t.kode, p_plan: $("#m-tplan").value, p_days: parseInt($("#m-tdays").value, 10) }),
    "Trial dimulai"));

  $("#m-status").addEventListener("click", async e => {
    const to = e.currentTarget.dataset.to;
    const ok = await confirmDialog({
      title: to === "suspended" ? "Tangguhkan usaha ini?" : "Aktifkan usaha ini?",
      message: to === "suspended"
        ? `Semua pengguna ${t.nama} langsung tidak bisa melihat data sampai diaktifkan lagi.`
        : `Pengguna ${t.nama} bisa mengakses datanya lagi.`,
      confirmLabel: to === "suspended" ? "Tangguhkan" : "Aktifkan",
      confirmClass: to === "suspended" ? "btn-danger" : "btn-primary",
    });
    if (ok) run(() => rpc("pa_set_status", { p_kode: t.kode, p_status: to }), "Status diubah");
  });

  $("#m-feats").addEventListener("click", () => run(async () => {
    const changed = [...el.querySelectorAll("[data-feat]")].filter(s => s.value !== s.dataset.orig);
    if (!changed.length) throw new Error("Tidak ada perubahan fitur.");
    for (const s of changed) {
      await rpc("pa_set_feature", {
        p_kode: t.kode, p_feature: s.dataset.feat, p_enabled: s.value === "" ? null : s.value === "on",
      });
    }
  }, "Fitur disimpan"));
}

// ---------------------------------------------------------------- Pesanan
async function drawOrders(body) {
  if (!state.orders) state.orders = await rpc("pa_orders", { p_limit: 100 });
  const list = state.orders;
  body.innerHTML = list.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>Waktu</th><th>Usaha</th><th>Paket</th><th>Nominal</th><th>Status</th></tr></thead>
    <tbody>${list.map(o => `<tr>
      <td>${esc(fmtDateTime(o.created_at))}<div class="small muted">${esc(o.order_code)}</div></td>
      <td><b>${esc(o.tenant_nama)}</b><div class="small muted">${esc(o.tenant_kode)}</div></td>
      <td>${esc(o.plan)} <span class="small muted">· ${o.period === "yearly" ? "1 tahun" : "1 bulan"}</span></td>
      <td>${esc(fmtRupiah(o.amount))}</td>
      <td>${ORDER_BADGE[o.status] || esc(o.status)}${o.payment_type ? `<div class="small muted">${esc(o.payment_type)}</div>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`
    : `<p class="muted">Belum ada pesanan.</p>`;
}

// ---------------------------------------------------------------- Harga & trial
function drawPricing(body, container) {
  const o = state.overview;
  const sellable = o.plans.filter(p => !["free", "internal"].includes(p.kode));
  body.innerHTML = `
    <h2 class="section-title" style="margin-top:0;">Harga paket (Rupiah)</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Paket</th><th>Per bulan</th><th>Per tahun</th><th></th></tr></thead>
      <tbody>${sellable.map(p => `<tr data-plan="${esc(p.kode)}">
        <td><b>${esc(p.nama)}</b><div class="small muted">${p.max_karyawan ? "maks. " + p.max_karyawan + " karyawan" : "tanpa batas karyawan"}</div></td>
        <td><input type="number" min="1" step="1000" class="pr-m" value="${p.harga_bulanan ?? ""}" placeholder="kosong = tidak dijual"></td>
        <td><input type="number" min="1" step="1000" class="pr-y" value="${p.harga_tahunan ?? ""}" placeholder="opsional"></td>
        <td><button class="btn-primary btn-sm pr-save">Simpan</button></td></tr>`).join("")}</tbody>
    </table></div>
    <p class="small muted" style="margin-top:8px;">Perubahan harga hanya berlaku untuk pesanan BARU. Pesanan yang sudah dibuat tetap memakai nominal saat dibuat.</p>

    <h2 class="section-title">Trial untuk pendaftar baru</h2>
    <div class="card form-card">
      <div class="pa-inline">
        <label>Lama (hari) <input type="number" id="tr-days" min="0" max="365" value="${o.settings?.trial_days ?? 0}"></label>
        <label>Paket trial <select id="tr-plan">${sellable.map(p => `<option value="${esc(p.kode)}" ${p.kode === o.settings?.trial_plan ? "selected" : ""}>${esc(p.nama)}</option>`).join("")}</select></label>
        <button class="btn-primary" id="tr-save">Simpan</button>
      </div>
      <p class="small muted" style="margin-top:8px;">0 = pendaftar baru langsung paket Gratis. Setelah trial habis, usaha otomatis kembali ke Gratis (data tetap aman). Hanya berlaku saat pendaftaran publik dibuka.</p>
    </div>`;

  const done = async msg => { toast(msg, "success"); await reloadCore(); draw(container); };

  body.querySelectorAll(".pr-save").forEach(btn => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    const num = v => (v === "" ? null : parseInt(v, 10));
    try {
      await rpc("pa_set_price", { p_plan: tr.dataset.plan, p_bulanan: num(tr.querySelector(".pr-m").value), p_tahunan: num(tr.querySelector(".pr-y").value) });
      await done("Harga disimpan");
    } catch (e) { toast(e.message, "error"); }
  }));

  body.querySelector("#tr-save").addEventListener("click", async () => {
    try {
      await rpc("pa_set_trial", { p_days: parseInt(body.querySelector("#tr-days").value, 10), p_plan: body.querySelector("#tr-plan").value });
      await done("Pengaturan trial disimpan");
    } catch (e) { toast(e.message, "error"); }
  });
}

// ---------------------------------------------------------------- Log
function describe(a) {
  const d = a.detail || {};
  switch (a.action) {
    case "set_plan": return `paket → ${d.plan}${d.expires_at ? `, sampai ${fmtDate(d.expires_at)}` : ", tanpa kedaluwarsa"}`;
    case "extend": return `${d.days > 0 ? "+" : ""}${d.days} hari → ${fmtDate(d.new_end)}`;
    case "start_trial": return `${d.plan}, ${d.days} hari`;
    case "set_status": return `status → ${d.status}`;
    case "set_feature": return `${d.feature}: ${d.enabled === null ? "ikut paket" : d.enabled ? "ditambahkan" : "dicabut"}`;
    case "set_price": return `${d.plan}: bulanan ${d.bulanan ?? "-"}, tahunan ${d.tahunan ?? "-"}`;
    case "set_trial": return `${d.days} hari, paket ${d.plan}`;
    case "expire": return `dari ${d.from_plan}${d.was_trial ? " (trial)" : ""} ke free`;
    case "payment": return `${d.plan} ${d.period === "yearly" ? "1 tahun" : "1 bulan"}, ${fmtRupiah(d.amount)}, sampai ${fmtDate(d.expires_at)}`;
    default: return "";
  }
}

async function drawLog(body) {
  if (!state.audit) state.audit = await rpc("pa_audit", { p_limit: 100 });
  const list = state.audit;
  body.innerHTML = list.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>Waktu</th><th>Aksi</th><th>Usaha</th><th>Detail</th><th>Oleh</th></tr></thead>
    <tbody>${list.map(a => `<tr>
      <td>${esc(fmtDateTime(a.created_at))}</td>
      <td>${esc(ACTION_LABEL[a.action] || a.action)}</td>
      <td>${a.tenant_nama ? `<b>${esc(a.tenant_nama)}</b><div class="small muted">${esc(a.tenant_kode)}</div>` : "—"}</td>
      <td class="small">${esc(describe(a))}</td>
      <td class="small muted">${esc(a.actor_email || "sistem")}</td>
    </tr>`).join("")}</tbody></table></div>`
    : `<p class="muted">Belum ada catatan.</p>`;
}
