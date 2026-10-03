import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, confirmDialog, dateOnlyISO } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// ONBOARDING & OFFBOARDING (HR) — Prioritas Menengah #8
// Checklist tugas saat karyawan baru masuk / resign. Semua perubahan
// lewat fungsi server (lihat 015_onboarding_offboarding.sql). Checklist
// TIDAK mengubah data karyawan: HR tetap menonaktifkan akun di Data
// Karyawan; di sini hanya dicatat sudah dikerjakan atau belum.
// =======================================================================

const KIND_LABEL = { onboarding: "Onboarding", offboarding: "Offboarding" };
const STATUS_LABEL = { open: "Berjalan", done: "Selesai", cancelled: "Dibatalkan" };

let root = null;
let people = [];
let lists = [];       // employee_checklists
let counts = {};      // { checklist_id: { total, done } }
let templates = [];
let view = "checklist";
let fStatus = "open";
let fKind = "";
let openId = null;

export async function render(container) {
  root = container;
  view = "checklist"; fStatus = "open"; fKind = ""; openId = null;
  container.innerHTML = `
    <style>
      .ob-bar { height: 7px; border-radius: 4px; background: #E8E6E0; overflow: hidden; margin-top: 8px; }
      .ob-bar > i { display: block; height: 100%; background: var(--ok, #2e9b5f); }
      .ob-card { cursor: pointer; margin-bottom: 10px; }
      .ob-card:hover { border-color: var(--accent); }
      .ob-item { display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid var(--border); }
      .ob-item:last-child { border-bottom: 0; }
      .ob-item.done .ob-title { text-decoration: line-through; color: var(--muted); }
      .ob-item input[type=checkbox] { margin-top: 4px; width: 18px; height: 18px; flex: none; }
      .ob-item .ob-body { flex: 1; min-width: 0; }
      .ob-note { width: 100%; margin-top: 4px; font-size: .84rem; }
      .ob-x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 1.1rem; padding: 0 4px; }
      .ob-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 10px 0 4px; }
      .ob-fact { background: var(--bg, #f6f5f1); border-radius: 8px; padding: 8px 10px; font-size: .82rem; }
      .ob-fact b { display: block; font-size: 1rem; }
    </style>
    <div class="page-header">
      <div>
        <h1>Onboarding &amp; Offboarding</h1>
        <p class="muted">Checklist tugas saat karyawan baru masuk atau resign: dokumen, serah terima aset, penonaktifan akun, dan gaji terakhir.</p>
      </div>
      <button id="ob-new" class="btn-primary">+ Mulai Checklist</button>
    </div>
    <div class="tabs">
      <button class="tab-btn active" data-v="checklist">Checklist</button>
      <button class="tab-btn" data-v="template">Template Tugas</button>
    </div>
    <div id="ob-suggest"></div>
    <div id="ob-main"><p class="muted">Memuat…</p></div>
    <div id="ob-modal" class="modal hidden"><div class="modal-box modal-box-lg" id="ob-modal-box"></div></div>
  `;
  root.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    root.querySelectorAll(".tab-btn").forEach(x => x.classList.toggle("active", x === b));
    view = b.dataset.v;
    paint();
  }));
  root.querySelector("#ob-new").addEventListener("click", () => openStart());
  root.querySelector("#ob-modal").addEventListener("click", e => { if (e.target.id === "ob-modal") closeModal(); });
  await reload();
}

async function reload() {
  const [p, l, i] = await Promise.all([
    supabase.from("profiles").select("id, full_name, department, join_date, resign_date, is_active").order("full_name"),
    supabase.from("employee_checklists").select("*").order("created_at", { ascending: false }),
    supabase.from("employee_checklist_items").select("checklist_id, is_done"),
  ]);
  if (l.error) {
    root.querySelector("#ob-main").innerHTML = `<div class="card"><p class="muted">Gagal memuat: ${esc(l.error.message)}.<br>Pastikan SQL <b>015_onboarding_offboarding.sql</b> sudah dijalankan.</p></div>`;
    return;
  }
  people = p.data || [];
  lists = l.data || [];
  counts = {};
  for (const r of i.data || []) {
    const c = counts[r.checklist_id] || (counts[r.checklist_id] = { total: 0, done: 0 });
    c.total++; if (r.is_done) c.done++;
  }
  paint();
  if (openId) openDetail(openId, true);
}

function personOf(id) { return people.find(p => p.id === id); }

