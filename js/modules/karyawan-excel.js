import { supabase, supabaseAdminCreate } from "../supabaseClient.js";
import { esc } from "../approvalHelper.js";
import { toast, roleLabel, jenisHubunganKerjaLabel } from "../core.js";
import { hasXLSX, readFirstSheet, cellText, cellDateISO, normKey, writeWorkbook, widthsFor } from "../excelIO.js";

// =======================================================================
// TEMPLATE / IMPORT / EXPORT EXCEL — Data Karyawan
//
// Import hanya MEMBUAT karyawan baru (akun login + profil). Baris yang Kode
// Karyawan atau emailnya sudah ada di sistem dilewati, tidak menimpa data.
// Role selalu 'karyawan' (diubah lewat Struktur Organisasi, sama seperti
// tombol "+ Tambah Karyawan"). Data keluarga/anak & biodata lain tidak ikut
// import; lengkapi lewat Edit atau oleh karyawan sendiri di Profil.
// Semua isian dicek ke master data (PT/Vendor, Lokasi, Departemen, Level)
// sebelum akun dibuat; hasil + password awal diunduh sebagai file Excel.
// =======================================================================

const HEADERS = [
  "Kode Karyawan", "Nama Lengkap", "Email", "Password Awal", "Jenis Hubungan Kerja",
  "Unit / PT", "Lokasi Kerja / Area", "Departemen", "Bagian", "Jabatan", "Grade",
  "Status Karyawan", "Tanggal Masuk", "No. HP", "NIK KTP", "NPWP", "Alamat Domisili",
];

const JENIS_MAP = {
  karyawantetap: "karyawan_tetap", tetap: "karyawan_tetap",
  pkwt: "pkwt",
  outsourcing: "outsourcing", os: "outsourcing",
};

const sameText = (a, b) => normKey(a) === normKey(b);
const findBy = (list, getter, val) => list.find(x => sameText(getter(x), val));

// ---------------------------------------------------------------------
// TEMPLATE
// ---------------------------------------------------------------------
export function downloadKaryawanTemplate(m) {
  if (!hasXLSX()) { toast("Library Excel belum termuat, coba refresh halaman.", "error"); return; }

  const vendors = m.masterPts.filter(p => p.jenis === "vendor").map(p => p.nama);
  const internals = m.masterPts.filter(p => p.jenis !== "vendor").map(p => p.nama);
  const locs = m.masterLocations.map(l => l.name);
  const depts = m.masterDepartments.map(d => [d.departemen, d.bagian, d.jabatan]);
  const grades = m.masterLevels.map(l => [l.grade, l.level]);

  const listCols = [
    ["Unit / PT (untuk Outsourcing)", vendors],
    ["Unit / PT (Karyawan Tetap / PKWT)", internals],
    ["Lokasi Kerja / Area", locs],
    ["Departemen", depts.map(d => d[0])],
    ["Bagian", depts.map(d => d[1])],
    ["Jabatan", depts.map(d => d[2])],
    ["Grade", grades.map(g => g[0])],
    ["Level", grades.map(g => g[1])],
  ];
  const maxLen = Math.max(...listCols.map(c => c[1].length), 1);
  const pilihan = [listCols.map(c => c[0])];
  for (let i = 0; i < maxLen; i++) pilihan.push(listCols.map(c => c[1][i] ?? ""));

  const guide = [
    ["Petunjuk pengisian"],
    ["1. Isi sheet \"Data\" mulai baris 2. Satu baris = satu karyawan baru."],
    ["2. Wajib diisi: Kode Karyawan, Nama Lengkap, Email, Jenis Hubungan Kerja. Untuk Outsourcing, Unit / PT juga wajib."],
    ["3. Jenis Hubungan Kerja: Karyawan Tetap, PKWT, atau Outsourcing."],
    ["4. Unit / PT, Lokasi Kerja, Departemen, Bagian, Jabatan, dan Grade harus SAMA dengan master data (lihat sheet \"Pilihan\")."],
    ["   Departemen, Bagian, dan Jabatan harus satu rangkaian yang ada di Master Departemen."],
    ["5. Password Awal minimal 6 karakter. Kosong = dibuatkan otomatis (ditampilkan di file hasil import)."],
    ["6. Status Karyawan: Bulanan atau Harian (kosong = Bulanan)."],
    ["7. Tanggal Masuk format 2025-11-21 atau 21/11/2025."],
    ["8. NIK KTP 16 digit dan NPWP: format kolom sebagai Teks agar angka nol di depan tidak hilang."],
    ["9. Kode Karyawan atau Email yang sudah terdaftar dilewati (data lama tidak ditimpa)."],
    [""],
    ["Contoh isi satu baris:"],
    ["SBY/260701/0001 | Budi Santoso | budi@email.com | (kosong) | Outsourcing | PT. KARYA BINTANG MANDIRI | Bekasi | HCS | Security | Security | Grade 0 | Bulanan | 2026-07-01"],
  ];

  writeWorkbook("Template_Data_Karyawan.xlsx", [
    { name: "Data", rows: [HEADERS], widths: widthsFor(HEADERS, [], 16) },
    { name: "Petunjuk", rows: guide, widths: [120] },
    { name: "Pilihan", rows: pilihan, widths: widthsFor(pilihan[0], pilihan.slice(1), 16) },
  ]);
  toast("Template diunduh. Isi sheet \"Data\", lalu klik Import Excel.", "success");
}

