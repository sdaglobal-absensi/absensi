import { supabase } from "../supabaseClient.js";
import { toast, uploadPhoto, roleLabel, fmtDateTime, confirmDialog, lamaBekerja, updateSidebarAvatar, avatarHTML, fmtRupiah } from "../core.js";
import {
  OPT_JENIS_KELAMIN, OPT_STATUS_NIKAH, ptkpNominal, personalFieldsHtml, familySectionHtml, wireFamilyForm, fillBiodataForm,
  setChildren, readBiodataForm, readChildren, loadChildren, saveChildren, displayProfileValue,
} from "../biodata.js";

// Field administratif/legal (payroll, BPJS, dokumen resmi) — TIDAK bisa
// diedit langsung oleh siapa pun lewat halaman Profil Saya, cuma bisa
// mengajukan lewat profile_change_requests, baru diterapkan setelah
// disetujui admin (lihat admin-profil-approval.js).
// Alamat sesuai KTP, jenis kelamin, tempat lahir, dan tanggal lahir juga
// masuk daftar ini karena datanya mengacu ke KTP. Status pernikahan juga
// harus lewat pengajuan karena menentukan PTKP (pajak). Field lain di
// biodata (pendidikan, agama, orang tua, pasangan, anak) bisa diubah
// langsung — lihat form-quick di bawah.
// Field penempatan (staffOnly: true) malah tidak boleh diajukan sama sekali
// dari sini oleh siapa pun — apapun rolenya (termasuk Super Admin/Super
// Admin HR/Admin HR yang login dan melihat profilnya sendiri) cuma bisa
// lihat & diarahkan "Hubungi Admin/HR", sama seperti baris Kode
// Karyawan/Role/Status Karyawan di bawah. Perubahan field ini cuma bisa
// lewat halaman Data Karyawan (admin-karyawan.js).
const REQUESTABLE_FIELDS = [
  { key: "full_name", label: "Nama Lengkap" },
  { key: "nik_ktp", label: "NIK KTP" },
  { key: "npwp", label: "NPWP" },
  { key: "alamat_ktp", label: "Alamat Sesuai KTP" },
  { key: "jenis_kelamin", label: "Jenis Kelamin", type: "select", options: OPT_JENIS_KELAMIN },
  { key: "tempat_lahir", label: "Tempat Lahir" },
  { key: "tanggal_lahir", label: "Tanggal Lahir", type: "date" },
  { key: "status_pernikahan", label: "Status Pernikahan", type: "select", options: OPT_STATUS_NIKAH },
  { key: "unit_pt", label: "Unit / PT", staffOnly: true },
  { key: "lokasi_kerja", label: "Lokasi Kerja / Area", staffOnly: true },
  { key: "department", label: "Departemen", staffOnly: true },
  { key: "bagian", label: "Bagian", staffOnly: true },
  { key: "position", label: "Jabatan", staffOnly: true },
  { key: "level", label: "Level", staffOnly: true,
    display: p => (p.level ? (p.grade ? `${p.level} (Grade ${p.grade})` : p.level) : "-") },
];

// "K/2 — Rp63.000.000/tahun". Kodenya diisi otomatis oleh database.
function ptkpText(kode) {
  const nominal = ptkpNominal(kode);
  return kode ? `${kode} — ${fmtRupiah(nominal)}/tahun` : "-";
}

let currentUser = null;
let currentProfile = null;
// ID anak yang sudah tersimpan — dipakai saat simpan untuk tahu anak mana yang dihapus dari form.
let originalChildIds = [];

