import { supabase } from "../supabaseClient.js";
import { avatarHTML } from "../core.js";

// =======================================================================
// STRUKTUR ORGANISASI — halaman baca-saja (tidak ada tombol edit di sini;
// semua editnya tetap lewat "Data Karyawan", "Master Departemen", dan
// "Master Lokasi Kantor" seperti biasa). Halaman ini cuma MENYUSUN ULANG
// data yang sudah ada di 3 sumber itu jadi satu pohon bertingkat:
//   Cabang (office_locations, dicocokkan ke profiles.lokasi_kerja by nama)
//     -> Departemen (profiles.department)
//       -> Bagian (profiles.bagian)
//         -> daftar Karyawan aktif (profiles.position sebagai jabatannya)
// Karyawan yang lokasi/departemen/bagian-nya belum diisi (atau lokasi_kerja
// tidak cocok nama cabang manapun yang masih aktif) tetap ditampilkan, tapi
// dikumpulkan di bucket "Belum Diatur" di level masing-masing supaya tidak
// hilang dari hitungan -- HR jadi tahu siapa saja yang datanya perlu
// dilengkapi di menu Data Karyawan.
// =======================================================================

const NO_LOKASI = "__no_lokasi__";
const NO_DEPT = "__no_dept__";
const NO_BAGIAN = "__no_bagian__";

// Ikon SVG (stroke, gaya sama dengan ikon sidebar di core.js) — dipakai
// langsung di sini (bukan emoji) supaya tampilannya konsisten & rapi di
// semua perangkat/OS.
const ICON_CABANG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-7.5-7-12a7 7 0 1114 0c0 4.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.3"/></svg>`;
const ICON_DEPT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;

let tree = null; // hasil buildTree(), disimpan supaya search tidak perlu query ulang
let stats = { totalKaryawan: 0, totalCabang: 0, totalDept: 0, totalBagian: 0 };

