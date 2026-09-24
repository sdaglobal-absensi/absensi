import { supabase } from "../supabaseClient.js";
import { avatarHTML, toast, confirmDialog, getAllowedMenus, searchSelectHtml, wireSearchSelect, APPROVER_ROLES, STAFF_ROLES, isSuper, roleLabel } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// STRUKTUR ORGANISASI BERBASIS UNIT
//
//   Unit (org_units)  : pohon bebas kedalaman — Kantor Pusat > Cabang >
//                       Departemen > Bagian (atau bentuk lain).
//   Anggota           : org_unit_members. Satu orang boleh ada di banyak
//                       unit, tapi hanya SATU "unit utama" yang menentukan
//                       rantai approval pengajuannya.
//   Approver          : anggota unit yang role-nya Admin (Super Admin /
//                       Super Admin HR / Admin HR) dan menu approval-nya
//                       menyala. Kalau unit tidak punya Admin, pengajuan
//                       naik ke unit induk (aturan lengkap: supabase-org-
//                       approval.sql).
//
// Halaman ini read-only untuk yang punya menu "struktur-organisasi", dan
// jadi editor untuk yang juga diberi hak "struktur-kelola" (Pengaturan
// Sistem). Super Admin selalu bisa mengubah.
// =======================================================================

const TIPE_LABEL = { pusat: "Kantor Pusat", cabang: "Cabang", departemen: "Departemen", bagian: "Bagian", lainnya: "Lainnya" };
const REQ_LABEL = { izin: "Izin", sakit: "Sakit", cuti: "Cuti", lembur: "Lembur" };

const ICON_PUSAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V8l8-5 8 5v13"/><path d="M4 21h16"/><path d="M9 21v-6h6v6"/><path d="M9 11h.01M15 11h.01M9 15h.01M15 15h.01"/></svg>`;
const ICON_CABANG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-7.5-7-12a7 7 0 1114 0c0 4.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.3"/></svg>`;
const ICON_DEPT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
const ICON_BAGIAN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41L11 3.83A2 2 0 009.83 3H4a1 1 0 00-1 1v5.83a2 2 0 00.59 1.41l9.58 9.58a2 2 0 002.83 0l4.59-4.59a2 2 0 000-2.83z"/><circle cx="7.2" cy="7.2" r="1.4" fill="currentColor" stroke="none"/></svg>`;
const ICON_LAINNYA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;

// Tampilan (ikon & warna) mengikuti TIPE unit yang sebenarnya, bukan
// kedalamannya di pohon — supaya Kantor Pusat & Cabang (yang sama-sama ada
// di level teratas) tetap kelihatan beda, dan Departemen/Bagian tetap
// konsisten warnanya di kedalaman berapa pun ia diletakkan.
const TYPE_META = {
  pusat: { icon: ICON_PUSAT, cls: "pusat" },
  cabang: { icon: ICON_CABANG, cls: "cabang" },
  departemen: { icon: ICON_DEPT, cls: "departemen" },
  bagian: { icon: ICON_BAGIAN, cls: "bagian" },
  lainnya: { icon: ICON_LAINNYA, cls: "lainnya" },
};
const typeMeta = tipe => TYPE_META[tipe] || TYPE_META.lainnya;

// State halaman (dibuat baru tiap render()).
let S;

export async function render(container, user) {
  const allowed = await getAllowedMenus(user); // null = super_admin
  // Elemen pembungkus baru tiap render, supaya event handler tidak "bocor"
  // ke halaman lain yang nanti memakai container #content yang sama.
  container.innerHTML = `<div id="org-root"><p class="muted">Memuat…</p></div>`;
  const root = container.querySelector("#org-root");

  S = {
    root, user,
    canManage: allowed === null || allowed.has("struktur-kelola"),
    units: [], members: [], profiles: [], settings: {},
    childMap: {}, unitMap: {}, membersByUnit: {}, profileMap: {},
    openIds: null, // Set id unit yang terbuka; null = belum diinisialisasi
    q: "",
  };

  root.addEventListener("click", onClick);
  root.addEventListener("toggle", onToggle, true);
  await reload();
}

async function reload() {
  const [u, m, p, s] = await Promise.all([
    supabase.from("org_units").select("*").order("sort_order").order("nama"),
    supabase.from("org_unit_members").select("*"),
    supabase.from("profiles").select("id, employee_code, full_name, role, position, photo_url").eq("is_active", true).order("full_name"),
    supabase.from("approval_settings").select("*"),
  ]);
  const err = u.error || m.error || p.error;
  if (err) {
    S.root.innerHTML = `<p class="muted">Gagal memuat data: ${esc(err.message)}. Pastikan file <code>supabase-org-approval.sql</code> sudah dijalankan di Supabase.</p>`;
    return;
  }
  S.units = u.data || [];
  S.members = m.data || [];
  S.profiles = p.data || [];
  S.settings = Object.fromEntries((s.data || []).map(r => [r.request_type, r.levels]));
  index();
  renderPage();
}

