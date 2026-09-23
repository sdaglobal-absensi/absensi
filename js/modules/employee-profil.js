import { supabase } from "../supabaseClient.js";
import { toast, uploadPhoto, roleLabel, fmtDateTime, confirmDialog, lamaBekerja, STAFF_ROLES } from "../core.js";

// Field administratif/legal (payroll, BPJS, dokumen resmi) — karyawan TIDAK
// bisa edit langsung, cuma bisa mengajukan lewat profile_change_requests,
// baru diterapkan setelah disetujui admin (lihat admin-profil-approval.js).
// Field penempatan (staffOnly: true) malah tidak boleh diajukan sama sekali
// oleh role "karyawan" biasa — cuma Super Admin/Super Admin HR/Admin HR
// (STAFF_ROLES) yang boleh mengajukan perubahannya sendiri; karyawan lain
// cuma bisa lihat & diarahkan menghubungi Super Admin/HR, sama seperti
// baris Kode Karyawan/Role/Status Karyawan di bawah.
const REQUESTABLE_FIELDS = [
  { key: "full_name", label: "Nama Lengkap" },
  { key: "nik_ktp", label: "NIK KTP" },
  { key: "npwp", label: "NPWP" },
  { key: "unit_pt", label: "Unit / PT", staffOnly: true },
  { key: "lokasi_kerja", label: "Lokasi Kerja / Area", staffOnly: true },
  { key: "department", label: "Departemen", staffOnly: true },
  { key: "bagian", label: "Bagian", staffOnly: true },
  { key: "position", label: "Jabatan", staffOnly: true },
];

let currentUser = null;
let currentProfile = null;

