import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, confirmDialog, exportCSV } from "../core.js";
import { esc } from "../approvalHelper.js";
import { ratingBadge, ratingLabel, KPI_CSS } from "./employee-kpi.js";

// =======================================================================
// PENILAIAN KINERJA (KPI) — sisi HR. Kelola periode, kriteria berbobot,
// buat penilaian per karyawan, atur penilai, publikasikan hasil, export.
// Penilai memberi nilai di menu "Penilaian Tim" (admin-kpi-nilai.js).
// Lihat 016_kpi_penilaian_kinerja.sql.
// =======================================================================

let root = null;
let cycles = [];
let revCounts = {};      // { cycle_id: { total, submitted } }
let cur = null;          // periode yang sedang dibuka
let criteria = [];
let reviews = [];
let candidates = [];
let departments = [];

export async function render(container) {
  root = container; cur = null;
  container.innerHTML = `<style>${KPI_CSS}</style><div id="kk-main"><p class="muted">Memuat…</p></div>
    <div id="kk-modal" class="modal hidden"><div class="modal-box" id="kk-box"></div></div>`;
  root.querySelector("#kk-modal").addEventListener("click", e => { if (e.target.id === "kk-modal") closeModal(); });
  await loadCycles();
}

function closeModal() { root.querySelector("#kk-modal").classList.add("hidden"); }
function openModal(html) { root.querySelector("#kk-box").innerHTML = html; root.querySelector("#kk-modal").classList.remove("hidden"); return root.querySelector("#kk-box"); }

async function loadCycles() {
  const [c, r, d] = await Promise.all([
    supabase.from("kpi_cycles").select("*").order("period_start", { ascending: false }),
    supabase.from("kpi_reviews").select("cycle_id, status"),
    supabase.from("profiles").select("department").eq("is_active", true),
  ]);
  const main = root.querySelector("#kk-main");
  if (c.error) { main.innerHTML = `<div class="card"><p class="muted">Gagal memuat: ${esc(c.error.message)}.<br>Pastikan SQL <b>016_kpi_penilaian_kinerja.sql</b> sudah dijalankan.</p></div>`; return; }
  cycles = c.data || [];
  revCounts = {};
  for (const x of r.data || []) {
    const n = revCounts[x.cycle_id] || (revCounts[x.cycle_id] = { total: 0, submitted: 0 });
    n.total++; if (x.status === "submitted") n.submitted++;
  }
  departments = [...new Set((d.data || []).map(p => p.department).filter(Boolean))].sort();
  paintList();
}