function paint() {
  if (view === "template") return paintTemplates();
  paintSuggestions();
  const rows = lists.filter(c => (fStatus === "all" || c.status === fStatus) && (!fKind || c.kind === fKind));
  root.querySelector("#ob-main").innerHTML = `
    <div class="card" style="margin-bottom:12px; display:flex; gap:8px; flex-wrap:wrap;">
      <select id="ob-fs" aria-label="Filter status">
        <option value="open">Berjalan</option><option value="done">Selesai</option>
        <option value="cancelled">Dibatalkan</option><option value="all">Semua status</option>
      </select>
      <select id="ob-fk" aria-label="Filter jenis">
        <option value="">Semua jenis</option><option value="onboarding">Onboarding</option><option value="offboarding">Offboarding</option>
      </select>
    </div>
    ${rows.length ? rows.map(cardHtml).join("") : `<div class="card"><p class="muted">Belum ada checklist ${fStatus === "open" ? "yang berjalan" : "pada filter ini"}. Klik “+ Mulai Checklist”.</p></div>`}`;
  const fs = root.querySelector("#ob-fs"), fk = root.querySelector("#ob-fk");
  fs.value = fStatus; fk.value = fKind;
  fs.addEventListener("change", () => { fStatus = fs.value; paint(); });
  fk.addEventListener("change", () => { fKind = fk.value; paint(); });
  root.querySelectorAll(".ob-card").forEach(el => el.addEventListener("click", () => openDetail(el.dataset.id)));
}

function cardHtml(c) {
  const p = personOf(c.user_id);
  const n = counts[c.id] || { total: 0, done: 0 };
  const pct = n.total ? Math.round(n.done / n.total * 100) : 0;
  const cls = c.status === "done" ? "badge-ok" : c.status === "cancelled" ? "badge-muted" : "badge-warn";
  return `<div class="card ob-card" data-id="${c.id}">
    <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
      <div><b>${esc(p?.full_name || "Karyawan")}</b>
        <div class="muted small">${esc(p?.department || "-")} • ${KIND_LABEL[c.kind]}${c.target_date ? " • " + (c.kind === "onboarding" ? "Masuk " : "Resign ") + fmtDate(c.target_date) : ""}</div></div>
      <div><span class="badge ${cls}">${STATUS_LABEL[c.status]}</span></div>
    </div>
    <div class="ob-bar"><i style="width:${pct}%"></i></div>
    <div class="muted small" style="margin-top:4px">${n.done} dari ${n.total} tugas selesai</div>
  </div>`;
}

