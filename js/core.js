import { supabase } from "./supabaseClient.js";

// =====================================================================
// TOAST NOTIFICATION
// =====================================================================
export function toast(message, type = "info") {
  const box = document.getElementById("toast-box") || (() => {
    const el = document.createElement("div");
    el.id = "toast-box";
    document.body.appendChild(el);
    return el;
  })();
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.textContent = message;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// =====================================================================
// SIDEBAR — menu berbeda tergantung role
// =====================================================================
const MENUS = {
  karyawan: [
    { id: "absensi", label: "Absensi", icon: "clock" },
    { id: "izin", label: "Pengajuan Izin", icon: "file" },
    { id: "riwayat", label: "Riwayat Saya", icon: "history" },
  ],
  hr: [
    { id: "absensi-monitor", label: "Monitor Absensi", icon: "clock" },
    { id: "izin-approval", label: "Approval Izin", icon: "check" },
    { id: "laporan", label: "Laporan", icon: "chart" },
    { id: "master-level", label: "Master Level", icon: "layers", section: "Master Data" },
    { id: "master-departemen", label: "Master Departemen", icon: "grid", section: "Master Data" },
    { id: "master-jadwal", label: "Master Jadwal Kerja", icon: "clock", section: "Master Data" },
    { id: "master-libur", label: "Master Hari Libur", icon: "file", section: "Master Data" },
    { id: "master-lokasi", label: "Master Lokasi Kantor", icon: "grid", section: "Master Data" },
  ],
  admin: [
    { id: "karyawan", label: "Data Karyawan", icon: "users" },
    { id: "absensi-monitor", label: "Monitor Absensi", icon: "clock" },
    { id: "izin-approval", label: "Approval Izin", icon: "check" },
    { id: "laporan", label: "Laporan", icon: "chart" },
    { id: "master-level", label: "Master Level", icon: "layers", section: "Master Data" },
    { id: "master-departemen", label: "Master Departemen", icon: "grid", section: "Master Data" },
    { id: "master-jadwal", label: "Master Jadwal Kerja", icon: "clock", section: "Master Data" },
    { id: "master-libur", label: "Master Hari Libur", icon: "file", section: "Master Data" },
    { id: "master-lokasi", label: "Master Lokasi Kantor", icon: "grid", section: "Master Data" },
  ],
};

const ICONS = {
  clock: "M12 6v6l4 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6",
  history: "M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8",
  check: "M20 6L9 17l-5-5",
  chart: "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  layers: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
};

export function renderSidebar(user, activeId) {
  const menu = MENUS[user.role] || [];
  const nav = document.getElementById("sidebar-nav");
  let html = "";
  let lastSection;
  for (const item of menu) {
    if (item.section && item.section !== lastSection) {
      html += `<div class="nav-section-label">${item.section}</div>`;
    }
    lastSection = item.section;
    html += `
      <button class="nav-item ${item.id === activeId ? "active" : ""}" data-target="${item.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[item.icon]}"/></svg>
        <span>${item.label}</span>
      </button>
    `;
  }
  nav.innerHTML = html;

  document.getElementById("sidebar-user-name").textContent = user.full_name;
  document.getElementById("sidebar-user-role").textContent = roleLabel(user.role);
}

export function roleLabel(role) {
  return { admin: "Admin", hr: "HR / Manager", karyawan: "Karyawan" }[role] || role;
}

// =====================================================================
// GEOLOCATION
// =====================================================================
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Perangkat tidak mendukung GPS."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error("Gagal mengambil lokasi: " + err.message)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// Jarak antara 2 koordinat dalam meter (Haversine)
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export async function getNearestOffice(lat, lng) {
  const { data: offices } = await supabase.from("office_locations").select("*").eq("is_active", true);
  if (!offices || offices.length === 0) return null;
  let nearest = null;
  let minDist = Infinity;
  for (const o of offices) {
    const d = distanceMeters(lat, lng, o.lat, o.lng);
    if (d < minDist) { minDist = d; nearest = { ...o, distance: d }; }
  }
  return nearest;
}

// =====================================================================
// UPLOAD FOTO ke Supabase Storage, return public URL
// =====================================================================
export async function uploadPhoto(fileOrBlob, pathPrefix) {
  const ext = "jpg";
  const fileName = `${pathPrefix}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("attendance-photos")
    .upload(fileName, fileOrBlob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from("attendance-photos").getPublicUrl(fileName);
  return data.publicUrl;
}

// Ambil Blob dari elemen <video> (dipakai setelah capture kamera).
// watermarkLines (opsional): array baris teks yang dicap di bagian bawah foto
// (misal [waktu, alamat]).
export function captureFrameAsBlob(videoEl, watermarkLines = null) {
  return new Promise(resolve => {
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0);
    if (watermarkLines && watermarkLines.length) {
      drawPhotoWatermark(ctx, canvas.width, canvas.height, watermarkLines);
    }
    canvas.toBlob(blob => resolve(blob), "image/jpeg", 0.85);
  });
}

// Cap teks (waktu, alamat, dsb) di bagian bawah foto dengan latar semi-transparan.
function drawPhotoWatermark(ctx, w, h, lines) {
  const padding = Math.max(8, Math.floor(h * 0.018));
  const fontSize = Math.max(12, Math.floor(h * 0.026));
  const lineHeight = Math.round(fontSize * 1.45);
  ctx.font = `${fontSize}px -apple-system, Arial, sans-serif`;

  // Bungkus tiap baris supaya tidak keluar dari lebar foto
  const maxWidth = w - padding * 2;
  const wrapped = [];
  lines.forEach(line => {
    const words = String(line).split(" ");
    let current = "";
    words.forEach(word => {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        wrapped.push(current);
        current = word;
      } else {
        current = test;
      }
    });
    if (current) wrapped.push(current);
  });
  const capped = wrapped.slice(0, 4); // batasi maksimal 4 baris

  const barHeight = capped.length * lineHeight + padding * 2;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, h - barHeight, w, barHeight);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  capped.forEach((line, i) => {
    ctx.fillText(line, padding, h - barHeight + padding + i * lineHeight);
  });
}

// Cari lokasi berdasarkan nama/alamat (forward geocode) lewat OpenStreetMap
// Nominatim. Cocok untuk alamat/tempat umum yang sudah terdaftar di peta;
// nama internal perusahaan yang sangat spesifik mungkin tidak ketemu —
// pemanggil tetap harus sediakan opsi isi manual sebagai fallback.
export async function searchLocation(query) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`,
      { headers: { "Accept-Language": "id" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(d => ({ label: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) }));
  } catch (e) {
    return [];
  }
}
// tanpa API key). Bisa gagal/lambat; pemanggil harus siap fallback ke
// koordinat mentah kalau hasilnya null.
export async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0`,
      { headers: { "Accept-Language": "id" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (e) {
    return null;
  }
}

// =====================================================================
// FORMAT HELPERS
// =====================================================================
export function fmtDate(d) {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtTime(d) {
  if (!d) return "-";
  return new Date(d).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(d) {
  if (!d) return "-";
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function fmtRupiah(n) {
  if (n === null || n === undefined || n === "") return "-";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

// =====================================================================
// TOGGLE LIHAT PASSWORD (tombol mata)
// =====================================================================
export function wirePasswordToggles(root = document) {
  root.querySelectorAll(".btn-toggle-pw").forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.querySelector(".icon-eye").classList.toggle("hidden");
      btn.querySelector(".icon-eye-off").classList.toggle("hidden");
    });
  });
}

export function passwordToggleBtnHtml(targetId) {
  return `
    <button type="button" class="btn-toggle-pw" data-target="${targetId}" aria-label="Tampilkan/sembunyikan password">
      <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg class="icon-eye-off hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a21.86 21.86 0 015.06-6.06M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 8 11 8a21.86 21.86 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24M1 1l22 22"/></svg>
    </button>
  `;
}

// =====================================================================
// SEARCH SELECT — dropdown dengan pencarian (menggantikan <select> biasa
// untuk pilihan yang datanya banyak/berasal dari master data)
// =====================================================================
export function searchSelectHtml({ id, label, placeholder = "Ketik untuk cari…", required = false, hint = "" }) {
  return `
    <div class="search-select" data-ss-id="${id}">
      <label for="${id}-input">${label}</label>
      <input type="text" id="${id}-input" autocomplete="off" placeholder="${placeholder}" ${required ? "required" : ""}>
      <input type="hidden" id="${id}-value">
      <div class="search-select-list hidden" id="${id}-list"></div>
      ${hint ? `<span class="small muted">${hint}</span>` : ""}
    </div>
  `;
}

// options: array apa saja. getLabel/getValue: cara membaca teks & nilainya.
export function wireSearchSelect(id, options, { getLabel = o => String(o), getValue = o => String(o), onSelect } = {}) {
  const input = document.getElementById(`${id}-input`);
  const hidden = document.getElementById(`${id}-value`);
  const list = document.getElementById(`${id}-list`);
  if (!input) return null;

  function renderList(filter = "") {
    const f = filter.toLowerCase();
    const filtered = options.filter(o => getLabel(o).toLowerCase().includes(f));
    list.innerHTML = filtered.length
      ? filtered.map(o => `<div class="search-option" data-value="${escapeAttr(getValue(o))}">${getLabel(o)}</div>`).join("")
      : `<div class="search-option muted">Tidak ada hasil — cek Master Data</div>`;
    list.classList.remove("hidden");
  }

  input.addEventListener("focus", () => renderList(input.value));
  input.addEventListener("input", () => { hidden.value = ""; renderList(input.value); });
  list.addEventListener("mousedown", e => {
    const opt = e.target.closest(".search-option");
    if (!opt || opt.dataset.value === undefined) return;
    const o = options.find(x => getValue(x) === opt.dataset.value);
    if (!o) return;
    input.value = getLabel(o);
    hidden.value = getValue(o);
    list.classList.add("hidden");
    if (onSelect) onSelect(o);
  });
  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !list.contains(e.target)) list.classList.add("hidden");
  });

  const controller = {
    setValue(value, labelText) { input.value = labelText ?? value ?? ""; hidden.value = value ?? ""; },
    clear() { input.value = ""; hidden.value = ""; },
    setOptions(newOptions) { options = newOptions; },
    get value() { return hidden.value; },
  };
  return controller;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// Hitung "lama bekerja" dari tanggal masuk ke hari ini, format "X tahun Y bulan"
export function lamaBekerja(joinDateStr) {
  if (!joinDateStr) return "-";
  const start = new Date(joinDateStr);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months--;
  if (months < 0) return "-";
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (years === 0 && remMonths === 0) return "Baru bergabung";
  const parts = [];
  if (years > 0) parts.push(`${years} tahun`);
  if (remMonths > 0) parts.push(`${remMonths} bulan`);
  return parts.join(" ");
}

// CSV export helper
export function exportCSV(filename, rows) {
  if (!rows.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map(r => headers.map(h => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Export Excel (.xlsx) asli lewat SheetJS (dimuat via <script> di app.html)
export function exportXLSX(filename, rows, sheetName = "Data") {
  if (!rows.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  if (typeof XLSX === "undefined") {
    toast("Gagal export: library Excel belum termuat, coba refresh halaman.", "error");
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}