function paintList() {
  const main = root.querySelector("#kk-main");
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Penilaian Kinerja (KPI)</h1>
        <p class="muted">Buat periode penilaian, tentukan kriteria dan bobot, lalu atasan memberi nilai. Hasil baru terlihat karyawan setelah Anda mempublikasikannya.</p>
      </div>
      <button id="kk-new" class="btn-primary">+ Periode Penilaian</button>
    </div>
    ${cycles.length ? cycles.map(c => {
      const n = revCounts[c.id] || { total: 0, submitted: 0 };
      return `<div class="card kpi-card" data-id="${c.id}">
        <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
          <div><b>${esc(c.name)}</b><div class="muted small">${fmtDate(c.period_start)} – ${fmtDate(c.period_end)}</div></div>
          <div><span class="badge ${c.status === "published" ? "badge-ok" : "badge-warn"}">${c.status === "published" ? "Dipublikasikan" : "Berjalan"}</span></div>
        </div>
        <div class="muted small" style="margin-top:6px">${n.submitted} dari ${n.total} penilaian sudah dikirim</div>
      </div>`;
    }).join("") : `<div class="card"><p class="muted">Belum ada periode penilaian. Klik “+ Periode Penilaian”.</p></div>`}`;
  main.querySelector("#kk-new").addEventListener("click", openNewCycle);
  main.querySelectorAll(".kpi-card").forEach(el => el.addEventListener("click", () => openCycle(el.dataset.id)));
}

function openNewCycle() {
  const year = new Date().getFullYear();
  const box = openModal(`
    <h3>Periode Penilaian Baru</h3>
    <form id="kk-form">
      <div class="form-row"><label>Nama periode <input name="name" maxlength="120" required placeholder="mis. Semester 1 ${year}"></label></div>
      <div class="form-row"><label>Mulai <input type="date" name="start" value="${year}-01-01" required></label></div>
      <div class="form-row"><label>Selesai <input type="date" name="end" value="${year}-06-30" required></label></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="kk-cancel">Batal</button>
        <button type="submit" class="btn-primary">Buat Periode</button>
      </div>
    </form>`);
  box.querySelector("#kk-cancel").addEventListener("click", closeModal);
  box.querySelector("#kk-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target;
    if (f.end.value < f.start.value) return toast("Tanggal selesai tidak boleh sebelum tanggal mulai", "error");
    const { data, error } = await supabase.from("kpi_cycles").insert({ name: f.name.value.trim(), period_start: f.start.value, period_end: f.end.value }).select().single();
    if (error) return toast(error.message, "error");
    closeModal();
    await supabase.rpc("kpi_seed_default_criteria", { p_cycle: data.id }); // kriteria bawaan, bisa diubah
    await loadCycles();
    openCycle(data.id);
  });
}

async function openCycle(id) {
  cur = cycles.find(c => c.id === id);
  if (!cur) return;
  const [k, r, cand] = await Promise.all([
    supabase.from("kpi_criteria").select("*").eq("cycle_id", id).order("sort_order"),
    supabase.from("kpi_reviews").select("*").eq("cycle_id", id).order("user_name"),
    supabase.rpc("kpi_reviewer_candidates"),
  ]);
  criteria = k.data || []; reviews = r.data || []; candidates = cand.data || [];
  paintCycle();
}

function isLocked() {
  return cur.status === "published" || reviews.some(r => r.status === "submitted");
}

function paintCycle() {
  const locked = isLocked();
  const totalW = criteria.reduce((s, k) => s + Number(k.weight), 0);
  const done = reviews.filter(r => r.status === "submitted");
  const avg = done.length ? done.reduce((s, r) => s + Number(r.overall_score), 0) / done.length : null;
  const dist = {};
  for (const r of done) { const l = ratingLabel(r.overall_score); dist[l] = (dist[l] || 0) + 1; }
  const main = root.querySelector("#kk-main");
  main.innerHTML = `
    <div class="page-header">
      <div>
        <button id="kk-back" class="btn-secondary" style="margin-bottom:8px">← Semua periode</button>
        <h1 style="margin:0">${esc(cur.name)}</h1>
        <p class="muted">${fmtDate(cur.period_start)} – ${fmtDate(cur.period_end)} • <span class="badge ${cur.status === "published" ? "badge-ok" : "badge-warn"}">${cur.status === "published" ? "Dipublikasikan" : "Berjalan"}</span></p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start;">
        <button id="kk-export" class="btn-secondary">Export CSV</button>
        <button id="kk-publish" class="btn-primary">${cur.status === "published" ? "Tarik Publikasi" : "Publikasikan Hasil"}</button>
        ${cur.status === "open" ? `<button id="kk-del" class="btn-secondary" style="color:var(--danger)">Hapus Periode</button>` : ""}
      </div>
    </div>

    <div class="status-grid">
      <div class="status-card"><span class="status-label">Penilaian Terkirim</span><span class="status-value">${done.length} / ${reviews.length}</span></div>
      <div class="status-card"><span class="status-label">Rata-rata Nilai</span><span class="status-value">${avg == null ? "-" : avg.toFixed(2)}</span><span class="muted small">${avg == null ? "" : ratingLabel(avg)}</span></div>
      <div class="status-card"><span class="status-label">Sebaran Predikat</span><span class="small">${Object.keys(dist).length ? Object.entries(dist).map(([l, n]) => `${l}: <b>${n}</b>`).join("<br>") : "-"}</span></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-top:0">Kriteria & Bobot</h3>
      ${locked ? `<p class="small" style="color:var(--warn)">Kriteria terkunci karena sudah ada penilaian yang dikirim atau periode sudah dipublikasikan.</p>` : ""}
      ${criteria.length ? criteria.map(k => `
        <div class="kpi-row" data-id="${k.id}" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <input class="kc-name" value="${esc(k.name)}" maxlength="100" style="flex:1; min-width:140px" ${locked ? "disabled" : ""}>
          <input class="kc-weight" type="number" min="1" max="1000" step="any" value="${k.weight}" style="width:80px" title="Bobot" ${locked ? "disabled" : ""}>
          <span class="muted small" style="width:48px">${totalW ? Math.round(Number(k.weight) / totalW * 100) : 0}%</span>
          ${locked ? "" : `<button class="kpi-x kc-del" aria-label="Hapus kriteria">×</button>`}
        </div>`).join("") : `<p class="muted">Belum ada kriteria.</p>`}
      ${locked ? "" : `<form id="kk-addc" style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        <input name="name" placeholder="Nama kriteria baru" maxlength="100" style="flex:1; min-width:140px" required>
        <input name="weight" type="number" min="1" max="1000" step="any" value="10" style="width:80px" title="Bobot" required>
        <button class="btn-secondary" type="submit">Tambah</button>
        ${criteria.length ? "" : `<button class="btn-secondary" type="button" id="kk-seed">Isi kriteria bawaan</button>`}
      </form>`}
      <p class="muted small" style="margin:8px 0 0">Bobot bersifat relatif: persentase dihitung dari total bobot (${totalW || 0}).</p>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
        <h3 style="margin:0">Penilaian Karyawan</h3>
        ${cur.status === "open" ? `<div style="display:flex; gap:8px; flex-wrap:wrap;">
          <select id="kk-dept"><option value="">Semua departemen</option>${departments.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}</select>
          <button class="btn-secondary" id="kk-start">Buat Penilaian</button></div>` : ""}
      </div>
      ${reviews.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Karyawan</th><th>Departemen</th><th>Penilai</th><th>Status / Nilai</th><th></th></tr></thead>
        <tbody>${reviews.map(r => `<tr data-id="${r.id}">
          <td>${esc(r.user_name || "-")}</td>
          <td>${esc(r.user_department || "-")}</td>
          <td>${r.status === "submitted" || cur.status === "published"
            ? esc(r.reviewer_name || "-")
            : `<select class="kr-reviewer"><option value="">— pilih penilai —</option>${candidates.filter(c => c.id !== r.user_id).map(c => `<option value="${c.id}" ${c.id === r.reviewer_id ? "selected" : ""}>${esc(c.full_name)}</option>`).join("")}</select>`}</td>
          <td>${r.status === "submitted" ? ratingBadge(r.overall_score) : `<span class="badge ${r.reviewer_id ? "badge-warn" : "badge-danger"}">${r.reviewer_id ? "Menunggu penilai" : "Belum ada penilai"}</span>`}</td>
          <td style="white-space:nowrap">${r.status === "submitted" ? `<button class="btn-secondary kr-view">Lihat</button>` : (cur.status === "open" ? `<button class="kpi-x kr-del" title="Hapus" aria-label="Hapus">×</button>` : "")}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">Belum ada penilaian. ${cur.status === "open" ? "Klik “Buat Penilaian” untuk membuat satu penilaian per karyawan aktif." : ""}</p>`}
      <p class="muted small" style="margin:8px 0 0">Penilai otomatis diisi atasan tingkat 1 di Struktur Organisasi yang punya menu “Penilaian Tim”. Yang belum terisi bisa dipilih manual.</p>
    </div>`;

  main.querySelector("#kk-back").addEventListener("click", () => { cur = null; loadCycles(); });
  main.querySelector("#kk-export").addEventListener("click", doExport);
  main.querySelector("#kk-publish").addEventListener("click", togglePublish);
  main.querySelector("#kk-del")?.addEventListener("click", delCycle);
  main.querySelector("#kk-seed")?.addEventListener("click", async () => { await act(supabase.rpc("kpi_seed_default_criteria", { p_cycle: cur.id })); });
  main.querySelector("#kk-addc")?.addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target;
    const max = Math.max(0, ...criteria.map(k => k.sort_order));
    await act(supabase.from("kpi_criteria").insert({ cycle_id: cur.id, name: f.name.value.trim(), weight: Number(f.weight.value), sort_order: max + 1 }));
  });
  main.querySelectorAll(".kpi-row[data-id]").forEach(row => {
    const id = row.dataset.id;
    const save = async () => {
      const name = row.querySelector(".kc-name").value.trim(), weight = Number(row.querySelector(".kc-weight").value);
      if (!name || !(weight > 0)) return toast("Nama dan bobot kriteria harus diisi", "error");
      await act(supabase.from("kpi_criteria").update({ name, weight }).eq("id", id));
    };
    row.querySelector(".kc-name")?.addEventListener("change", save);
    row.querySelector(".kc-weight")?.addEventListener("change", save);
    row.querySelector(".kc-del")?.addEventListener("click", () => act(supabase.from("kpi_criteria").delete().eq("id", id)));
  });
  main.querySelector("#kk-start")?.addEventListener("click", async () => {
    const dept = main.querySelector("#kk-dept").value;
    const { data, error } = await supabase.rpc("kpi_start_reviews", { p_cycle: cur.id, p_department: dept || null });
    if (error) return toast(error.message, "error");
    toast(data ? `${data} penilaian dibuat` : "Semua karyawan sudah punya penilaian di periode ini", data ? "success" : "info");
    await refresh();
  });
  main.querySelectorAll("tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector(".kr-reviewer")?.addEventListener("change", async e => {
      const { error } = await supabase.rpc("kpi_assign_reviewer", { p_review: id, p_reviewer: e.target.value || null });
      if (error) { toast(error.message, "error"); return refresh(); }
      await refresh();
    });
    tr.querySelector(".kr-del")?.addEventListener("click", () => act(supabase.from("kpi_reviews").delete().eq("id", id).eq("status", "pending")));
    tr.querySelector(".kr-view")?.addEventListener("click", () => viewReview(id));
  });
}

// Jalankan satu operasi Supabase; tampilkan error; segarkan halaman.
async function act(promise) {
  const { error } = await promise;
  if (error) { toast(error.message, "error"); }
  await refresh();
}

async function refresh() {
  const id = cur.id;
  const { data } = await supabase.from("kpi_cycles").select("*").eq("id", id).single();
  if (data) { const i = cycles.findIndex(c => c.id === id); if (i >= 0) cycles[i] = data; }
  await openCycle(id);
}

async function togglePublish() {
  const pub = cur.status !== "published";
  const pending = reviews.filter(r => r.status !== "submitted").length;
  const msg = pub
    ? (pending ? `Masih ada ${pending} penilaian yang belum dikirim — karyawan tersebut tidak akan melihat hasil, dan penilai tidak bisa lagi mengirim selama periode dipublikasikan.\n\n` : "") + "Karyawan akan bisa melihat hasil penilaiannya masing-masing."
    : "Hasil disembunyikan lagi dari karyawan, dan penilaian bisa diubah kembali.";
  const ok = await confirmDialog({ title: pub ? "Publikasikan hasil?" : "Tarik publikasi?", message: msg, confirmLabel: pub ? "Publikasikan" : "Tarik" });
  if (!ok) return;
  const { error } = await supabase.rpc("kpi_set_published", { p_cycle: cur.id, p_publish: pub });
  if (error) return toast(error.message, "error");
  toast(pub ? "Hasil dipublikasikan" : "Publikasi ditarik", "success");
  await refresh();
}

async function delCycle() {
  const ok = await confirmDialog({ title: "Hapus periode?", message: `“${cur.name}” beserta kriteria dan semua penilaiannya akan dihapus permanen.`, confirmLabel: "Hapus", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.from("kpi_cycles").delete().eq("id", cur.id);
  if (error) return toast(error.message, "error");
  cur = null;
  toast("Periode dihapus", "success");
  await loadCycles();
}

async function viewReview(id) {
  const r = reviews.find(x => x.id === id);
  const { data: scores } = await supabase.from("kpi_scores").select("*").eq("review_id", id);
  const sc = new Map((scores || []).map(s => [s.criterion_id, s]));
  const box = openModal(`
    <h3 style="margin-bottom:2px">${esc(r.user_name)}</h3>
    <div class="muted small">${esc(r.user_department || "-")} • Penilai: ${esc(r.reviewer_name || "-")}${r.submitted_at ? " • " + fmtDate(r.submitted_at) : ""}</div>
    <div style="margin:10px 0">${ratingBadge(r.overall_score)}</div>
    ${criteria.map(k => { const s = sc.get(k.id); return `<div class="kpi-row">
      <div style="display:flex; justify-content:space-between; gap:8px;"><b>${esc(k.name)}</b><span>${s ? s.score + " / 5" : "-"}</span></div>
      <div class="kpi-bar" style="margin-top:4px"><i style="width:${s ? s.score * 20 : 0}%"></i></div>
      ${s?.note ? `<div class="small" style="margin-top:4px">${esc(s.note)}</div>` : ""}</div>`; }).join("")}
    ${r.comments ? `<p style="white-space:pre-line"><b>Komentar:</b> ${esc(r.comments)}</p>` : ""}
    <div class="modal-actions"><button class="btn-primary" id="kk-close">Tutup</button></div>`);
  box.querySelector("#kk-close").addEventListener("click", closeModal);
}

async function doExport() {
  const ids = reviews.map(r => r.id);
  if (!ids.length) return toast("Belum ada penilaian untuk di-export", "error");
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("kpi_scores").select("review_id, criterion_id, score").in("review_id", ids).range(from, from + 999);
    if (error) return toast(error.message, "error");
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const by = new Map();
  for (const s of all) { if (!by.has(s.review_id)) by.set(s.review_id, new Map()); by.get(s.review_id).set(s.criterion_id, s.score); }
  const rows = reviews.map(r => {
    const row = { Nama: r.user_name || "", Departemen: r.user_department || "", Penilai: r.reviewer_name || "", Status: r.status === "submitted" ? "Dinilai" : "Belum dinilai" };
    for (const k of criteria) row[`${k.name} (bobot ${k.weight})`] = by.get(r.id)?.get(k.id) ?? "";
    row["Nilai Akhir"] = r.overall_score ?? "";
    row["Predikat"] = r.overall_score != null ? ratingLabel(r.overall_score) : "";
    row["Komentar"] = r.comments || "";
    return row;
  });
  exportCSV(`kpi-${cur.name.replace(/[^\w-]+/g, "_")}.csv`, rows);
}
