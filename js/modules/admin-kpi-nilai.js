import { supabase } from "../supabaseClient.js";
import { toast, fmtDate } from "../core.js";
import { esc } from "../approvalHelper.js";
import { SCORE_LABEL, ratingBadge, KPI_CSS } from "./employee-kpi.js";

// =======================================================================
// PENILAIAN TIM (penilai / atasan). Menampilkan penilaian yang
// ditugaskan ke saya; nilai 1-5 per kriteria + komentar. Nilai akhir
// dihitung server (rata-rata tertimbang). Bisa diubah selama periodenya
// masih berjalan. Lihat 016_kpi_penilaian_kinerja.sql.
// =======================================================================

let root = null;
let me = null;
let reviews = [];
let cycles = new Map();
let tab = "todo";

export async function render(container, user) {
  root = container; me = user; tab = "todo";
  container.innerHTML = `
    <style>${KPI_CSS}
      .kpi-scale { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      .kpi-scale label { flex: 1; min-width: 56px; text-align: center; border: 1px solid var(--border); border-radius: 8px; padding: 8px 4px; cursor: pointer; font-size: .82rem; }
      .kpi-scale input { display: none; }
      .kpi-scale label:has(input:checked) { background: var(--primary, #2f5fd0); color: #fff; border-color: var(--primary, #2f5fd0); }
      .kpi-ref { display: flex; gap: 14px; flex-wrap: wrap; background: var(--bg, #f6f5f1); border-radius: 8px; padding: 8px 12px; font-size: .84rem; margin: 8px 0; }
    </style>
    <div class="page-header">
      <div>
        <h1>Penilaian Tim</h1>
        <p class="muted">Beri nilai kinerja untuk karyawan yang ditugaskan kepada Anda.</p>
      </div>
    </div>
    <div class="tabs">
      <button class="tab-btn active" data-t="todo">Perlu Dinilai</button>
      <button class="tab-btn" data-t="done">Sudah Dinilai</button>
    </div>
    <div id="kn-list"><p class="muted">Memuat…</p></div>
    <div id="kn-modal" class="modal hidden"><div class="modal-box modal-box-lg" id="kn-box"></div></div>`;
  root.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    root.querySelectorAll(".tab-btn").forEach(x => x.classList.toggle("active", x === b));
    tab = b.dataset.t; paint();
  }));
  root.querySelector("#kn-modal").addEventListener("click", e => { if (e.target.id === "kn-modal") close(); });
  await load();
}

async function load() {
  const [r, c] = await Promise.all([
    supabase.from("kpi_reviews").select("*").eq("reviewer_id", me.id).order("user_name"),
    supabase.from("kpi_cycles").select("*"),
  ]);
  if (r.error) { root.querySelector("#kn-list").innerHTML = `<div class="card"><p class="muted">Gagal memuat: ${esc(r.error.message)}</p></div>`; return; }
  reviews = r.data || [];
  cycles = new Map((c.data || []).map(x => [x.id, x]));
  paint();
}

function paint() {
  const rows = reviews.filter(x => (tab === "todo") === (x.status === "pending"));
  const el = root.querySelector("#kn-list");
  if (!rows.length) {
    el.innerHTML = `<div class="card"><p class="muted">${tab === "todo" ? "Tidak ada penilaian yang menunggu Anda." : "Belum ada penilaian yang Anda kirim."}</p></div>`;
    return;
  }
  const byCycle = new Map();
  for (const x of rows) { if (!byCycle.has(x.cycle_id)) byCycle.set(x.cycle_id, []); byCycle.get(x.cycle_id).push(x); }
  el.innerHTML = [...byCycle.entries()].map(([cid, list]) => {
    const c = cycles.get(cid);
    return `<h3 style="margin:16px 0 8px">${esc(c?.name || "Periode")} <span class="muted small">${c ? fmtDate(c.period_start) + " – " + fmtDate(c.period_end) : ""}${c?.status === "published" ? " • sudah dipublikasikan" : ""}</span></h3>` +
      list.map(x => `<div class="card kpi-card" data-id="${x.id}">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; flex-wrap:wrap;">
          <div><b>${esc(x.user_name || "Karyawan")}</b><div class="muted small">${esc(x.user_department || "-")}</div></div>
          ${x.status === "submitted" ? ratingBadge(x.overall_score) : `<span class="badge badge-warn">Belum dinilai</span>`}
        </div></div>`).join("");
  }).join("");
  el.querySelectorAll(".kpi-card").forEach(card => card.addEventListener("click", () => openForm(card.dataset.id)));
}