function index() {
  S.unitMap = Object.fromEntries(S.units.map(x => [x.id, x]));
  S.profileMap = Object.fromEntries(S.profiles.map(x => [x.id, x]));
  S.childMap = {};
  for (const x of S.units) (S.childMap[x.parent_id || "root"] ??= []).push(x);
  S.membersByUnit = {};
  for (const m of S.members) if (S.profileMap[m.user_id]) (S.membersByUnit[m.unit_id] ??= []).push(m);
  if (!S.openIds) {
    // Pertama kali: buka dua tingkat teratas.
    S.openIds = new Set(S.units.filter(x => depthOf(x.id) < 2).map(x => x.id));
  }
}

const children = id => S.childMap[id || "root"] || [];
const membersOf = id => (S.membersByUnit[id] || []).slice().sort((a, b) => S.profileMap[a.user_id].full_name.localeCompare(S.profileMap[b.user_id].full_name));

function depthOf(id) { let d = 0, cur = S.unitMap[id]; while (cur && cur.parent_id) { d++; cur = S.unitMap[cur.parent_id]; } return d; }
function unitPath(id) { const out = []; let cur = S.unitMap[id]; while (cur) { out.unshift(cur.nama); cur = S.unitMap[cur.parent_id]; } return out.join(" › "); }
function descendantIds(id) { const out = new Set(); const walk = x => children(x).forEach(c => { out.add(c.id); walk(c.id); }); walk(id); return out; }
function ancestorIds(id) { const out = new Set(); let cur = S.unitMap[id]; while (cur && cur.parent_id) { out.add(cur.parent_id); cur = S.unitMap[cur.parent_id]; } return out; }

const isAdminRole = role => APPROVER_ROLES.includes(role);

function roleBadge(role) {
  return ({
    super_admin: `<span class="badge badge-danger">Super Admin</span>`,
    super_admin_hr: `<span class="badge badge-warn">Super Admin HR</span>`,
    admin_hr: `<span class="badge badge-ok">Admin HR</span>`,
    admin_approval: `<span class="badge badge-ok">Admin</span>`,
    karyawan: `<span class="badge">Karyawan</span>`,
  })[role] || "";
}

// Ubah Role langsung dari pohon (tanpa buka Data Karyawan). Data Karyawan tidak
// lagi mengatur role -- akun baru selalu Karyawan, dan role diubah di sini.
// Pilihan role menyesuaikan kewenangan yang login (server menegakkan aturan
// yang sama di fungsi set_member_role):
//   Super Admin           : semua role
//   Super Admin HR/Admin HR: Karyawan, Admin, Admin HR, Super Admin HR
//   lainnya (hak kelola)  : Karyawan <-> Admin saja
const ROLE_INFO = {
  karyawan: "Karyawan biasa: hanya menu pribadi (sesuai Pengaturan Sistem). Bukan approver.",
  admin_approval: "Admin: bisa menyetujui pengajuan di unitnya. Menu lain diatur di Pengaturan Sistem.",
  admin_hr: "Admin HR: staf HR, menu diatur di Pengaturan Sistem. Dihitung sebagai approver.",
  super_admin_hr: "Super Admin HR: staf HR senior, menu diatur di Pengaturan Sistem. Dihitung sebagai approver.",
  super_admin: "Super Admin: akses penuh ke seluruh aplikasi, tidak bisa dibatasi toggle apa pun.",
};

function assignableRoles() {
  if (isSuper(S.user.role)) return ["karyawan", "admin_approval", "admin_hr", "super_admin_hr", "super_admin"];
  if (STAFF_ROLES.includes(S.user.role)) return ["karyawan", "admin_approval", "admin_hr", "super_admin_hr"];
  return ["karyawan", "admin_approval"];
}

function roleBtn(p) {
  if (!S.canManage || p.id === S.user.id) return "";
  // Role target harus termasuk yang boleh diatur oleh yang login.
  if (!assignableRoles().includes(p.role)) return "";
  return `<button class="org-mini-btn" data-act="change-role" data-user="${p.id}">Ubah Role</button>`;
}