// ---------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------
export function exportKaryawan(list) {
  if (!hasXLSX()) { toast("Library Excel belum termuat, coba refresh halaman.", "error"); return; }
  if (!list.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const head = [
    "Kode Karyawan", "Nama Lengkap", "Email", "Jenis Hubungan Kerja", "Unit / PT", "Lokasi Kerja / Area",
    "Departemen", "Bagian", "Jabatan", "Grade", "Level", "Status Karyawan", "Tanggal Masuk", "Tanggal Resign",
    "No. HP", "NIK KTP", "NPWP", "Alamat Domisili", "Role", "Status Akun",
  ];
  const rows = [head, ...list.map(k => [
    k.employee_code || "", k.full_name || "", k.email || "",
    jenisHubunganKerjaLabel(k.jenis_hubungan_kerja), k.unit_pt || "", k.lokasi_kerja || "",
    k.department || "", k.bagian || "", k.position || "", k.grade || "", k.level || "",
    k.status_karyawan === "harian" ? "Harian" : "Bulanan", k.join_date || "", k.resign_date || "",
    k.phone || "", k.nik_ktp || "", k.npwp || "", k.alamat || "",
    roleLabel(k.role), k.is_active ? "Aktif" : "Nonaktif",
  ])];
  const stamp = new Date().toISOString().slice(0, 10);
  writeWorkbook(`Data_Karyawan_${stamp}.xlsx`, [{ name: "Karyawan", rows, widths: widthsFor(head, rows) }]);
}

// ---------------------------------------------------------------------
// IMPORT: baca -> validasi -> pratinjau -> proses
// ---------------------------------------------------------------------
function genPassword() {
  return (Math.random().toString(36).slice(2) + "abcdef").slice(0, 8);
}

function digitsOrText(v) {
  // Excel sering mengubah nomor panjang jadi angka (kehilangan nol / presisi).
  if (typeof v === "number") return { text: Number.isSafeInteger(v) ? String(v) : "", lossy: !Number.isSafeInteger(v) };
  return { text: cellText(v), lossy: false };
}

export function validateKaryawanRows(rows, m) {
  const usedCodes = new Set(m.existingRows.map(k => cellText(k.employee_code).toLowerCase()).filter(Boolean));
  const usedEmails = new Set(m.existingRows.map(k => cellText(k.email).toLowerCase()).filter(Boolean));
  const valid = [], rejected = [], skipped = [];

  rows.forEach(r => {
    const errs = [];
    const kode = cellText(r.get("Kode Karyawan"));
    const nama = cellText(r.get("Nama Lengkap", "Nama"));
    const email = cellText(r.get("Email")).toLowerCase();
    const label = kode || nama || `baris ${r._row}`;
    const info = { row: r._row, kode, nama, email };

    if (!kode) errs.push("Kode Karyawan kosong");
    if (!nama) errs.push("Nama Lengkap kosong");
    if (!email) errs.push("Email kosong");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push("format Email tidak valid");

    // Sudah terdaftar / duplikat di file -> dilewati (bukan error)
    if ((kode && usedCodes.has(kode.toLowerCase())) || (email && usedEmails.has(email))) {
      skipped.push({ ...info, reason: "Kode Karyawan / Email sudah terdaftar (dilewati)" });
      return;
    }

    const jenisTxt = cellText(r.get("Jenis Hubungan Kerja", "Hubungan Kerja"));
    const jenis = JENIS_MAP[normKey(jenisTxt)];
    if (!jenisTxt) errs.push("Jenis Hubungan Kerja kosong");
    else if (!jenis) errs.push(`Jenis Hubungan Kerja "${jenisTxt}" tidak dikenali (Karyawan Tetap / PKWT / Outsourcing)`);

    // Unit / PT
    let unitPt = null;
    const ptTxt = cellText(r.get("Unit / PT", "Unit PT", "PT"));
    if (ptTxt) {
      const pool = m.masterPts.filter(p => p.jenis === (jenis === "outsourcing" ? "vendor" : "internal"));
      const hit = findBy(pool, p => p.nama, ptTxt);
      if (hit) unitPt = hit.nama;
      else if (jenis) errs.push(`Unit / PT "${ptTxt}" tidak ada di Master PT / Vendor untuk ${jenis === "outsourcing" ? "vendor" : "PT sendiri"}`);
    } else if (jenis === "outsourcing") errs.push("Unit / PT wajib diisi untuk Outsourcing");

    // Lokasi
    let lokasi = null;
    const lokTxt = cellText(r.get("Lokasi Kerja / Area", "Lokasi Kerja", "Area"));
    if (lokTxt) {
      const hit = findBy(m.masterLocations, l => l.name, lokTxt);
      if (hit) lokasi = hit.name; else errs.push(`Lokasi Kerja "${lokTxt}" tidak ada di Master Lokasi Kantor`);
    }

    // Departemen -> Bagian -> Jabatan (harus satu rangkaian di master)
    let dept = null, bagian = null, jabatan = null;
    const dTxt = cellText(r.get("Departemen")), bTxt = cellText(r.get("Bagian")), jTxt = cellText(r.get("Jabatan"));
    if (dTxt || bTxt || jTxt) {
      const dHit = dTxt ? m.masterDepartments.find(d => sameText(d.departemen, dTxt)) : null;
      if (!dTxt) errs.push("Departemen kosong padahal Bagian/Jabatan diisi");
      else if (!dHit) errs.push(`Departemen "${dTxt}" tidak ada di Master Departemen`);
      else {
        dept = dHit.departemen;
        const inDept = m.masterDepartments.filter(d => d.departemen === dept);
        if (bTxt) {
          const bHit = inDept.find(d => sameText(d.bagian, bTxt));
          if (!bHit) errs.push(`Bagian "${bTxt}" tidak ada di departemen ${dept}`);
          else {
            bagian = bHit.bagian;
            if (jTxt) {
              const jHit = inDept.find(d => d.bagian === bagian && sameText(d.jabatan, jTxt));
              if (!jHit) errs.push(`Jabatan "${jTxt}" tidak ada di ${dept} / ${bagian}`); else jabatan = jHit.jabatan;
            }
          }
        } else if (jTxt) errs.push("Bagian kosong padahal Jabatan diisi");
      }
    }

    // Grade (boleh "Grade 1" atau "Grade 1 - Worker")
    let grade = null, level = null;
    const gTxt = cellText(r.get("Grade"));
    if (gTxt) {
      let hits = m.masterLevels.filter(l => sameText(l.grade, gTxt));
      if (!hits.length) hits = m.masterLevels.filter(l => normKey(`${l.grade}${l.level}`) === normKey(gTxt));
      if (!hits.length) errs.push(`Grade "${gTxt}" tidak ada di Master Level`);
      else if (hits.length > 1) errs.push(`Grade "${gTxt}" cocok dengan beberapa level, tulis "Grade - Level"`);
      else { grade = hits[0].grade; level = hits[0].level; }
    }

    // Status karyawan
    const stTxt = cellText(r.get("Status Karyawan")).toLowerCase();
    let status = "bulanan";
    if (stTxt) { if (["bulanan", "harian"].includes(stTxt)) status = stTxt; else errs.push(`Status Karyawan "${stTxt}" harus Bulanan atau Harian`); }

    // Tanggal masuk
    const joinRaw = r.get("Tanggal Masuk");
    const joinISO = cellDateISO(joinRaw);
    if (joinISO === null) errs.push(`Tanggal Masuk "${joinRaw}" tidak dikenali (pakai 2025-11-21 atau 21/11/2025)`);

    // Password
    const pwTxt = cellText(r.get("Password Awal", "Password"));
    if (pwTxt && pwTxt.length < 6) errs.push("Password Awal minimal 6 karakter");

    // No. HP / NIK / NPWP
    let phone = digitsOrText(r.get("No. HP", "No HP", "HP", "Telepon")).text;
    if (typeof r.get("No. HP", "No HP", "HP", "Telepon") === "number" && phone && !phone.startsWith("0") && phone.startsWith("8")) phone = "0" + phone;
    const nikV = digitsOrText(r.get("NIK KTP", "NIK"));
    if (nikV.lossy) errs.push("NIK KTP terbaca sebagai angka dan rusak; format kolom sebagai Teks");
    else if (nikV.text && !/^\d{16}$/.test(nikV.text)) errs.push("NIK KTP harus 16 digit angka");
    const npwp = digitsOrText(r.get("NPWP")).text;

    if (errs.length) { rejected.push({ ...info, reason: errs.join("; ") }); return; }

    // Tandai dipakai supaya duplikat di dalam file ikut terdeteksi
    usedCodes.add(kode.toLowerCase());
    usedEmails.add(email);

    valid.push({
      ...info,
      password: pwTxt || genPassword(),
      jenis, unitPt, lokasi,
      payload: {
        full_name: nama, employee_code: kode,
        department: dept, bagian, position: jabatan, grade, level,
        unit_pt: unitPt, jenis_hubungan_kerja: jenis, lokasi_kerja: lokasi,
        status_karyawan: status, join_date: joinISO || null,
        phone: phone || null, nik_ktp: nikV.text || null, npwp: npwp || null,
        alamat: cellText(r.get("Alamat Domisili", "Alamat")) || null,
        is_active: true,
      },
      label,
    });
  });

  return { valid, rejected, skipped };
}

export async function importKaryawanFile(file, m) {
  if (!hasXLSX()) { toast("Fitur import butuh library XLSX yang belum termuat.", "error"); return; }
  let rows;
  try { rows = await readFirstSheet(file); } catch (err) { toast("File tidak bisa dibaca: " + err.message, "error"); return; }
  if (!rows.length) { toast("File Excel kosong atau kolom tidak dikenali. Pakai Download Template.", "error"); return; }
  const result = validateKaryawanRows(rows, m);
  openPreview(result, m);
}

// ---------------------------------------------------------------------
// PRATINJAU & PROSES
// ---------------------------------------------------------------------
function ensureModal() {
  let modal = document.getElementById("modal-import-karyawan");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-import-karyawan";
    modal.className = "modal hidden";
    modal.innerHTML = `<div class="modal-box modal-box-lg"><div id="imp-body"></div></div>`;
    document.body.appendChild(modal);
  }
  return modal;
}