function close() { root.querySelector("#kn-modal").classList.add("hidden"); }

async function openForm(id) {
  const rv = reviews.find(x => x.id === id);
  const cyc = cycles.get(rv.cycle_id);
  const locked = cyc?.status !== "open";
  const [{ data: criteria }, { data: scores }] = await Promise.all([
    supabase.from("kpi_criteria").select("*").eq("cycle_id", rv.cycle_id).order("sort_order"),
    supabase.from("kpi_scores").select("*").eq("review_id", id),
  ]);
  const sc = new Map((scores || []).map(s => [s.criterion_id, s]));
  const box = root.querySelector("#kn-box");
  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:8px;">
      <div><h3 style="margin:0">${esc(rv.user_name)}</h3><div class="muted small">${esc(rv.user_department || "-")} • ${esc(cyc?.name || "")}</div></div>
      <button class="kpi-x" id="kn-close" aria-label="Tutup">✕</button>
    </div>
    <div id="kn-ref" class="kpi-ref muted">Memuat data kehadiran…</div>
    ${locked ? `<p class="small" style="color:var(--warn)">Periode sudah dipublikasikan, penilaian tidak bisa diubah.</p>` : ""}
    <form id="kn-form">
      ${(criteria || []).map(k => {
        const cur = sc.get(k.id);
        return `<div class="kpi-row" data-k="${k.id}">
          <b>${esc(k.name)}</b> <span class="muted small">bobot ${k.weight}</span>
          ${k.description ? `<div class="muted small">${esc(k.description)}</div>` : ""}
          <div class="kpi-scale">${[1, 2, 3, 4, 5].map(n => `
            <label title="${SCORE_LABEL[n]}"><input type="radio" name="s-${k.id}" value="${n}" ${cur?.score === n ? "checked" : ""} ${locked ? "disabled" : ""}>${n}<div class="small">${SCORE_LABEL[n]}</div></label>`).join("")}</div>
          <input type="text" class="kn-note" maxlength="500" placeholder="Catatan (opsional)" value="${esc(cur?.note || "")}" style="width:100%; margin-top:6px" ${locked ? "disabled" : ""}>
        </div>`;
      }).join("")}
      <div class="form-row" style="margin-top:12px"><label>Komentar umum
        <textarea name="comments" rows="3" maxlength="1000" ${locked ? "disabled" : ""}>${esc(rv.comments || "")}</textarea></label></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="kn-cancel">${locked ? "Tutup" : "Batal"}</button>
        ${locked ? "" : `<button type="submit" class="btn-primary">${rv.status === "submitted" ? "Perbarui Penilaian" : "Kirim Penilaian"}</button>`}
      </div>
    </form>`;
  root.querySelector("#kn-modal").classList.remove("hidden");
  box.querySelector("#kn-close").addEventListener("click", close);
  box.querySelector("#kn-cancel").addEventListener("click", close);
  loadReference(rv, cyc);

  box.querySelector("#kn-form").addEventListener("submit", async e => {
    e.preventDefault();
    const payload = [];
    for (const k of criteria || []) {
      const v = e.target.querySelector(`input[name="s-${k.id}"]:checked`)?.value;
      if (!v) return toast(`Beri nilai untuk "${k.name}"`, "error");
      payload.push({ criterion_id: k.id, score: Number(v), note: e.target.querySelector(`[data-k="${k.id}"] .kn-note`).value.trim() });
    }
    const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    const { data, error } = await supabase.rpc("kpi_submit_review", { p_review: id, p_scores: payload, p_comments: e.target.comments.value });
    btn.disabled = false;
    if (error) return toast(error.message, "error");
    toast(`Penilaian terkirim (nilai akhir ${Number(data).toFixed(2)})`, "success");
    close();
    await load();
  });
}

// Data pendukung dari absensi periode tsb (kalau penilai boleh membacanya).
async function loadReference(rv, cyc) {
  const el = root.querySelector("#kn-ref");
  const { data, error } = await supabase.from("attendance").select("check_in, check_in_status")
    .eq("user_id", rv.user_id).gte("date", cyc.period_start).lte("date", cyc.period_end);
  if (!el || !root.querySelector("#kn-ref")) return;
  if (error || !data) { el.textContent = "Data kehadiran tidak tersedia."; return; }
  const hadir = data.filter(a => a.check_in).length;
  const telat = data.filter(a => a.check_in_status === "telat").length;
  el.innerHTML = `<span>Referensi periode ${fmtDate(cyc.period_start)} – ${fmtDate(cyc.period_end)}:</span><b>${hadir} hari hadir</b><b>${telat}× telat</b>`;
}