function openRoleModal(userId) {
  const p = S.profileMap[userId];
  const options = assignableRoles();
  const { close, $ } = openModal(`Ubah role ${esc(p.full_name)}`, `
    <form id="role-form">
      <div class="form-row"><label>Role
        <select name="role">${options.map(r => `<option value="${r}" ${r === p.role ? "selected" : ""}>${esc(roleLabel(r))}</option>`).join("")}</select>
      </label>
      <span id="role-info" class="small muted"></span></div>
      <p class="small muted">Berlaku untuk pengajuan baru. Yang bersangkutan perlu memuat ulang halaman atau login ulang untuk melihat perubahan menunya.</p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
        <button type="submit" class="btn-primary">Simpan</button>
      </div>
    </form>`);
  const sel = $("select[name=role]");
  const info = $("#role-info");
  const draw = () => { info.textContent = ROLE_INFO[sel.value] || ""; };
  sel.addEventListener("change", draw);
  draw();

  $("#role-form").addEventListener("submit", async e => {
    e.preventDefault();
    const newRole = sel.value;
    if (newRole === p.role) { close(); return; }
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    const { error } = await supabase.rpc("set_member_role", { p_user: userId, p_role: newRole });
    if (error) { btn.disabled = false; return fail(error, "Gagal mengubah role"); }
    toast(`${p.full_name} sekarang ${roleLabel(newRole)}`, "success");
    close();
    await reload();
  });
}