function openPreview({ valid, rejected, skipped }, m) {
  const modal = ensureModal();
  const body = modal.querySelector("#imp-body");
  const close = () => modal.classList.add("hidden");

  const list = (items, cls) => items.length ? `
    <div style="max-height:160px; overflow-y:auto; margin:6px 0 12px; font-size:0.84rem;">
      ${items.slice(0, 100).map(x => `<div class="${cls}" style="padding:3px 0; border-bottom:1px dashed var(--border);">Baris ${x.row} (${esc(x.kode || x.nama || "-")}): ${esc(x.reason)}</div>`).join("")}
      ${items.length > 100 ? `<div class="muted">… dan ${items.length - 100} lainnya</div>` : ""}
    </div>` : "";

  body.innerHTML = `
    <h3>Import Data Karyawan</h3>
    <p class="muted" style="margin:6px 0 12px;">
      <strong>${valid.length}</strong> siap dibuat &nbsp;·&nbsp;
      <strong>${skipped.length}</strong> sudah terdaftar (dilewati) &nbsp;·&nbsp;
      <strong>${rejected.length}</strong> ditolak
    </p>
    ${rejected.length ? `<div class="form-section-label">Ditolak — perbaiki di Excel lalu import ulang</div>${list(rejected, "")}` : ""}
    ${skipped.length ? `<div class="form-section-label">Dilewati</div>${list(skipped, "muted")}` : ""}
    ${valid.length ? `
      <div class="form-section-label">Akan dibuat${valid.length > 15 ? " (15 pertama)" : ""}</div>
      <div class="table-wrap" style="max-height:220px; overflow:auto;">
        <table class="table">
          <thead><tr><th>Kode</th><th>Nama</th><th>Email</th><th>Hubungan Kerja</th><th>Unit / PT</th><th>Area</th></tr></thead>
          <tbody>${valid.slice(0, 15).map(v => `
            <tr><td>${esc(v.kode)}</td><td>${esc(v.nama)}</td><td>${esc(v.email)}</td>
            <td>${esc(jenisHubunganKerjaLabel(v.jenis))}</td><td>${esc(v.unitPt || "-")}</td><td>${esc(v.lokasi || "-")}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:8px;">Akun dibuat satu per satu, jadi butuh waktu (± 1 detik per karyawan). Jangan tutup halaman sampai selesai. Setelah selesai, file berisi email dan password awal otomatis diunduh.</p>` : `<p class="muted">Tidak ada baris yang bisa dibuat.</p>`}
    <div id="imp-progress" class="small" style="margin-top:8px;"></div>
    <div class="modal-actions">
      <button type="button" id="imp-cancel" class="btn-secondary">${valid.length ? "Batal" : "Tutup"}</button>
      ${valid.length ? `<button type="button" id="imp-run" class="btn-primary">Buat ${valid.length} Akun</button>` : ""}
    </div>`;

  modal.classList.remove("hidden");
  body.querySelector("#imp-cancel").addEventListener("click", close);
  const runBtn = body.querySelector("#imp-run");
  if (runBtn) runBtn.addEventListener("click", () => runImport(valid, rejected, skipped, m, body, close));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runImport(valid, rejected, skipped, m, body, close) {
  const runBtn = body.querySelector("#imp-run"), cancelBtn = body.querySelector("#imp-cancel");
  const progress = body.querySelector("#imp-progress");
  runBtn.disabled = true; cancelBtn.disabled = true;

  const results = []; // { v, status, note }
  let stopped = false;

  for (let i = 0; i < valid.length; i++) {
    const v = valid[i];
    if (stopped) { results.push({ v, status: "Belum diproses", note: "Dihentikan karena batas pendaftaran tercapai; import ulang file yang sama nanti" }); continue; }
    progress.textContent = `Membuat akun ${i + 1} dari ${valid.length}: ${v.nama}…`;
    try {
      const { data, error } = await supabaseAdminCreate.auth.signUp({
        email: v.email, password: v.password,
        options: { data: { full_name: v.payload.full_name, employee_code: v.payload.employee_code } },
      });
      if (error) throw error;
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error("Email sudah terdaftar di sistem login");
      const uid = data.user?.id;
      if (!uid) throw new Error("Akun tidak terbentuk");
      const { error: updErr } = await supabase.from("profiles").update({ ...v.payload, email: v.email }).eq("id", uid);
      if (updErr) results.push({ v, status: "Sebagian", note: "Akun dibuat, tapi data profil gagal disimpan: " + updErr.message });
      else results.push({ v, status: "Berhasil", note: "" });
    } catch (err) {
      const msg = err.message || String(err);
      results.push({ v, status: "Gagal", note: msg });
      if (/rate limit|too many|security purposes/i.test(msg)) stopped = true;
    } finally {
      await supabaseAdminCreate.auth.signOut().catch(() => {});
    }
    await sleep(500);
  }

  // File hasil (berisi password awal -> kirimkan ke karyawan bersangkutan)
  const head = ["Kode Karyawan", "Nama", "Email", "Password Awal", "Status", "Keterangan"];
  const out = [head,
    ...results.map(r => [r.v.kode, r.v.nama, r.v.email, r.status === "Gagal" || r.status === "Belum diproses" ? "" : r.v.password, r.status, r.note]),
    ...rejected.map(x => [x.kode, x.nama, x.email, "", "Ditolak", x.reason]),
    ...skipped.map(x => [x.kode, x.nama, x.email, "", "Dilewati", x.reason]),
  ];
  const ok = results.filter(r => r.status === "Berhasil").length;
  const bad = results.length - ok;
  writeWorkbook(`Hasil_Import_Karyawan_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: "Hasil", rows: out, widths: widthsFor(head, out, 14, 60) }]);

  progress.textContent = "";
  close();
  toast(`Import selesai: ${ok} akun berhasil${bad ? `, ${bad} gagal/belum diproses` : ""}. File hasil (password awal) sudah diunduh.`, bad ? "error" : "success");
  if (m.onDone) m.onDone();
}