export async function render(container, user) {
  currentUser = user;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  currentProfile = profile || user;

  container.innerHTML = `
    <div class="page-header"><h1>Profil Saya</h1></div>

    <div class="card profil-header-card">
      <div class="profil-avatar-wrap">
        <div class="profil-avatar" id="profil-avatar">
          ${currentProfile.photo_url ? `<img src="${escapeAttr(currentProfile.photo_url)}" alt="Foto profil">` : initials(currentProfile.full_name)}
        </div>
        <label class="btn-secondary btn-photo-upload">
          Ganti Foto
          <input type="file" id="input-photo" accept="image/*" class="hidden">
        </label>
      </div>
      <div class="profil-header-info">
        <h2>${escapeHtml(currentProfile.full_name)}</h2>
        <span class="badge badge-ok">${roleLabel(currentProfile.role)}</span>
        <p class="muted small" style="margin-top:8px;">
          ${escapeHtml(currentProfile.employee_code || "-")} • ${escapeHtml(currentProfile.email || "-")}<br>
          Bergabung sejak ${currentProfile.join_date ? new Date(currentProfile.join_date).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }) : "-"}
          (${lamaBekerja(currentProfile.join_date)})
        </p>
      </div>
    </div>

    <h2 class="section-title">Data yang Bisa Diubah Langsung</h2>
    <form id="form-quick" class="card form-card">
      <div class="form-row two-col">
        <label>No. HP <input name="phone" value="${escapeAttr(currentProfile.phone || "")}"></label>
        <label>Alamat <input name="alamat" value="${escapeAttr(currentProfile.alamat || "")}"></label>
      </div>
      <button type="submit" class="btn-primary">Simpan Perubahan</button>
    </form>

    <h2 class="section-title">Data Lain</h2>
    <p class="muted small" style="margin-top:-8px;">
      Field di bawah ini terkait payroll, BPJS, dan dokumen resmi, jadi tidak bisa diubah langsung.
      Kalau ada yang salah, klik <strong>Ajukan Perubahan</strong> — perubahan baru berlaku setelah disetujui admin.
    </p>
    <div class="table-wrap">
      <table class="table table-responsive-stack">
        <thead><tr><th>Field</th><th>Nilai Saat Ini</th><th>Aksi</th></tr></thead>
        <tbody>
          ${REQUESTABLE_FIELDS.map(f => `
            <tr>
              <td data-label="Field">${f.label}</td>
              <td data-label="Nilai Saat Ini">${escapeHtml(currentProfile[f.key] || "-")}</td>
              <td data-label="Aksi">${(!f.staffOnly || STAFF_ROLES.includes(currentUser.role))
                ? `<button type="button" class="btn-link btn-ajukan" data-key="${f.key}" data-label="${escapeAttr(f.label)}">Ajukan Perubahan</button>`
                : `<span class="muted small">Hubungi Super Admin/HR</span>`}</td>
            </tr>
          `).join("")}
          <tr>
            <td data-label="Field">Kode Karyawan / Role / Status Karyawan</td>
            <td data-label="Nilai Saat Ini" class="muted small">${escapeHtml(currentProfile.employee_code || "-")} • ${roleLabel(currentProfile.role)} • ${escapeHtml(currentProfile.status_karyawan || "-")}</td>
            <td data-label="Aksi" class="muted small">Hubungi Super Admin/HR</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-title">Riwayat Pengajuan Perubahan Data</h2>
    <div id="pcr-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    <div id="modal-ajukan" class="modal hidden">
      <div class="modal-box">
        <h3 id="ajukan-title">Ajukan Perubahan</h3>
        <form id="form-ajukan">
          <input type="hidden" name="field_key">
          <input type="hidden" name="field_label">
          <label>Nilai Saat Ini <input id="ajukan-old" disabled></label>
          <label>Nilai Baru yang Benar <input name="new_value" required></label>
          <label>Alasan / Keterangan <textarea name="reason" rows="3" required placeholder="Contoh: NIK KTP salah ketik waktu input awal"></textarea></label>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-ajukan" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Kirim Pengajuan</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("form-quick").addEventListener("submit", saveQuickFields);
  document.getElementById("input-photo").addEventListener("change", uploadNewPhoto);
  document.querySelectorAll(".btn-ajukan").forEach(btn => {
    btn.addEventListener("click", () => openAjukanModal(btn.dataset.key, btn.dataset.label));
  });
  document.getElementById("btn-cancel-ajukan").addEventListener("click", closeAjukanModal);
  document.getElementById("form-ajukan").addEventListener("submit", submitAjukan);

  loadRequests();
}

// =====================================================================
// EDIT LANGSUNG — no HP & alamat (policy "profiles_update_self" di
// Supabase sudah mengizinkan user mengubah kolom miliknya sendiri).
// =====================================================================
async function saveQuickFields(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  const { error } = await supabase
    .from("profiles")
    .update({ phone: form.phone.value.trim(), alamat: form.alamat.value.trim() })
    .eq("id", currentUser.id);
  btn.disabled = false;
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }
  toast("Data berhasil disimpan", "success");
}

async function uploadNewPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  toast("Mengunggah foto…", "info");
  try {
    const url = await uploadPhoto(file, `profile-photos/${currentUser.id}`);
    const { error } = await supabase.from("profiles").update({ photo_url: url }).eq("id", currentUser.id);
    if (error) throw error;
    currentProfile.photo_url = url;
    document.getElementById("profil-avatar").innerHTML = `<img src="${escapeAttr(url)}" alt="Foto profil">`;
    toast("Foto profil berhasil diperbarui", "success");
  } catch (err) {
    toast("Gagal mengunggah foto: " + err.message, "error");
  } finally {
    e.target.value = "";
  }
}

// =====================================================================
// PENGAJUAN PERUBAHAN DATA (field sensitif — butuh approval admin)
// =====================================================================
function openAjukanModal(key, label) {
  const modal = document.getElementById("modal-ajukan");
  const form = document.getElementById("form-ajukan");
  form.field_key.value = key;
  form.field_label.value = label;
  form.new_value.value = "";
  form.reason.value = "";
  document.getElementById("ajukan-old").value = currentProfile[key] || "-";
  document.getElementById("ajukan-title").textContent = `Ajukan Perubahan — ${label}`;
  modal.classList.remove("hidden");
}
function closeAjukanModal() {
  document.getElementById("modal-ajukan").classList.add("hidden");
}

async function submitAjukan(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  const payload = {
    user_id: currentUser.id,
    field_key: form.field_key.value,
    field_label: form.field_label.value,
    old_value: currentProfile[form.field_key.value] || null,
    new_value: form.new_value.value.trim(),
    reason: form.reason.value.trim(),
  };
  if (!payload.new_value || !payload.reason) return;
  btn.disabled = true;
  const { error } = await supabase.from("profile_change_requests").insert(payload);
  btn.disabled = false;
  if (error) { toast("Gagal mengirim pengajuan: " + error.message, "error"); return; }
  toast("Pengajuan perubahan data terkirim, menunggu approval admin.", "success");
  closeAjukanModal();
  loadRequests();
}

async function loadRequests() {
  const { data, error } = await supabase
    .from("profile_change_requests")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("pcr-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat riwayat.</p>`; return; }
  if (!data || !data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan perubahan data.</p>`; return; }

  el.innerHTML = `
    <table class="table table-responsive-stack">
      <thead><tr><th>Field</th><th>Dari</th><th>Menjadi</th><th>Status</th><th>Diajukan</th><th>Aksi</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td data-label="Field">${escapeHtml(r.field_label)}</td>
            <td data-label="Dari" class="muted">${escapeHtml(r.old_value || "-")}</td>
            <td data-label="Menjadi">${escapeHtml(r.new_value)}</td>
            <td data-label="Status"><span class="badge badge-${statusTone(r.status)}">${statusLabel(r.status)}</span></td>
            <td data-label="Diajukan" class="muted small">${fmtDateTime(r.created_at)}</td>
            <td data-label="Aksi">${r.status === "pending" ? `<button type="button" class="btn-link btn-batal" data-id="${r.id}">Batalkan</button>` : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll(".btn-batal").forEach(btn => {
    btn.addEventListener("click", () => batalkanRequest(btn.dataset.id));
  });
}

async function batalkanRequest(id) {
  const ok = await confirmDialog({
    title: "Batalkan Pengajuan?",
    message: "Pengajuan perubahan data ini akan dibatalkan dan dihapus.",
    confirmLabel: "Ya, Batalkan",
    confirmClass: "btn-primary",
  });
  if (!ok) return;
  const { error } = await supabase.from("profile_change_requests").delete().eq("id", id);
  if (error) { toast("Gagal membatalkan: " + error.message, "error"); return; }
  toast("Pengajuan dibatalkan", "success");
  loadRequests();
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" }[s] || s;
}
function statusTone(s) {
  return { pending: "warn", approved: "ok", rejected: "danger" }[s] || "warn";
}
function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