// -----------------------------------------------------------------------
function renderPage() {
  const primaryUsers = new Set(S.members.filter(m => m.is_primary).map(m => m.user_id));
  const unplaced = S.profiles.filter(p => !primaryUsers.has(p.id));
  const roots = children(null);

  S.root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Struktur Organisasi</h1>
        <p class="muted">Susunan unit (kantor pusat, cabang, departemen) beserta anggotanya. Struktur ini jadi acuan <strong>approval izin &amp; lembur</strong>: pengajuan diteruskan ke Admin di unit utama karyawan, lalu naik ke unit induknya bila unit itu tidak punya Admin.</p>
      </div>
      ${S.canManage ? `<div class="org-toolbar no-print">
        <button class="btn-primary" data-act="add-unit" data-id="">+ Unit Puncak</button>
        ${S.units.length ? "" : `<button class="btn-secondary" data-act="import-legacy">Impor dari Data Lama</button>`}
      </div>` : ""}
    </div>

    <div class="status-grid">
      <div class="status-card"><span class="status-label">Kantor &amp; Cabang</span><span class="status-value">${S.units.filter(u => u.tipe === "pusat" || u.tipe === "cabang").length}</span></div>
      <div class="status-card done"><span class="status-label">Karyawan Aktif</span><span class="status-value">${S.profiles.length}</span></div>
      <div class="status-card ${unplaced.length ? "" : "done"}"><span class="status-label">Belum Punya Unit Utama</span><span class="status-value">${unplaced.length}</span></div>
    </div>

    ${S.canManage ? levelsCardHTML() : ""}

    <div class="filter-row no-print" style="margin:16px 0;">
      <div class="org-search-wrap">
        ${ICON_SEARCH}
        <input type="text" id="org-search" placeholder="Cari nama karyawan, kode, atau unit…">
      </div>
    </div>

    ${legendHTML()}

    <div id="org-tree" class="org-tree">
      ${roots.length ? roots.map(u => nodeHTML(u, 0)).join("") : `<div class="card"><p class="muted">Belum ada unit. ${S.canManage ? "Klik <strong>+ Unit Puncak</strong> untuk memulai (misalnya “Kantor Pusat”), atau <strong>Impor dari Data Lama</strong> untuk membentuknya otomatis dari data Cabang/Departemen/Bagian yang sudah ada." : "Hubungi Super Admin untuk menyusun strukturnya."}</p></div>`}
    </div>

    ${unplaced.length ? `
      <h2 class="section-title">Belum Punya Unit Utama (${unplaced.length})</h2>
      <p class="muted small" style="margin:-6px 0 12px;">Pengajuan izin/lembur mereka sementara diteruskan ke Super Admin dan Admin yang berhak approve (tanpa jenjang), sampai ditempatkan di sebuah unit.</p>
      <div class="org-emp-list org-unplaced">
        ${unplaced.map(p => `
          <div class="org-emp-row" data-search="${esc((p.full_name + " " + (p.employee_code || "")).toLowerCase())}">
            <span class="org-avatar org-avatar-${p.role}">${avatarHTML(p, p.full_name)}</span>
            <span class="org-emp-info">
              <span class="org-emp-name">${esc(p.full_name)}</span>
              <span class="org-emp-meta">${esc(p.position || "Jabatan belum diatur")}${p.employee_code ? ` · ${esc(p.employee_code)}` : ""}</span>
            </span>
            ${roleBadge(p.role)}
            ${roleBtn(p)}
            ${S.canManage && S.units.length ? `<button class="org-mini-btn" data-act="place" data-user="${p.id}">Tempatkan</button>` : ""}
          </div>`).join("")}
      </div>` : ""}
  `;

  const search = document.getElementById("org-search");
  search.addEventListener("input", e => applyFilter(e.target.value));
  if (S.q) { search.value = S.q; applyFilter(S.q); }
}

// Legenda warna: cuma tipe yang benar-benar dipakai di struktur yang ditampilkan,
// urut sesuai urutan hirarki wajar (Pusat > Cabang > Departemen > Bagian > Lainnya).
function legendHTML() {
  const order = ["pusat", "cabang", "departemen", "bagian", "lainnya"];
  const used = new Set(S.units.map(u => u.tipe));
  const items = order.filter(t => used.has(t));
  if (!items.length) return "";
  return `<div class="org-legend no-print">
    ${items.map(t => `<span class="org-legend-item"><span class="org-legend-dot org-legend-${t}"></span>${TIPE_LABEL[t] || t}</span>`).join("")}
  </div>`;
}

function levelsCardHTML() {
  return `
    <div class="card org-levels-card">
      <h3>Jumlah Tingkat Approval</h3>
      <p class="muted small">Berapa Admin berbeda yang harus menyetujui, dihitung naik dari unit karyawan. Unit yang tidak punya Admin dilewati. Kalau jenjang yang tersedia lebih sedikit dari angka ini, dipakai yang ada. Berlaku untuk pengajuan baru.</p>
      <div class="org-levels-grid">
        ${["izin", "sakit", "cuti", "lembur"].map(k => `
          <label>${REQ_LABEL[k]}
            <input type="number" min="1" max="5" step="1" data-level="${k}" value="${S.settings[k] ?? 1}">
          </label>`).join("")}
        <button class="btn-primary" data-act="save-levels">Simpan</button>
      </div>
    </div>`;
}

function nodeHTML(u, depth) {
  const mem = membersOf(u.id);
  const kids = children(u.id);
  const admins = mem.map(m => S.profileMap[m.user_id]).filter(p => isAdminRole(p.role));
  // Ukuran/kepadatan node mengikuti kedalamannya di pohon (makin dalam makin ringkas)...
  const sizeCls = depth === 0 ? "org-node-cabang" : depth === 1 ? "org-node-dept" : "org-node-bagian";
  // ...tapi ikon, warna, dan label selalu mengikuti TIPE unit yang sebenarnya,
  // supaya mis. Kantor Pusat vs Cabang di level teratas tetap beda tampilan.
  const meta = typeMeta(u.tipe);
  const icon = `<span class="org-icon org-icon-${meta.cls}">${meta.icon}</span>`;

  return `
    <details class="org-node ${sizeCls}" data-unit="${u.id}" data-tipe="${meta.cls}" data-name="${esc(u.nama.toLowerCase())}" ${S.openIds.has(u.id) ? "open" : ""}>
      <summary>
        <span class="org-summary-left">
          <span class="org-chevron">${ICON_CHEVRON}</span>
          ${icon}
          <span class="org-node-title">${esc(u.nama)}</span>
          <span class="org-tag org-tag-${meta.cls}">${TIPE_LABEL[u.tipe] || u.tipe}</span>
        </span>
        <span class="org-summary-right">
          <span class="org-pill">${mem.length} anggota</span>
          ${S.canManage ? `
            <span class="org-actions no-print">
              <button class="org-mini-btn" data-act="add-member" data-id="${u.id}">+ Anggota</button>
              <button class="org-mini-btn" data-act="add-unit" data-id="${u.id}">+ Sub-unit</button>
              <button class="org-mini-btn" data-act="edit-unit" data-id="${u.id}">Ubah</button>
              <button class="org-mini-btn" data-act="copy-unit" data-id="${u.id}">Salin Struktur</button>
              <button class="org-mini-btn org-mini-danger" data-act="del-unit" data-id="${u.id}">Hapus</button>
            </span>` : ""}
        </span>
      </summary>
      <div class="org-approver-line ${admins.length ? "" : "org-approver-none"}">
        ${admins.length
          ? `Admin di unit ini: <strong>${admins.map(a => esc(a.full_name)).join(", ")}</strong>`
          : `Tidak ada Admin di unit ini — pengajuan naik ke ${u.parent_id ? "unit induk" : "Super Admin"}.`}
      </div>
      ${mem.length ? `<div class="org-emp-list">${mem.map(m => memberRowHTML(m, u)).join("")}</div>` : ""}
      ${kids.length ? `<div class="org-children">${kids.map(k => nodeHTML(k, depth + 1)).join("")}</div>` : ""}
    </details>`;
}

function memberRowHTML(m, u) {
  const p = S.profileMap[m.user_id];
  const otherUnits = S.members.filter(x => x.user_id === p.id && x.unit_id !== u.id).length;
  return `
    <div class="org-emp-row" data-search="${esc((p.full_name + " " + (p.employee_code || "")).toLowerCase())}">
      <span class="org-avatar org-avatar-${p.role}">${avatarHTML(p, p.full_name)}</span>
      <span class="org-emp-info">
        <span class="org-emp-name">${esc(p.full_name)}</span>
        <span class="org-emp-meta">${esc(p.position || "Jabatan belum diatur")}${p.employee_code ? ` · ${esc(p.employee_code)}` : ""}${otherUnits ? ` · juga di ${otherUnits} unit lain` : ""}</span>
      </span>
      ${m.is_primary ? `<span class="badge badge-ok" title="Unit ini menentukan rantai approval karyawan">Unit Utama</span>` : ""}
      ${roleBadge(p.role)}
      ${S.canManage ? `
        <span class="org-actions no-print">
          ${roleBtn(p)}
          ${m.is_primary ? "" : `<button class="org-mini-btn" data-act="set-primary" data-user="${p.id}" data-unit="${u.id}">Jadikan Utama</button>`}
          <button class="org-mini-btn org-mini-danger" data-act="rm-member" data-id="${m.id}">Keluarkan</button>
        </span>` : ""}
    </div>`;
}

// -----------------------------------------------------------------------
// Pencarian client-side: cocokkan nama/kode karyawan ATAU nama unit.
function applyFilter(query) {
  S.q = query;
  const q = query.trim().toLowerCase();
  const rows = document.querySelectorAll("#org-root .org-emp-row");
  const nodes = [...document.querySelectorAll("#org-tree .org-node")];
  rows.forEach(r => r.classList.remove("org-hidden"));
  nodes.forEach(n => n.classList.remove("org-hidden"));
  if (!q) return;

  // Baris cocok bila teksnya cocok, atau nama unit tempat ia berada cocok.
  rows.forEach(r => {
    const unitNode = r.closest(".org-node");
    const hit = r.dataset.search.includes(q) || (unitNode && unitNode.dataset.name.includes(q));
    r.classList.toggle("org-hidden", !hit);
  });
  // Dari node terdalam ke luar: tampilkan node bila ada isi yang cocok.
  nodes.reverse().forEach(n => {
    const childVisible = !!n.querySelector(":scope > .org-children > .org-node:not(.org-hidden)");
    const rowVisible = !!n.querySelector(":scope > .org-emp-list > .org-emp-row:not(.org-hidden)");
    const show = childVisible || rowVisible || n.dataset.name.includes(q);
    n.classList.toggle("org-hidden", !show);
    if (show) n.open = true;
  });
}

function onToggle(e) {
  const d = e.target;
  if (!d || !d.dataset || !d.dataset.unit) return;
  if (d.open) S.openIds.add(d.dataset.unit); else S.openIds.delete(d.dataset.unit);
}

// -----------------------------------------------------------------------
// Klik (delegasi) — semua aksi lewat atribut data-act.
async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !S.canManage) return;
  e.preventDefault();
  e.stopPropagation(); // tombol di dalam <summary> jangan ikut membuka/menutup node
  const { act, id, user, unit } = btn.dataset;
  try {
    if (act === "add-unit") return openUnitModal({ parentId: id || null });
    if (act === "edit-unit") return openUnitModal({ editId: id });
    if (act === "del-unit") return await deleteUnit(id);
    if (act === "add-member") return openPlaceModal({ unitId: id });
    if (act === "place") return openPlaceModal({ userId: user });
    if (act === "change-role") return openRoleModal(user);
    if (act === "set-primary") return await setPrimary(user, unit);
    if (act === "rm-member") return await removeMember(id);
    if (act === "copy-unit") return openCopyModal(id);
    if (act === "import-legacy") return await openImportModal();
    if (act === "save-levels") return await saveLevels();
  } catch (err) {
    console.error(err);
    toast("Terjadi kesalahan: " + err.message, "error");
  }
}

// -----------------------------------------------------------------------
function openModal(title, bodyHtml) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-box">${`<h3>${title}</h3>`}${bodyHtml}</div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("mousedown", e => { if (e.target === modal) close(); });
  modal.querySelectorAll("[data-x='cancel']").forEach(b => b.addEventListener("click", close));
  return { modal, close, $: sel => modal.querySelector(sel) };
}

function unitOptionsHTML(list, selected = "") {
  return list
    .slice()
    .sort((a, b) => unitPath(a.id).localeCompare(unitPath(b.id)))
    .map(u => `<option value="${u.id}" ${u.id === selected ? "selected" : ""}>${esc(unitPath(u.id))}</option>`).join("");
}

function fail(error, prefix = "Gagal menyimpan") {
  toast(`${prefix}: ${error.message}`, "error");
}

// --- Tambah / ubah unit --------------------------------------------------
function openUnitModal({ parentId = null, editId = null }) {
  const editing = editId ? S.unitMap[editId] : null;
  const parent = editing ? editing.parent_id : parentId;
  const parentTipe = parent ? S.unitMap[parent]?.tipe : null;
  const defaultTipe = editing ? editing.tipe : (!parent ? "pusat" : parentTipe === "pusat" ? "cabang" : "departemen");
  const blocked = editing ? new Set([editing.id, ...descendantIds(editing.id)]) : new Set();
  const title = editing ? "Ubah Unit" : (parent ? `Sub-unit baru di “${esc(S.unitMap[parent].nama)}”` : "Unit puncak baru");

  const { close, $ } = openModal(title, `
    <form id="unit-form">
      <div class="form-row"><label>Nama Unit <input name="nama" required maxlength="80" placeholder="mis. Kantor Pusat, Cabang Surabaya, Departemen HRD" value="${esc(editing?.nama || "")}"></label></div>
      <div class="form-row"><label>Jenis
        <select name="tipe">${Object.entries(TIPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === defaultTipe ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label></div>
      ${editing ? `<div class="form-row"><label>Unit Induk
        <select name="parent_id"><option value="">— Puncak (tanpa induk) —</option>${unitOptionsHTML(S.units.filter(u => !blocked.has(u.id)), editing.parent_id || "")}</select>
      </label></div>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
        <button type="submit" class="btn-primary">Simpan</button>
      </div>
    </form>`);

  $("#unit-form").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nama = fd.get("nama").trim();
    if (!nama) return;
    let error;
    if (editing) {
      ({ error } = await supabase.from("org_units").update({ nama, tipe: fd.get("tipe"), parent_id: fd.get("parent_id") || null }).eq("id", editing.id));
    } else {
      ({ error } = await supabase.from("org_units").insert({ nama, tipe: fd.get("tipe"), parent_id: parent }));
      if (!error && parent) S.openIds.add(parent); // buka induknya supaya unit baru langsung kelihatan
    }
    if (error) return fail(error);
    toast(editing ? "Unit diperbarui" : "Unit ditambahkan", "success");
    close();
    await reload();
  });
}