export async function render(container, user) {
  currentUser = user;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  currentProfile = profile || user;

  let children = [];
  try {
    children = await loadChildren(supabase, user.id);
  } catch (err) {
    throw new Error("Gagal memuat data anak: " + err.message + " (pastikan supabase-schema.sql terbaru sudah dijalankan)");
  }
  originalChildIds = children.map(c => c.id);

  container.innerHTML = `
    <div class="page-header"><h1>Profil Saya</h1></div>

    <div class="card profil-header-card">
      <div class="profil-avatar-wrap">
        <div class="profil-avatar" id="profil-avatar">
          ${avatarHTML(currentProfile, "Foto profil")}
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
    <form id="form-quick" class="card form-card form-card-wide">
      <div class="form-row two-col">
        <label>No. HP <input name="phone" value="${escapeAttr(currentProfile.phone || "")}"></label>
        <label>Alamat Domisili <input name="alamat" value="${escapeAttr(currentProfile.alamat || "")}"></label>
      </div>
      ${personalFieldsHtml({ includeIdentity: false })}
      ${familySectionHtml({ includeStatus: false })}
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
              <td data-label="Nilai Saat Ini">${escapeHtml(f.display ? f.display(currentProfile) : displayProfileValue(f.key, currentProfile[f.key]))}</td>
              <td data-label="Aksi">${!f.staffOnly
                ? `<button type="button" class="btn-link btn-ajukan" data-key="${f.key}" data-label="${escapeAttr(f.label)}">Ajukan Perubahan</button>`
                : `<span class="muted small">Hubungi Admin/HR</span>`}</td>
            </tr>
          `).join("")}
          <tr>
            <td data-label="Field">PTKP</td>
            <td data-label="Nilai Saat Ini" id="profil-ptkp">${escapeHtml(ptkpText(currentProfile.ptkp))}</td>
            <td data-label="Aksi" class="muted small">Otomatis dari status pernikahan &amp; jumlah anak</td>
          </tr>
          <tr>
            <td data-label="Field">Kode Karyawan / Role / Status Karyawan</td>
            <td data-label="Nilai Saat Ini" class="muted small">${escapeHtml(currentProfile.employee_code || "-")} • ${roleLabel(currentProfile.role)} • ${escapeHtml(currentProfile.status_karyawan || "-")}</td>
            <td data-label="Aksi" class="muted small">Hubungi Admin/HR</td>
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
          <div id="ajukan-new-slot"></div>
          <label>Alasan / Keterangan <textarea name="reason" rows="3" required placeholder="Contoh: NIK KTP salah ketik waktu input awal"></textarea></label>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-ajukan" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Kirim Pengajuan</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const formQuick = document.getElementById("form-quick");
  formQuick.addEventListener("submit", saveQuickFields);
  wireFamilyForm(formQuick);
  fillBiodataForm(formQuick, currentProfile, children);
  document.getElementById("input-photo").addEventListener("change", uploadNewPhoto);
  document.querySelectorAll(".btn-ajukan").forEach(btn => {
    btn.addEventListener("click", () => openAjukanModal(btn.dataset.key, btn.dataset.label));
  });
  document.getElementById("btn-cancel-ajukan").addEventListener("click", closeAjukanModal);
  document.getElementById("form-ajukan").addEventListener("submit", submitAjukan);

  loadRequests();
}

// =====================================================================
// EDIT LANGSUNG — no HP, alamat domisili, pendidikan, agama, status
// pernikahan & biodata keluarga (policy "profiles_update_self" di Supabase
// sudah mengizinkan user mengubah kolom miliknya sendiri; data anak lewat
// policy employee_children_write_self).
// =====================================================================
async function saveQuickFields(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  const payload = {
    phone: form.phone.value.trim(),
    alamat: form.alamat.value.trim(),
    ...readBiodataForm(form),
  };
  const children = readChildren(form);
  btn.disabled = true;
  try {
    const { error } = await supabase.from("profiles").update(payload).eq("id", currentUser.id);
    if (error) throw error;
    Object.assign(currentProfile, payload);

    try {
      await saveChildren(supabase, currentUser.id, children, originalChildIds);
    } catch (childErr) {
      throw new Error("Data pribadi sudah tersimpan, tapi data anak gagal disimpan: " + childErr.message);
    }
    // Muat ulang daftar anak supaya baris baru punya ID (kalau tidak, simpan
    // kedua kalinya akan menambah anak yang sama lagi).
    const fresh = await loadChildren(supabase, currentUser.id);
    originalChildIds = fresh.map(c => c.id);
    setChildren(form, fresh);

    // PTKP dihitung ulang oleh database setiap data anak berubah — ambil
    // nilai terbarunya supaya baris PTKP di tabel "Data Lain" tidak basi.
    const { data: prof } = await supabase.from("profiles").select("ptkp").eq("id", currentUser.id).single();
    if (prof) {
      currentProfile.ptkp = prof.ptkp;
      document.getElementById("profil-ptkp").textContent = ptkpText(prof.ptkp);
    }
    toast("Data berhasil disimpan", "success");
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
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
    currentUser.photo_url = url;
    document.getElementById("profil-avatar").innerHTML = `<img src="${escapeAttr(url)}" alt="Foto profil">`;
    updateSidebarAvatar(currentUser);
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
  const field = REQUESTABLE_FIELDS.find(f => f.key === key);
  form.field_key.value = key;
  form.field_label.value = label;
  // Kontrol input menyesuaikan jenis field: teks biasa, tanggal, atau pilihan.
  // Nilai yang dikirim tetap nilai internal (mis. "laki_laki", "1990-08-17")
  // karena persis itu yang nanti ditulis ke tabel profiles saat disetujui.
  document.getElementById("ajukan-new-slot").innerHTML = `<label>Nilai Baru yang Benar ${newValueControlHtml(field)}</label>`;
  form.reason.value = "";
  document.getElementById("ajukan-old").value = displayProfileValue(key, currentProfile[key]);
  document.getElementById("ajukan-title").textContent = `Ajukan Perubahan — ${label}`;
  modal.classList.remove("hidden");
}
function newValueControlHtml(field) {
  if (field?.type === "select") {
    return `<select name="new_value" required>
      <option value="">— Pilih —</option>
      ${field.options.map(o => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join("")}
    </select>`;
  }
  if (field?.type === "date") {
    return `<input type="date" name="new_value" max="${new Date().toISOString().slice(0, 10)}" required>`;
  }
  return `<input name="new_value" required>`;
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
            <td data-label="Dari" class="muted">${escapeHtml(displayProfileValue(r.field_key, r.old_value))}</td>
            <td data-label="Menjadi">${escapeHtml(displayProfileValue(r.field_key, r.new_value))}</td>
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
