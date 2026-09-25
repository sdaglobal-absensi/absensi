import { supabase } from "../supabaseClient.js";
import { fmtDate, fmtTime, todayISO, exportXLSX, toast } from "../core.js";

export async function render(container) {
  const today = todayISO();
  const firstOfMonth = today.slice(0, 8) + "01";

  container.innerHTML = `
    <div class="page-header">
      <h1>Monitor Absensi</h1>
      <div class="filter-row">
        <input type="date" id="filter-date" value="${today}">
        <input type="text" id="filter-search" placeholder="Cari nama karyawan…">
      </div>
    </div>

    <div id="belum-checkout-panel"></div>

    <div id="absensi-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <h2 class="section-title">Export Excel</h2>
    <div class="card" style="max-width:560px;">
      <p class="muted small" style="margin-top:0;">Export data absensi untuk rentang tanggal tertentu (bisa lebih dari satu hari).</p>
      <div class="form-row two-col">
        <label>Dari Tanggal <input type="date" id="export-start" value="${firstOfMonth}"></label>
        <label>Sampai Tanggal <input type="date" id="export-end" value="${today}"></label>
      </div>
      <button id="btn-export" class="btn-secondary">Export Excel</button>
    </div>
  `;

  document.getElementById("filter-date").addEventListener("change", load);
  document.getElementById("filter-search").addEventListener("input", load);
  document.getElementById("btn-export").addEventListener("click", doExport);
  load();
  loadBelumCheckout();
}

// =====================================================================
// PANEL "BELUM CHECK-OUT" — daftar SEMUA sesi lama (bukan cuma tanggal yang
// lagi difilter) yang sudah check-in tapi belum check-out sampai sekarang.
// Supaya admin tidak harus klik tanggal satu-satu untuk sadar ada yang
// kelupaan. Sesi hari ini yang memang masih berjalan (belum waktunya
// pulang) TIDAK dianggap masalah, jadi tidak dimasukkan di sini — lihat
// employee-absensi.js (loadAttendanceState) untuk logika "staleOpen" yang
// serupa di sisi karyawan.
// =====================================================================
async function loadBelumCheckout() {
  const el = document.getElementById("belum-checkout-panel");
  if (!el) return;
  const today = todayISO();

  const { data, error } = await supabase
    .from("attendance")
    .select("id, date, check_in, user_id, profiles(full_name, department, employee_code)")
    .is("check_out", null)
    .lt("date", today)
    .order("date", { ascending: true });

  if (error || !data || !data.length) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <div class="card" style="border-left:4px solid var(--warn); margin-bottom:20px;">
      <p class="small" style="margin:0 0 10px 0; color:var(--warn); font-weight:600;">
        ⚠️ ${data.length} sesi lupa check-out (perlu ditindaklanjuti)
      </p>
      <table class="table">
        <thead><tr><th>Karyawan</th><th>Departemen</th><th>Tanggal</th><th>Check-in</th><th></th></tr></thead>
        <tbody>
          ${data.map(r => `
            <tr>
              <td>${r.profiles?.full_name || "-"}</td>
              <td>${r.profiles?.department || "-"}</td>
              <td>${fmtDate(r.date)}</td>
              <td>${fmtTime(r.check_in)}</td>
              <td><button type="button" class="btn-link btn-lihat-tanggal" data-date="${r.date}">Lihat tanggal ini</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <p class="muted small" style="margin:10px 0 0 0;">
        Minta karyawan mengajukan lewat menu <strong>Koreksi Absen</strong> supaya jam pulangnya bisa diperbaiki dan disetujui.
      </p>
    </div>
  `;

  el.querySelectorAll(".btn-lihat-tanggal").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("filter-date").value = btn.dataset.date;
      load();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

async function load() {
  const date = document.getElementById("filter-date").value;
  const search = document.getElementById("filter-search").value.toLowerCase();
  const isPastDate = date < todayISO();

  const { data, error } = await supabase
    .from("attendance")
    .select("*, profiles(full_name, department, employee_code)")
    .eq("date", date)
    .order("check_in", { ascending: true });

  const el = document.getElementById("absensi-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }

  const filtered = search
    ? data.filter(r => r.profiles?.full_name?.toLowerCase().includes(search))
    : data;

  if (!filtered.length) { el.innerHTML = `<p class="muted">Belum ada data absensi untuk tanggal ini.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Karyawan</th><th>Departemen</th><th>Check-in</th><th>Status</th><th>Lokasi</th><th>Foto Check-in</th><th>Check-out</th><th>Foto Check-out</th></tr></thead>
      <tbody>
        ${filtered.map(r => `
          <tr ${!r.check_out && isPastDate ? `style="background:color-mix(in srgb, var(--warn) 10%, transparent);"` : ""}>
            <td>${r.profiles?.full_name || "-"}</td>
            <td>${r.profiles?.department || "-"}</td>
            <td>${fmtTime(r.check_in)}</td>
            <td>${r.check_in_status ? `<span class="badge badge-${r.check_in_status === "telat" ? "warn" : "ok"}">${r.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : "-"}</td>
            <td>${locationCell(r)}</td>
            <td>${photoCell(r.check_in_photo_url)}</td>
            <td>${r.check_out ? fmtTime(r.check_out) : (isPastDate ? `<span style="color:var(--warn);">⚠️ Belum</span>` : `<span class="muted">Belum</span>`)}</td>
            <td>${photoCell(r.check_out_photo_url)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function doExport() {
  const start = document.getElementById("export-start").value;
  const end = document.getElementById("export-end").value;
  const search = document.getElementById("filter-search").value.toLowerCase();
  const btn = document.getElementById("btn-export");

  if (!start || !end) { return; }
  if (start > end) {
    toast("Tanggal 'Dari' harus sebelum atau sama dengan tanggal 'Sampai'", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Menyiapkan data…";

  const { data, error } = await supabase
    .from("attendance")
    .select("*, profiles(full_name, department, employee_code)")
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true })
    .order("check_in", { ascending: true });

  btn.disabled = false;
  btn.textContent = "Export Excel";

  if (error) { return; }

  const filtered = search
    ? (data || []).filter(r => r.profiles?.full_name?.toLowerCase().includes(search))
    : (data || []);

  const rows = filtered.map(r => ({
    Tanggal: fmtDate(r.date),
    "Kode Karyawan": r.profiles?.employee_code || "-",
    Nama: r.profiles?.full_name || "-",
    Departemen: r.profiles?.department || "-",
    "Jam Check-in": fmtTime(r.check_in),
    Status: r.check_in_status === "telat" ? "Telat" : r.check_in_status === "tepat_waktu" ? "Tepat waktu" : "-",
    "Jarak Check-in (m)": r.check_in_distance_m ?? "-",
    "Jam Check-out": fmtTime(r.check_out),
    "Jarak Check-out (m)": r.check_out_distance_m ?? "-",
    "Foto Check-in": r.check_in_photo_url || "-",
    "Foto Check-out": r.check_out_photo_url || "-",
  }));

  exportXLSX(`absensi-${start}_sampai_${end}.xlsx`, rows, "Absensi");
}

function locationCell(r) {
  if (r.check_in_lat == null) return "-";
  const dist = r.check_in_distance_m != null ? `${r.check_in_distance_m}m dari kantor` : "";
  const link = `https://www.google.com/maps?q=${r.check_in_lat},${r.check_in_lng}`;
  return `<a href="${link}" target="_blank" rel="noopener" class="btn-link">Lihat peta</a><br><span class="small muted">${dist}</span>`;
}

function photoCell(url) {
  if (!url) return "-";
  return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" class="thumb"></a>`;
}