async function deleteUnit(id) {
  const u = S.unitMap[id];
  if (children(id).length) { toast("Unit ini masih punya sub-unit. Hapus atau pindahkan sub-unitnya dulu.", "error"); return; }
  const n = membersOf(id).length;
  const ok = await confirmDialog({
    title: `Hapus unit “${u.nama}”?`,
    message: n ? `${n} anggota akan dikeluarkan dari unit ini (akun karyawannya tetap ada). Yang unit utamanya di sini akan jadi “Belum Punya Unit Utama”.` : "Unit ini kosong dan akan dihapus.",
    confirmLabel: "Ya, Hapus", confirmClass: "btn-secondary",
  });
  if (!ok) return;
  const { error } = await supabase.from("org_units").delete().eq("id", id);
  if (error) return fail(error, "Gagal menghapus");
  toast("Unit dihapus", "success");
  await reload();
}

// --- Tempatkan anggota ---------------------------------------------------
// unitId terisi -> pilih orangnya; userId terisi -> pilih unitnya.
function openPlaceModal({ unitId = null, userId = null }) {
  const fixedUser = userId ? S.profileMap[userId] : null;
  const fixedUnit = unitId ? S.unitMap[unitId] : null;
  const already = unitId ? new Set((S.membersByUnit[unitId] || []).map(m => m.user_id)) : new Set();
  const candidates = S.profiles.filter(p => !already.has(p.id));

  const { close, $ } = openModal(fixedUnit ? `Tambah anggota ke “${esc(fixedUnit.nama)}”` : `Tempatkan ${esc(fixedUser.full_name)}`, `
    <form id="place-form">
      ${fixedUser
        ? `<div class="form-row"><label>Karyawan <input value="${esc(fixedUser.full_name)}" disabled></label></div>`
        : searchSelectHtml({ id: "ss-member", label: "Karyawan", placeholder: "Ketik nama atau kode karyawan…", required: true })}
      ${fixedUnit
        ? ""
        : `<div class="form-row"><label>Unit <select name="unit" required>${unitOptionsHTML(S.units)}</select></label></div>`}
      <div class="form-row"><label class="check-row"><input type="checkbox" id="place-primary"> Jadikan <strong>unit utama</strong> (menentukan rantai approval)</label>
        <span class="small muted">Satu karyawan hanya punya satu unit utama; unit lain hanya keanggotaan tambahan.</span></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
        <button type="submit" class="btn-primary">Simpan</button>
      </div>
    </form>`);

  const primaryUsers = new Set(S.members.filter(m => m.is_primary).map(m => m.user_id));
  const primaryEl = $("#place-primary");
  let ss = null;
  if (fixedUser) primaryEl.checked = !primaryUsers.has(fixedUser.id);
  else ss = wireSearchSelect("ss-member", candidates, {
    getLabel: p => `${p.full_name}${p.employee_code ? ` (${p.employee_code})` : ""}`,
    getValue: p => p.id,
    onSelect: p => { primaryEl.checked = !primaryUsers.has(p.id); },
  });

  $("#place-form").addEventListener("submit", async e => {
    e.preventDefault();
    const uid = fixedUser ? fixedUser.id : ss.value;
    const targetUnit = fixedUnit ? fixedUnit.id : new FormData(e.target).get("unit");
    if (!uid) { toast("Pilih karyawan dari daftar dulu", "error"); return; }
    let error;
    if (primaryEl.checked) {
      ({ error } = await supabase.rpc("set_primary_unit", { p_user: uid, p_unit: targetUnit }));
    } else {
      ({ error } = await supabase.from("org_unit_members").upsert(
        { unit_id: targetUnit, user_id: uid, is_primary: false },
        { onConflict: "unit_id,user_id", ignoreDuplicates: true }
      ));
    }
    if (error) return fail(error);
    S.openIds.add(targetUnit);
    toast("Anggota ditempatkan", "success");
    close();
    await reload();
  });
}

