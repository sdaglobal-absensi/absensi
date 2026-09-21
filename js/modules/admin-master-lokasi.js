import { supabase } from "../supabaseClient.js";
import { toast, getPosition, searchLocation } from "../core.js";

export async function render(container, user) {
  const canEdit = user.role === "admin";

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Lokasi Kantor</h1>
        <p class="muted">Titik koordinat & radius tiap kantor/cabang — dipakai untuk memvalidasi lokasi GPS saat karyawan check-in/check-out. Bisa lebih dari satu kantor.</p>
      </div>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Lokasi</button>` : ""}
    </div>
    <div id="lokasi-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-lokasi" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Tambah Lokasi</h3>
        <form id="form-lokasi">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Nama Kantor/Cabang <input name="name" required placeholder="Contoh: Kantor Cabang Malang"></label>
          </div>

          <div class="form-section-label">Isi Koordinat</div>

          <button type="button" id="btn-use-current" class="btn-secondary" style="margin-bottom:6px;">📍 Gunakan Lokasi Saya Sekarang</button>
          <p class="small muted field-hint">Paling akurat kalau kamu sedang berada di lokasi kantor tersebut.</p>

          <p class="small" style="margin:14px 0 8px;">Atau cari di Google Maps &amp; salin koordinatnya:</p>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <input type="text" id="location-search" placeholder="Contoh: SDA Global Semarang">
            <button type="button" id="btn-open-maps" class="btn-secondary" style="white-space:nowrap;">Buka Google Maps ↗</button>
          </div>
          <ol class="small muted" style="margin:0 0 16px; padding-left:18px; line-height:1.7;">
            <li>Tab baru terbuka, cari lokasinya di sana</li>
            <li>Klik-kanan titik lokasi di peta → klik angka koordinat yang muncul (otomatis tersalin)</li>
            <li>Tempel di kolom Latitude &amp; Longitude di bawah ini</li>
          </ol>

          <details style="margin-bottom:16px;">
            <summary class="small" style="cursor:pointer; color:var(--primary); font-weight:600;">Coba cari otomatis di sini (opsional, database terbatas)</summary>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <input type="text" id="location-search-osm" placeholder="Cari nama tempat/alamat…">
              <button type="button" id="btn-search-location" class="btn-secondary" style="white-space:nowrap;">Cari</button>
            </div>
            <div id="search-results" class="location-search-results hidden"></div>
          </details>

          <div class="form-row two-col">
            <label>Latitude <input type="number" name="lat" step="0.000001" required placeholder="-7.257472"></label>
            <label>Longitude <input type="number" name="lng" step="0.000001" required placeholder="112.752088"></label>
          </div>
          <div class="form-row">
            <label>Radius Toleransi (meter) <input type="number" name="radius_meters" min="10" step="10" value="150" required></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif dipakai</label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
    ` : ""}
  `;

  if (canEdit) {
    document.getElementById("btn-new").addEventListener("click", () => openModal());
    document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
    document.getElementById("form-lokasi").addEventListener("submit", onSubmit);
    document.getElementById("btn-use-current").addEventListener("click", useCurrentLocation);
    document.getElementById("btn-open-maps").addEventListener("click", openInGoogleMaps);
    document.getElementById("location-search").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); openInGoogleMaps(); }
    });
    document.getElementById("btn-search-location").addEventListener("click", doLocationSearch);
    document.getElementById("location-search-osm").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); doLocationSearch(); }
    });
  }

  loadTable();
}

function openInGoogleMaps() {
  const q = document.getElementById("location-search").value.trim();
  const nameField = document.querySelector('#form-lokasi input[name="name"]').value.trim();
  const query = q || nameField;
  if (!query) { toast("Isi nama lokasi yang mau dicari dulu", "error"); return; }
  window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, "_blank", "noopener");
}

async function doLocationSearch() {
  const q = document.getElementById("location-search-osm").value.trim();
  const resultsEl = document.getElementById("search-results");
  if (!q) return;

  resultsEl.classList.remove("hidden");
  resultsEl.innerHTML = `<div class="search-option muted">Mencari…</div>`;

  const results = await searchLocation(q);
  if (!results.length) {
    resultsEl.innerHTML = `<div class="search-option muted">Tidak ditemukan di database ini. Pakai cara "Buka Google Maps" di atas untuk hasil yang lebih lengkap.</div>`;
    return;
  }

  resultsEl.innerHTML = results.map((r, i) => `<div class="search-option" data-i="${i}">${r.label}</div>`).join("");
  resultsEl.querySelectorAll(".search-option[data-i]").forEach(el => {
    el.addEventListener("click", () => {
      const r = results[Number(el.dataset.i)];
      const form = document.getElementById("form-lokasi");
      form.lat.value = r.lat.toFixed(6);
      form.lng.value = r.lng.toFixed(6);
      resultsEl.classList.add("hidden");
      toast("Koordinat terisi dari hasil pencarian", "success");
    });
  });
}

async function useCurrentLocation() {
  const btn = document.getElementById("btn-use-current");
  btn.disabled = true;
  btn.textContent = "Mengambil lokasi…";
  try {
    const pos = await getPosition();
    const form = document.getElementById("form-lokasi");
    form.lat.value = pos.lat.toFixed(6);
    form.lng.value = pos.lng.toFixed(6);
    toast("Koordinat lokasi saat ini terisi", "success");
  } catch (err) {
    toast(err.message, "error");
  }
  btn.disabled = false;
  btn.textContent = "📍 Gunakan Lokasi Saya Sekarang";
}

async function loadTable() {
  const { data, error } = await supabase.from("office_locations").select("*").order("name");
  const el = document.getElementById("lokasi-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada data lokasi kantor.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Nama</th><th>Koordinat</th><th>Radius</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.name}</td>
            <td>
              <a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener" class="btn-link">${r.lat}, ${r.lng}</a>
            </td>
            <td>${r.radius_meters} m</td>
            <td><span class="badge badge-${r.is_active ? "ok" : "danger"}">${r.is_active ? "Aktif" : "Nonaktif"}</span></td>
            <td><button class="btn-link btn-edit" data-id="${r.id}">Edit</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = data.find(r => r.id === btn.dataset.id);
      openModal(row);
    });
  });
}

function openModal(existing = null) {
  const modal = document.getElementById("modal-lokasi");
  const form = document.getElementById("form-lokasi");
  form.reset();
  document.getElementById("location-search").value = "";
  document.getElementById("location-search-osm").value = "";
  document.getElementById("search-results").classList.add("hidden");
  document.getElementById("search-results").innerHTML = "";
  document.getElementById("modal-title").textContent = existing ? "Edit Lokasi" : "Tambah Lokasi";

  if (existing) {
    form.id.value = existing.id;
    form.name.value = existing.name;
    form.lat.value = existing.lat;
    form.lng.value = existing.lng;
    form.radius_meters.value = existing.radius_meters;
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
    form.radius_meters.value = 150;
  }
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-lokasi").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = {
    name: fd.get("name"),
    lat: Number(fd.get("lat")),
    lng: Number(fd.get("lng")),
    radius_meters: Number(fd.get("radius_meters")),
    is_active: fd.get("is_active") === "on",
  };

  try {
    const { error } = id
      ? await supabase.from("office_locations").update(payload).eq("id", id)
      : await supabase.from("office_locations").insert(payload);
    if (error) throw error;
    toast("Lokasi kantor tersimpan", "success");
    closeModal();
    loadTable();
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
