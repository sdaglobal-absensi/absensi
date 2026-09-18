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
  ],
  admin: [
    { id: "karyawan", label: "Data Karyawan", icon: "users" },
    { id: "absensi-monitor", label: "Monitor Absensi", icon: "clock" },
    { id: "izin-approval", label: "Approval Izin", icon: "check" },
    { id: "laporan", label: "Laporan", icon: "chart" },
    { id: "master-level", label: "Master Level", icon: "layers", section: "Master Data" },
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

// Ambil Blob dari elemen <video> (dipakai setelah capture kamera)
export function captureFrameAsBlob(videoEl) {
  return new Promise(resolve => {
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvas.getContext("2d").drawImage(videoEl, 0, 0);
    canvas.toBlob(blob => resolve(blob), "image/jpeg", 0.85);
  });
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
