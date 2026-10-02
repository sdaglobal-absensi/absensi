import { getPlanInfo, fmtDate } from "../core.js";

// =======================================================================
// PAKET & FITUR (Tahap 4) — halaman baca-saja untuk pemilik usaha:
// paket yang dipakai, pemakaian jumlah karyawan, dan fitur yang termasuk /
// belum termasuk. Perubahan paket dilakukan pemilik aplikasi (lihat
// README-TAHAP-4.md); pembayaran & upgrade mandiri ada di Tahap 5.
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
    ? `<p class="small muted" style="margin-top:6px;">Masa percobaan sampai ${esc(fmtDate(String(info.trial_ends_at).slice(0, 10)))}.</p>` : "";
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

    ${locked.length
      ? `<p class="small muted" style="margin-top:14px;">Ingin membuka ${locked.length === 1 ? "fitur yang belum termasuk" : "fitur yang belum termasuk"}? Hubungi penyedia aplikasi untuk menaikkan paket. Data yang sudah ada tidak hilang dan langsung bisa dipakai begitu fiturnya aktif.</p>`
      : `<p class="small muted" style="margin-top:14px;">Semua fitur tersedia di paketmu.</p>`}
  `;
}