async function setPrimary(userId, unitId) {
  const { error } = await supabase.rpc("set_primary_unit", { p_user: userId, p_unit: unitId });
  if (error) return fail(error);
  toast("Unit utama diperbarui", "success");
  await reload();
}

async function removeMember(memberId) {
  const m = S.members.find(x => x.id === memberId);
  const p = S.profileMap[m.user_id];
  const ok = await confirmDialog({
    title: `Keluarkan ${p.full_name} dari “${S.unitMap[m.unit_id].nama}”?`,
    message: m.is_primary ? "Ini unit utamanya — setelah dikeluarkan, pengajuannya diteruskan ke Super Admin sampai ditempatkan di unit utama baru." : "Akun karyawan tetap ada; hanya keanggotaan di unit ini yang dilepas.",
    confirmLabel: "Ya, Keluarkan", confirmClass: "btn-secondary",
  });
  if (!ok) return;
  const { error } = await supabase.from("org_unit_members").delete().eq("id", memberId);
  if (error) return fail(error, "Gagal mengeluarkan");
  toast("Anggota dikeluarkan", "success");
  await reload();
}

// --- Salin struktur (mis. cabang baru meniru kantor pusat) ---------------
function openCopyModal(targetId) {
  const target = S.unitMap[targetId];
  // Sub-unit yang boleh disalin: yang TIDAK mengandung tujuan (yaitu bukan target
  // itu sendiri dan bukan leluhurnya) — kalau tidak, salinan akan menyalin dirinya.
  // Unit sumbernya sendiri boleh leluhur target (mis. cabang baru meniru Kantor Pusat).
  const bad = new Set([targetId, ...ancestorIds(targetId)]);
  const copyable = id => children(id).filter(k => !bad.has(k.id));
  const sources = S.units.filter(u => u.id !== targetId && copyable(u.id).length);
  if (!sources.length) { toast("Belum ada unit lain yang punya sub-unit untuk disalin.", "error"); return; }

  const { close, $ } = openModal(`Salin struktur ke “${esc(target.nama)}”`, `
    <p class="muted small">Menyalin sub-unit (beserta turunannya) dari unit lain ke dalam “${esc(target.nama)}”. Hanya <strong>susunan unit</strong> yang disalin — anggota tidak ikut.</p>
    <form id="copy-form">
      <div class="form-row"><label>Salin dari <select id="copy-src">${unitOptionsHTML(sources)}</select></label></div>
      <div id="copy-kids" class="org-copy-kids"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
        <button type="submit" class="btn-primary">Salin</button>
      </div>
    </form>`);

  const kidsEl = $("#copy-kids");
  const drawKids = () => {
    const src = $("#copy-src").value;
    kidsEl.innerHTML = `<div class="small muted" style="margin-bottom:6px;">Pilih sub-unit yang disalin (cabang tidak dicentang otomatis):</div>` +
      copyable(src).map(k => `<label class="check-row"><input type="checkbox" value="${k.id}" ${k.tipe === "cabang" ? "" : "checked"}> ${esc(k.nama)} <span class="org-tag">${TIPE_LABEL[k.tipe] || k.tipe}</span></label>`).join("");
  };
  $("#copy-src").addEventListener("change", drawKids);
  drawKids();

  $("#copy-form").addEventListener("submit", async e => {
    e.preventDefault();
    const picked = [...kidsEl.querySelectorAll("input:checked")].map(i => i.value);
    if (!picked.length) { toast("Pilih minimal satu sub-unit", "error"); return; }
    try {
      let total = 0;
      for (const id of picked) total += await cloneSubtree(id, targetId);
      S.openIds.add(targetId);
      toast(`${total} unit disalin`, "success");
      close();
      await reload();
    } catch (err) { fail(err, "Gagal menyalin"); }
  });
}