export async function render(container, user) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Struktur Organisasi</h1>
        <p class="muted">Disusun otomatis dari data Karyawan, Departemen/Bagian, dan Lokasi Kantor (Cabang) yang aktif. Untuk mengubah isinya, edit lewat menu Data Karyawan / Master Departemen / Master Lokasi Kantor.</p>
      </div>
    </div>

    <div id="org-summary" class="status-grid"><p class="muted">Memuat…</p></div>

    <div class="filter-row no-print" style="margin-bottom:16px;">
      <div class="org-search-wrap">
        ${ICON_SEARCH}
        <input type="text" id="org-search" placeholder="Cari nama karyawan atau kode karyawan…">
      </div>
    </div>

    <div id="org-tree" class="org-tree"><p class="muted">Memuat…</p></div>
  `;

  document.getElementById("org-search").addEventListener("input", e => applyFilter(e.target.value));

  await loadAndRender();
}

async function loadAndRender() {
  const treeEl = document.getElementById("org-tree");
  const [{ data: locs, error: errLocs }, { data: profiles, error: errProf }] = await Promise.all([
    supabase.from("office_locations").select("name").eq("is_active", true).order("name"),
    supabase.from("profiles").select("id, employee_code, full_name, role, department, bagian, position, lokasi_kerja, photo_url").eq("is_active", true).order("full_name"),
  ]);

  if (errLocs || errProf) {
    treeEl.innerHTML = `<p class="muted">Gagal memuat data: ${(errLocs || errProf).message}</p>`;
    document.getElementById("org-summary").innerHTML = "";
    return;
  }

  tree = buildTree(locs || [], profiles || []);
  renderSummary();
  renderTree(treeEl);
}

// -----------------------------------------------------------------------
function buildTree(locations, profiles) {
  const cabangOrder = locations.map(l => l.name); // urutan tampil ikut Master Lokasi Kantor
  const cabangSet = new Set(cabangOrder);
  const cabangMap = {};
  const ensureCabang = key => (cabangMap[key] ??= { deptMap: {} });
  cabangOrder.forEach(name => ensureCabang(name));

  const deptSet = new Set();
  const bagianSet = new Set();

  for (const p of profiles) {
    const cabangKey = p.lokasi_kerja && cabangSet.has(p.lokasi_kerja) ? p.lokasi_kerja : NO_LOKASI;
    const cabang = ensureCabang(cabangKey);

    const deptKey = p.department || NO_DEPT;
    if (deptKey !== NO_DEPT) deptSet.add(`${cabangKey}::${deptKey}`);
    const dept = (cabang.deptMap[deptKey] ??= { bagianMap: {} });

    const bagianKey = p.bagian || NO_BAGIAN;
    if (bagianKey !== NO_BAGIAN) bagianSet.add(`${cabangKey}::${deptKey}::${bagianKey}`);
    const bagian = (dept.bagianMap[bagianKey] ??= []);

    bagian.push(p);
  }

  stats = {
    totalKaryawan: profiles.length,
    totalCabang: cabangOrder.length,
    totalDept: deptSet.size,
    totalBagian: bagianSet.size,
  };

  // Urutan tampil: cabang aktif (ikut Master Lokasi Kantor), lalu "Belum
  // Diatur" (NO_LOKASI) paling akhir kalau memang ada isinya.
  const cabangKeysOrdered = [...cabangOrder, NO_LOKASI].filter(k => cabangMap[k]);
  return cabangKeysOrdered.map(cKey => ({
    key: cKey,
    label: cKey === NO_LOKASI ? "Belum Diatur / Lokasi Tidak Cocok" : cKey,
    count: countInCabang(cabangMap[cKey]),
    depts: sortedDeptKeys(cabangMap[cKey].deptMap).map(dKey => ({
      key: dKey,
      label: dKey === NO_DEPT ? "Belum Diatur" : dKey,
      count: countInDept(cabangMap[cKey].deptMap[dKey]),
      bagians: sortedBagianKeys(cabangMap[cKey].deptMap[dKey].bagianMap).map(bKey => ({
        key: bKey,
        label: bKey === NO_BAGIAN ? "Belum Diatur" : bKey,
        employees: [...cabangMap[cKey].deptMap[dKey].bagianMap[bKey]].sort((a, b) => a.full_name.localeCompare(b.full_name)),
      })),
    })),
  }));
}

function countInCabang(c) { return Object.values(c.deptMap).reduce((s, d) => s + countInDept(d), 0); }
function countInDept(d) { return Object.values(d.bagianMap).reduce((s, list) => s + list.length, 0); }

// "Belum Diatur" (NO_*) selalu ditaruh paling akhir, sisanya urut abjad.
function sortedDeptKeys(map) {
  return Object.keys(map).sort((a, b) => a === NO_DEPT ? 1 : b === NO_DEPT ? -1 : a.localeCompare(b));
}
function sortedBagianKeys(map) {
  return Object.keys(map).sort((a, b) => a === NO_BAGIAN ? 1 : b === NO_BAGIAN ? -1 : a.localeCompare(b));
}

// -----------------------------------------------------------------------
function renderSummary() {
  document.getElementById("org-summary").innerHTML = `
    <div class="status-card done"><span class="status-label">Karyawan Aktif</span><span class="status-value">${stats.totalKaryawan}</span></div>
    <div class="status-card"><span class="status-label">Cabang</span><span class="status-value">${stats.totalCabang}</span></div>
    <div class="status-card"><span class="status-label">Departemen</span><span class="status-value">${stats.totalDept}</span></div>
    <div class="status-card"><span class="status-label">Bagian</span><span class="status-value">${stats.totalBagian}</span></div>
  `;
}

function roleBadge(role) {
  const map = {
    super_admin: `<span class="badge badge-danger">Super Admin</span>`,
    super_admin_hr: `<span class="badge badge-warn">Super Admin HR</span>`,
    admin_hr: `<span class="badge badge-ok">Admin HR</span>`,
    karyawan: `<span class="badge">Karyawan</span>`,
  };
  return map[role] || "";
}

// Inisial 1-2 huruf dari nama, dipakai di avatar bulat setiap baris
// karyawan (huruf pertama dari maks. 2 kata pertama nama, huruf besar).
function initials(fullName) {
  return (fullName || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
}

function renderTree(el) {
  if (!tree.length) { el.innerHTML = `<p class="muted">Belum ada data karyawan aktif.</p>`; return; }

  el.innerHTML = tree.map(cabang => `
    <details class="org-node org-node-cabang">
      <summary>
        <span class="org-summary-left">
          <span class="org-chevron">${ICON_CHEVRON}</span>
          <span class="org-icon org-icon-cabang">${ICON_CABANG}</span>
          <span class="org-node-title">${cabang.label}</span>
        </span>
        <span class="org-pill">${cabang.count} karyawan</span>
      </summary>
      <div class="org-children">
        ${cabang.depts.length ? cabang.depts.map(dept => `
          <details class="org-node org-node-dept">
            <summary>
              <span class="org-summary-left">
                <span class="org-chevron">${ICON_CHEVRON}</span>
                <span class="org-icon org-icon-dept">${ICON_DEPT}</span>
                <span class="org-node-title">${dept.label}</span>
              </span>
              <span class="org-pill">${dept.count} karyawan</span>
            </summary>
            <div class="org-children">
              ${dept.bagians.map(bagian => `
                <details class="org-node org-node-bagian">
                  <summary>
                    <span class="org-summary-left">
                      <span class="org-chevron">${ICON_CHEVRON}</span>
                      <span class="org-node-title">${bagian.label}</span>
                    </span>
                    <span class="org-pill">${bagian.employees.length} karyawan</span>
                  </summary>
                  <div class="org-emp-list">
                    ${bagian.employees.map(e => `
                      <div class="org-emp-row" data-search="${(e.full_name + " " + (e.employee_code || "")).toLowerCase()}">
                        <span class="org-avatar org-avatar-${e.role}">${avatarHTML(e, e.full_name)}</span>
                        <span class="org-emp-info">
                          <span class="org-emp-name">${e.full_name}</span>
                          <span class="org-emp-meta">${e.position || "Jabatan belum diatur"}${e.employee_code ? ` · ${e.employee_code}` : ""}</span>
                        </span>
                        ${roleBadge(e.role)}
                      </div>
                    `).join("")}
                  </div>
                </details>
              `).join("")}
            </div>
          </details>
        `).join("") : `<p class="org-empty">Belum ada karyawan di cabang ini.</p>`}
      </div>
    </details>
  `).join("");
}

// -----------------------------------------------------------------------
// Pencarian client-side: sembunyikan baris karyawan yang tidak cocok, lalu
// sembunyikan node (cabang/departemen/bagian) yang tidak punya baris
// tersisa. Kalau ada kata kunci, node yang masih punya isi otomatis
// dibuka supaya hasilnya langsung kelihatan tanpa perlu klik satu-satu.
function applyFilter(query) {
  const q = query.trim().toLowerCase();
  const rows = document.querySelectorAll("#org-tree .org-emp-row");
  rows.forEach(r => r.classList.toggle("org-hidden", !(!q || r.dataset.search.includes(q))));

  const nodes = document.querySelectorAll("#org-tree .org-node");
  nodes.forEach(n => {
    const hasVisible = !!n.querySelector(".org-emp-row:not(.org-hidden)");
    n.classList.toggle("org-hidden", !!q && !hasVisible);
    if (q) n.open = hasVisible;
  });
}
