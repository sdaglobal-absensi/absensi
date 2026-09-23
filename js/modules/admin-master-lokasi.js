import { supabase } from "../supabaseClient.js";
import { toast, getPosition } from "../core.js";

export async function render(container, user) {
  const canEdit = true; // siapa pun yang sampai ke sini sudah lolos guard permission menu ini

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
      <div class="modal-box modal-box-lg">
        <h3 id="modal-title">Tambah Lokasi</h3>
        <form id="form-lokasi">
          <input type="hidden" name="id">
          <div class="form-row">
            <label>Nama Kantor/Cabang <input name="name" required placeholder="Contoh: Kantor Cabang Malang"></label>
          </div>

          <button type="button" id="btn-use-current" class="btn-secondary" style="margin-bottom:14px;">📍 Gunakan Lokasi Saya Sekarang</button>
          <p class="small muted field-hint" style="margin-top:-10px;">Praktis kalau kamu sedang berada di lokasi kantor tersebut. Atau isi manual di bawah — cari koordinat lewat Google Maps (klik kanan titik di peta → koordinat langsung tersalin).</p>

          <div class="form-row two-col">
            <label>Latitude <input type="text" inputmode="decimal" name="lat" required placeholder="-7.257472"></label>
            <label>Longitude <input type="text" inputmode="decimal" name="lng" required placeholder="112.752088"></label>
          </div>
          <div class="form-row">
            <label>Radius Toleransi (meter) <input type="number" name="radius_meters" min="10" step="10" value="150" required></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif dipakai</label>
          </div>
          <div class="modal-actions" style="justify-content:space-between;">
            <button type="button" id="btn-delete" class="btn-secondary hidden" style="color:var(--danger); border-color:var(--danger);">Hapus</button>
            <div style="display:flex; gap:10px; margin-left:auto;">
              <button type="button" id="btn-cancel-modal" class="btn-secondary">Batal</button>
              <button type="submit" class="btn-primary">Simpan</button>
            </div>
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
    document.getElementById("btn-delete").addEventListener("click", onDelete);
  }

  loadTable();
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
  document.getElementById("modal-title").textContent = existing ? "Edit Lokasi" : "Tambah Lokasi";
  document.getElementById("btn-delete").classList.toggle("hidden", !existing);

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

async function onDelete() {
  const id = document.querySelector('#form-lokasi input[name="id"]').value;
  if (!id) return;
  if (!confirm("Hapus lokasi ini? Karyawan yang absen dekat lokasi ini nantinya tidak akan tervalidasi terhadap titik ini lagi.")) return;

  try {
    const { error } = await supabase.from("office_locations").delete().eq("id", id);
    if (error) throw error;
    toast("Lokasi dihapus", "success");
    closeModal();
    loadTable();
  } catch (err) {
    toast("Gagal menghapus: " + err.message, "error");
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");

  const lat = parseFloat(String(fd.get("lat")).replace(",", "."));
  const lng = parseFloat(String(fd.get("lng")).replace(",", "."));
  if (isNaN(lat) || isNaN(lng)) {
    toast("Latitude/Longitude harus berupa angka, contoh: -7.257472", "error");
    return;
  }

  const payload = {
    name: fd.get("name"),
    lat,
    lng,
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
