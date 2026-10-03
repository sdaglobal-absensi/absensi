import { supabase } from "../supabaseClient.js";
import { fmtDate } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// PENILAIAN KINERJA SAYA (sisi karyawan). Hanya hasil dari periode yang
// SUDAH DIPUBLIKASIKAN HR yang terlihat (dijaga RLS di server — lihat
// 016_kpi_penilaian_kinerja.sql). Helper di bawah juga dipakai halaman
// admin-kpi.js dan admin-kpi-nilai.js.
// =======================================================================

export const SCORE_LABEL = { 1: "Sangat Kurang", 2: "Kurang", 3: "Cukup", 4: "Baik", 5: "Sangat Baik" };

export function ratingLabel(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "-";
  if (s >= 4.5) return "Sangat Baik";
  if (s >= 3.5) return "Baik";
  if (s >= 2.5) return "Cukup";
  if (s >= 1.5) return "Kurang";
  return "Sangat Kurang";
}

export function ratingBadge(score) {
  if (score == null) return `<span class="badge badge-muted">-</span>`;
  const s = Number(score);
  const cls = s >= 3.5 ? "badge-ok" : s >= 2.5 ? "badge-warn" : "badge-danger";
  return `<span class="badge ${cls}">${s.toFixed(2)} • ${ratingLabel(s)}</span>`;
}

export const KPI_CSS = `
  .kpi-bar { height: 8px; border-radius: 4px; background: #E8E6E0; overflow: hidden; }
  .kpi-bar > i { display: block; height: 100%; background: var(--primary-light, #5b8def); }
  .kpi-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .kpi-row:last-child { border-bottom: 0; }
  .kpi-card { cursor: pointer; margin-bottom: 10px; }
  .kpi-card:hover { border-color: var(--accent); }
  .kpi-x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 1.1rem; padding: 0 4px; }
`;

let root = null;

export async function render(container, user) {
  root = container;
  container.innerHTML = `
    <style>${KPI_CSS}</style>
    <div class="page-header">
      <div>
        <h1>Penilaian Kinerja Saya</h1>
        <p class="muted">Hasil penilaian kinerja dari atasan. Hasil tampil setelah HR mempublikasikan periodenya.</p>
      </div>
    </div>
    <div id="kpi-me"><p class="muted">Memuat…</p></div>
    <div id="kpi-me-modal" class="modal hidden"><div class="modal-box modal-box-lg" id="kpi-me-box"></div></div>`;
  root.querySelector("#kpi-me-modal").addEventListener("click", e => { if (e.target.id === "kpi-me-modal") e.currentTarget.classList.add("hidden"); });

  const [{ data: reviews, error }, { data: cycles }] = await Promise.all([
    supabase.from("kpi_reviews").select("*").eq("user_id", user.id).eq("status", "submitted").order("submitted_at", { ascending: false }),
    supabase.from("kpi_cycles").select("id, name, period_start, period_end, status"),
  ]);
  const el = root.querySelector("#kpi-me");
  if (error) { el.innerHTML = `<div class="card"><p class="muted">Gagal memuat: ${esc(error.message)}</p></div>`; return; }
  const cyc = new Map((cycles || []).map(c => [c.id, c]));
  const rows = (reviews || []).filter(r => cyc.get(r.cycle_id)?.status === "published");
  if (!rows.length) {
    el.innerHTML = `<div class="card"><p class="muted">Belum ada hasil penilaian yang dipublikasikan.</p></div>`;
    return;
  }
  el.innerHTML = rows.map(r => {
    const c = cyc.get(r.cycle_id);
    return `<div class="card kpi-card" data-id="${r.id}">
      <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
        <div><b>${esc(c.name)}</b><div class="muted small">${fmtDate(c.period_start)} – ${fmtDate(c.period_end)}</div></div>
        ${ratingBadge(r.overall_score)}
      </div></div>`;
  }).join("");
  el.querySelectorAll(".kpi-card").forEach(card => card.addEventListener("click", () => {
    const r = rows.find(x => x.id === card.dataset.id);
    openDetail(r, cyc.get(r.cycle_id));
  }));
}

async function openDetail(r, c) {
  const [{ data: criteria }, { data: scores }] = await Promise.all([
    supabase.from("kpi_criteria").select("*").eq("cycle_id", r.cycle_id).order("sort_order"),
    supabase.from("kpi_scores").select("*").eq("review_id", r.id),
  ]);
  const sc = new Map((scores || []).map(s => [s.criterion_id, s]));
  const box = root.querySelector("#kpi-me-box");
  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:8px;">
      <div><h3 style="margin:0">${esc(c.name)}</h3><div class="muted small">${fmtDate(c.period_start)} – ${fmtDate(c.period_end)}${r.reviewer_name ? " • Penilai: " + esc(r.reviewer_name) : ""}</div></div>
      <button class="kpi-x" id="kpi-me-close" aria-label="Tutup">✕</button>
    </div>
    <div style="margin:12px 0">${ratingBadge(r.overall_score)}</div>
    ${(criteria || []).map(k => {
      const s = sc.get(k.id);
      return `<div class="kpi-row">
        <div style="display:flex; justify-content:space-between; gap:8px;"><b>${esc(k.name)}</b><span>${s ? s.score + " / 5 • " + SCORE_LABEL[s.score] : "-"}</span></div>
        ${k.description ? `<div class="muted small">${esc(k.description)}</div>` : ""}
        <div class="kpi-bar" style="margin-top:6px"><i style="width:${s ? s.score * 20 : 0}%"></i></div>
        ${s?.note ? `<div class="small" style="margin-top:6px">${esc(s.note)}</div>` : ""}
      </div>`;
    }).join("")}
    ${r.comments ? `<div style="margin-top:12px"><b>Komentar penilai</b><p style="white-space:pre-line; margin:4px 0 0">${esc(r.comments)}</p></div>` : ""}
    <div class="modal-actions"><button class="btn-primary" id="kpi-me-close2">Tutup</button></div>`;
  const modal = root.querySelector("#kpi-me-modal");
  modal.classList.remove("hidden");
  box.querySelector("#kpi-me-close").addEventListener("click", () => modal.classList.add("hidden"));
  box.querySelector("#kpi-me-close2").addEventListener("click", () => modal.classList.add("hidden"));
}