async function cloneSubtree(srcId, newParentId) {
  const src = S.unitMap[srcId];
  const { data, error } = await supabase.from("org_units")
    .insert({ parent_id: newParentId, nama: src.nama, tipe: src.tipe, sort_order: src.sort_order })
    .select("id").single();
  if (error) throw error;
  let n = 1;
  for (const k of children(srcId)) n += await cloneSubtree(k.id, data.id);
  return n;
}

// --- Impor dari data lama (Cabang > Departemen > Bagian di profiles) -----
async function openImportModal() {
  const { data: locs } = await supabase.from("office_locations").select("name").eq("is_active", true);
  const cabang = new Set((locs || []).map(l => l.name));
  const { close, $ } = openModal("Impor dari Data Lama", `
    <p class="muted small">Membentuk struktur otomatis dari data yang sudah ada: <strong>Lokasi Kantor (cabang) → Departemen → Bagian</strong>, lalu menempatkan tiap karyawan aktif di unit terdalamnya sebagai unit utama. Setelah itu kamu bebas mengubah, memindah, dan menambah unit.</p>
    <form id="imp-form">
      <div class="form-row"><label>Nama unit puncak <input name="root" required value="Kantor Pusat" maxlength="80"></label></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
        <button type="submit" class="btn-primary">Impor</button>
      </div>
    </form>`);

  $("#imp-form").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Mengimpor…";
    try {
      const { data: profs, error: pe } = await supabase.from("profiles").select("id, department, bagian, lokasi_kerja").eq("is_active", true);
      if (pe) throw pe;
      const rootName = new FormData(e.target).get("root").trim();
      const cache = {};
      const ensure = async (parentId, nama, tipe) => {
        const key = `${parentId}|${nama}`;
        if (cache[key]) return cache[key];
        const { data, error } = await supabase.from("org_units").insert({ parent_id: parentId, nama, tipe }).select("id").single();
        if (error) throw error;
        return (cache[key] = data.id);
      };
      const rootId = await ensure(null, rootName, "pusat");
      const rows = [];
      for (const p of profs) {
        let parent = rootId;
        if (p.lokasi_kerja && cabang.has(p.lokasi_kerja)) parent = await ensure(parent, p.lokasi_kerja, "cabang");
        if (p.department) parent = await ensure(parent, p.department, "departemen");
        if (p.bagian) parent = await ensure(parent, p.bagian, "bagian");
        rows.push({ unit_id: parent, user_id: p.id, is_primary: true });
      }
      if (rows.length) {
        const { error } = await supabase.from("org_unit_members").insert(rows);
        if (error) throw error;
      }
      toast(`Struktur dibentuk: ${Object.keys(cache).length} unit, ${rows.length} karyawan ditempatkan`, "success");
      close();
      S.openIds = null;
      await reload();
    } catch (err) {
      fail(err, "Gagal mengimpor");
      btn.disabled = false; btn.textContent = "Impor";
    }
  });
}

// --- Jumlah tingkat approval ---------------------------------------------
async function saveLevels() {
  const rows = [...S.root.querySelectorAll("[data-level]")].map(i => ({
    request_type: i.dataset.level,
    levels: Math.min(5, Math.max(1, parseInt(i.value, 10) || 1)),
    updated_by: S.user.id,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("approval_settings").upsert(rows, { onConflict: "request_type" });
  if (error) return fail(error);
  rows.forEach(r => (S.settings[r.request_type] = r.levels));
  toast("Jumlah tingkat approval disimpan (berlaku untuk pengajuan baru)", "success");
}