// Saran: karyawan baru (masuk <= 30 hari) tanpa onboarding, dan karyawan
// yang sudah punya tanggal resign tanpa offboarding.
function paintSuggestions() {
  const today = dateOnlyISO(new Date());
  const ago = dateOnlyISO(new Date(Date.now() - 30 * 86400000));
  const has = (uid, kind) => lists.some(c => c.user_id === uid && c.kind === kind && c.status !== "cancelled");
  const newbies = people.filter(p => p.is_active && p.join_date && p.join_date >= ago && p.join_date <= today && !has(p.id, "onboarding"));
  const leavers = people.filter(p => p.resign_date && p.resign_date >= ago && !has(p.id, "offboarding"));
  const el = root.querySelector("#ob-suggest");
  if (!newbies.length && !leavers.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="card" style="margin-bottom:12px; border-left:3px solid var(--warn);">
    <b>Belum punya checklist</b>
    ${[...newbies.map(p => ({ p, kind: "onboarding" })), ...leavers.map(p => ({ p, kind: "offboarding" }))].slice(0, 8).map(({ p, kind }) => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0;">
        <span>${esc(p.full_name)} <span class="muted small">• ${KIND_LABEL[kind]} • ${kind === "onboarding" ? "masuk " + fmtDate(p.join_date) : "resign " + fmtDate(p.resign_date)}</span></span>
        <button class="btn-secondary ob-sg" data-u="${p.id}" data-k="${kind}">Mulai</button>
      </div>`).join("")}
  </div>`;
  el.querySelectorAll(".ob-sg").forEach(b => b.addEventListener("click", () => startNow(b.dataset.u, b.dataset.k)));
}

async function startNow(uid, kind) {
  const p = personOf(uid);
  const target = kind === "onboarding" ? p?.join_date : p?.resign_date;
  const { data, error } = await supabase.rpc("start_checklist", { p_user: uid, p_kind: kind, p_target: target || null });
  if (error) return toast(error.message, "error");
  openId = data;
  toast("Checklist dibuat", "success");
  await reload();
}

function openStart() {
  const box = root.querySelector("#ob-modal-box");
  box.innerHTML = `
    <h3>Mulai Checklist</h3>
    <form id="ob-form">
      <div class="form-row"><label>Jenis
        <select name="kind"><option value="onboarding">Onboarding (karyawan baru)</option><option value="offboarding">Offboarding (resign)</option></select></label></div>
      <div class="form-row"><label>Karyawan
        <select name="user_id" required>
          <option value="">Pilih karyawan…</option>
          ${people.map(p => `<option value="${p.id}">${esc(p.full_name)}${p.is_active ? "" : " (nonaktif)"}${p.department ? " — " + esc(p.department) : ""}</option>`).join("")}
        </select></label></div>
      <div class="form-row"><label><span id="ob-date-label">Tanggal masuk</span> <input type="date" name="target"></label></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="ob-cancel">Batal</button>
        <button type="submit" class="btn-primary">Buat Checklist</button>
      </div>
    </form>`;
  const f = box.querySelector("#ob-form");
  const sync = () => {
    const kind = f.kind.value, p = personOf(f.user_id.value);
    box.querySelector("#ob-date-label").textContent = kind === "onboarding" ? "Tanggal masuk" : "Tanggal resign";
    f.target.value = (kind === "onboarding" ? p?.join_date : p?.resign_date) || "";
  };
  f.kind.addEventListener("change", sync);
  f.user_id.addEventListener("change", sync);
  box.querySelector("#ob-cancel").addEventListener("click", closeModal);
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    const { data, error } = await supabase.rpc("start_checklist", { p_user: f.user_id.value, p_kind: f.kind.value, p_target: f.target.value || null });
    btn.disabled = false;
    if (error) return toast(error.message, "error");
    toast("Checklist dibuat", "success");
    openId = data;
    await reload();
  });
  root.querySelector("#ob-modal").classList.remove("hidden");
}

function closeModal() { openId = null; root.querySelector("#ob-modal").classList.add("hidden"); }

async function openDetail(id, keepOpen) {
  const c = lists.find(x => x.id === id);
  if (!c) return closeModal();
  openId = id;
  const p = personOf(c.user_id);
  const { data: items, error } = await supabase.from("employee_checklist_items").select("*").eq("checklist_id", id).order("sort_order").order("title");
  if (error) return toast(error.message, "error");
  const n = counts[id] || { total: 0, done: 0 };
  const locked = c.status === "cancelled";
  const box = root.querySelector("#ob-modal-box");
  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
      <div><h3 style="margin:0">${esc(p?.full_name || "Karyawan")}</h3>
        <div class="muted small">${KIND_LABEL[c.kind]} • ${STATUS_LABEL[c.status]}${c.target_date ? " • " + fmtDate(c.target_date) : ""}</div></div>
      <button class="ob-x" id="ob-close" aria-label="Tutup">✕</button>
    </div>
    <div class="ob-bar"><i style="width:${n.total ? Math.round(n.done / n.total * 100) : 0}%"></i></div>
    <div class="muted small" style="margin:4px 0 8px">${n.done} dari ${n.total} tugas selesai</div>
    ${c.kind === "offboarding" ? `<div id="ob-final"><p class="muted small">Memuat bahan gaji terakhir…</p></div>` : ""}
    <div>${items.map(it => `
      <div class="ob-item ${it.is_done ? "done" : ""}" data-id="${it.id}">
        <input type="checkbox" ${it.is_done ? "checked" : ""} ${locked ? "disabled" : ""}>
        <div class="ob-body">
          <div class="ob-title">${esc(it.title)}${it.is_custom ? ` <span class="badge badge-muted">khusus</span>` : ""}</div>
          ${it.is_done && it.done_at ? `<div class="muted small">Selesai ${fmtDate(it.done_at)}</div>` : ""}
          <input class="ob-note" type="text" maxlength="500" placeholder="Catatan (opsional)" value="${esc(it.notes || "")}" ${locked ? "disabled" : ""}>
        </div>
        ${locked ? "" : `<button class="ob-x" title="Hapus tugas" aria-label="Hapus tugas">×</button>`}
      </div>`).join("") || `<p class="muted">Belum ada tugas.</p>`}</div>
    ${locked ? "" : `
    <form id="ob-add" style="display:flex; gap:8px; margin-top:12px;">
      <input name="title" maxlength="200" placeholder="Tambah tugas khusus untuk karyawan ini" style="flex:1" required>
      <button class="btn-secondary" type="submit">Tambah</button>
    </form>`}
    <div class="modal-actions" style="margin-top:16px">
      ${locked ? "" : `<button class="btn-secondary" id="ob-cancel-cl" style="color:var(--danger)">Batalkan Checklist</button>`}
      <button class="btn-primary" id="ob-close2">Tutup</button>
    </div>`;
  root.querySelector("#ob-modal").classList.remove("hidden");
  box.querySelector("#ob-close").addEventListener("click", closeModal);
  box.querySelector("#ob-close2").addEventListener("click", closeModal);

  box.querySelectorAll(".ob-item").forEach(row => {
    const iid = row.dataset.id;
    const cb = row.querySelector("input[type=checkbox]");
    const note = row.querySelector(".ob-note");
    cb.addEventListener("change", () => saveItem(iid, cb.checked, note.value, cb));
    note.addEventListener("change", () => saveItem(iid, cb.checked, note.value, null));
    row.querySelector("button.ob-x")?.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: "Hapus tugas?", message: `“${row.querySelector(".ob-title").textContent.trim()}” akan dihapus dari checklist ini.`, confirmLabel: "Hapus", confirmClass: "btn-danger" });
      if (!ok) return;
      const { error } = await supabase.rpc("remove_checklist_item", { p_item: iid });
      if (error) return toast(error.message, "error");
      await reload();
    });
  });
  box.querySelector("#ob-add")?.addEventListener("submit", async e => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    const { error } = await supabase.rpc("add_checklist_item", { p_checklist: id, p_title: title });
    if (error) return toast(error.message, "error");
    await reload();
  });
  box.querySelector("#ob-cancel-cl")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Batalkan checklist?", message: "Checklist ini ditandai dibatalkan dan tidak bisa diubah lagi. Anda tetap bisa memulai checklist baru untuk karyawan yang sama.", confirmLabel: "Batalkan Checklist", confirmClass: "btn-danger" });
    if (!ok) return;
    const { error } = await supabase.rpc("cancel_checklist", { p_checklist: id });
    if (error) return toast(error.message, "error");
    toast("Checklist dibatalkan", "success");
    await reload();
  });
  if (c.kind === "offboarding") loadFinalPay(c, p);
}

async function saveItem(itemId, done, notes, cb) {
  const { error } = await supabase.rpc("toggle_checklist_item", { p_item: itemId, p_done: done, p_notes: notes || "" });
  if (error) { toast(error.message, "error"); if (cb) cb.checked = !done; return; }
  await reload(); // segarkan progres & status (otomatis selesai kalau semua tercentang)
}

// Bahan perhitungan gaji terakhir. Hanya MENAMPILKAN data yang sudah ada; angka
// gaji sendiri dihitung di menu Slip Gaji. Bagian yang tidak bisa dibaca
// (mis. paket tanpa Kasbon) dilewati tanpa membuat panel gagal.
async function loadFinalPay(c, p) {
  const el = root.querySelector("#ob-final");
  if (!el) return;
  const end = c.target_date || p?.resign_date || dateOnlyISO(new Date());
  const ym = end.slice(0, 7), year = Number(end.slice(0, 4));
  const start = `${ym}-01`;
  const [att, ot, bal, inst] = await Promise.all([
    supabase.from("attendance").select("check_in, check_in_status").eq("user_id", c.user_id).gte("date", start).lte("date", end),
    supabase.from("overtime_requests").select("start_time, end_time, total_jam").eq("user_id", c.user_id).eq("status", "approved").gte("date", start).lte("date", end),
    supabase.from("leave_balances").select("kuota_hari, terpakai_hari").eq("user_id", c.user_id).eq("tahun", year).maybeSingle(),
    supabase.from("loan_installments").select("amount").eq("user_id", c.user_id).eq("status", "scheduled"),
  ]);
  if (!root.querySelector("#ob-final")) return;
  const hadir = (att.data || []).filter(a => a.check_in).length;
  const telat = (att.data || []).filter(a => a.check_in_status === "telat").length;
  const jam = (ot.data || []).reduce((s, o) => {
    if (o.total_jam != null) return s + Number(o.total_jam);
    const [h1, m1] = String(o.start_time).split(":").map(Number), [h2, m2] = String(o.end_time).split(":").map(Number);
    let m = (h2 * 60 + m2) - (h1 * 60 + m1); if (m < 0) m += 1440; return s + m / 60;
  }, 0);
  const sisaCuti = bal.data ? Math.max(0, Number(bal.data.kuota_hari) - Number(bal.data.terpakai_hari)) : null;
  const kasbon = inst.error ? null : (inst.data || []).reduce((s, r) => s + Number(r.amount), 0);
  const rp = n => "Rp " + Math.round(n).toLocaleString("id-ID");
  el.innerHTML = `
    <div class="muted small" style="margin-top:6px">Bahan gaji terakhir (1 ${ym.slice(5)}/${ym.slice(0, 4)} s/d ${fmtDate(end)})</div>
    <div class="ob-facts">
      <div class="ob-fact">Hari hadir<b>${hadir}</b></div>
      <div class="ob-fact">Terlambat<b>${telat}×</b></div>
      <div class="ob-fact">Lembur disetujui<b>${Math.round(jam * 10) / 10} jam</b></div>
      <div class="ob-fact">Sisa cuti ${year}<b>${sisaCuti == null ? "-" : sisaCuti + " hari"}</b></div>
      <div class="ob-fact">Sisa cicilan kasbon<b>${kasbon == null ? "-" : rp(kasbon)}</b></div>
    </div>
    <div class="muted small" style="margin-bottom:6px">Angka gaji dihitung di menu Slip Gaji. Penonaktifan akun dilakukan di Data Karyawan.
      <a href="#" id="ob-go-slip">Buka Slip Gaji</a> • <a href="#" id="ob-go-kar">Buka Data Karyawan</a></div>`;
  const go = (id, e) => { e.preventDefault(); closeModal(); document.querySelector(`.nav-item[data-target="${id}"]`)?.click(); };
  el.querySelector("#ob-go-slip")?.addEventListener("click", e => go("slip-gaji", e));
  el.querySelector("#ob-go-kar")?.addEventListener("click", e => go("karyawan", e));
}

// ---------------------------------------------------------------------
// TEMPLATE TUGAS — daftar tugas bawaan yang disalin ke checklist baru.
// Mengubah template tidak mengubah checklist yang sudah berjalan.
// ---------------------------------------------------------------------
async function paintTemplates() {
  root.querySelector("#ob-suggest").innerHTML = "";
  const main = root.querySelector("#ob-main");
  main.innerHTML = `<p class="muted">Memuat…</p>`;
  await supabase.rpc("ensure_checklist_templates"); // isi template bawaan kalau masih kosong
  const { data, error } = await supabase.from("checklist_templates").select("*").order("sort_order").order("created_at");
  if (error) { main.innerHTML = `<div class="card"><p class="muted">Gagal memuat: ${esc(error.message)}</p></div>`; return; }
  templates = data || [];
  main.innerHTML = ["onboarding", "offboarding"].map(kind => `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0">Template ${KIND_LABEL[kind]}</h3>
      ${templates.filter(t => t.kind === kind).map(t => `
        <div class="ob-item" data-id="${t.id}">
          <input type="checkbox" class="tp-active" ${t.is_active ? "checked" : ""} title="Dipakai di checklist baru">
          <div class="ob-body"><input class="ob-note tp-title" style="margin:0" maxlength="200" value="${esc(t.title)}"></div>
          <button class="ob-x tp-del" title="Hapus" aria-label="Hapus">×</button>
        </div>`).join("") || `<p class="muted">Belum ada tugas.</p>`}
      <form class="tp-add" data-kind="${kind}" style="display:flex; gap:8px; margin-top:10px;">
        <input name="title" maxlength="200" placeholder="Tambah tugas baru" style="flex:1" required>
        <button class="btn-secondary" type="submit">Tambah</button>
      </form>
    </div>`).join("") + `<p class="muted small">Centang = dipakai di checklist baru. Perubahan template tidak mengubah checklist yang sudah berjalan.</p>`;

  main.querySelectorAll(".ob-item").forEach(row => {
    const id = row.dataset.id;
    row.querySelector(".tp-active").addEventListener("change", async e => {
      const { error } = await supabase.from("checklist_templates").update({ is_active: e.target.checked }).eq("id", id);
      if (error) toast(error.message, "error");
    });
    row.querySelector(".tp-title").addEventListener("change", async e => {
      const title = e.target.value.trim();
      if (!title) { toast("Judul tugas tidak boleh kosong", "error"); return paintTemplates(); }
      const { error } = await supabase.from("checklist_templates").update({ title }).eq("id", id);
      if (error) toast(error.message, "error");
    });
    row.querySelector(".tp-del").addEventListener("click", async () => {
      const { error } = await supabase.from("checklist_templates").delete().eq("id", id);
      if (error) return toast(error.message, "error");
      paintTemplates();
    });
  });
  main.querySelectorAll(".tp-add").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    const kind = f.dataset.kind;
    const title = f.title.value.trim();
    if (!title) return;
    const max = Math.max(0, ...templates.filter(t => t.kind === kind).map(t => t.sort_order));
    const { error } = await supabase.from("checklist_templates").insert({ kind, title, sort_order: max + 1 });
    if (error) return toast(error.message, "error");
    paintTemplates();
  }));
}
