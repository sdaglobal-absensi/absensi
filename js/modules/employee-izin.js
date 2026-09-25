import { supabase } from "../supabaseClient.js";
import { toast, fmtDate } from "../core.js";
import {
  esc, fetchSteps, stepsHTML, rejectionReason, openRevisionModal, submitErrorMessage,
} from "../approvalHelper.js";
import { chainOf, employeeActionsHTML, employeeStatusTag, openChainModal } from "../requestHistory.js";
import { fetchSpecialLeaveRules, fetchMyLeaveBalance, addDays, leaveTypeLabel } from "../leaveRules.js";

// Pengajuan Izin karyawan. Pengajuan yang DITOLAK punya tombol "Ajukan Ulang"
// yang membuka popup berisi form terisi data lama. Hasilnya terkirim sebagai
// pengajuan BARU (menaut lewat revision_of); pengajuan lama tidak diubah,
// jadi riwayat ditolak/disetujui tetap tercatat semua.
//
// Jenis "Cuti" punya 2 kategori:
//   - Cuti Tahunan : tanggal diisi manual, dipotong dari saldo tahunan
//                    (lihat js/leaveRules.js & menu Kuota Cuti Tahunan).
//   - Cuti Khusus  : pilih salah satu dari 7 jenis; jumlah hari & tanggal
//                    selesai otomatis terhitung dari master (read-only),
//                    tidak memotong saldo cuti tahunan. Tetap lewat
//                    approval seperti biasa.
let current = { data: [], steps: {}, rules: [], userId: null };

// Isi form (dipakai form utama & popup revisi) — nama field harus sama.
function fieldsHTML() {
  return `
  <div class="form-row">
    <label>Jenis
      <select name="type" required>
        <option value="izin">Izin Tidak Masuk</option>
        <option value="sakit">Sakit</option>
        <option value="cuti">Cuti</option>
      </select>
    </label>
  </div>
  <div class="form-row cuti-only hidden">
    <label>Kategori Cuti
      <select name="leave_category">
        <option value="">— Pilih kategori —</option>
        <option value="tahunan">Cuti Tahunan</option>
        <option value="khusus">Cuti Khusus</option>
      </select>
    </label>
  </div>
  <div class="form-row kategori-tahunan hidden">
    <p class="muted small saldo-info" style="margin:0;">Sisa Cuti Tahunan: <strong class="saldo-value">memuat…</strong></p>
  </div>
  <div class="form-row kategori-khusus hidden">
    <label>Jenis Cuti Khusus
      <select name="special_leave_code">
        <option value="">— Pilih jenis —</option>
        ${current.rules.map(r => `<option value="${esc(r.kode)}">${esc(r.label)} (${r.jumlah_hari} hari)</option>`).join("")}
      </select>
    </label>
  </div>
  <div class="form-row two-col">
    <label>Tanggal mulai <input type="date" name="start_date" required></label>
    <label>Tanggal selesai <input type="date" name="end_date" required></label>
  </div>
  <div class="form-row">
    <label>Alasan <textarea name="reason" rows="3" required placeholder="Jelaskan alasan pengajuan"></textarea></label>
  </div>`;
}

// Pasang logic tampil/sembunyi & hitung otomatis untuk kategori cuti.
// Dipanggil setelah form (utama atau popup revisi) disisipkan ke DOM.
function wireDynamicLeaveForm(form) {
  const typeSel = form.elements.type;
  const catWrap = form.querySelector(".cuti-only");
  const catSel = form.elements.leave_category;
  const tahunanWrap = form.querySelector(".kategori-tahunan");
  const khususWrap = form.querySelector(".kategori-khusus");
  const saldoValue = form.querySelector(".saldo-value");
  const specialSel = form.elements.special_leave_code;
  const startInput = form.elements.start_date;
  const endInput = form.elements.end_date;

  function setEndReadonly(readonly) {
    endInput.readOnly = readonly;
    endInput.classList.toggle("input-readonly", readonly);
  }

  function recomputeEndDate() {
    const rule = current.rules.find(r => r.kode === specialSel.value);
    endInput.value = rule && startInput.value ? addDays(startInput.value, rule.jumlah_hari - 1) : "";
  }

  async function loadSaldoInfo() {
    if (!current.userId) return;
    saldoValue.textContent = "memuat…";
    const bal = await fetchMyLeaveBalance(current.userId);
    saldoValue.textContent = bal
      ? `${Math.max(0, bal.kuota_hari - bal.terpakai_hari)} hari (dari kuota ${bal.kuota_hari} hari/tahun)`
      : "belum diatur admin — hubungi HR";
  }

  function updateSubcategory() {
    const cat = catSel.value;
    tahunanWrap.classList.toggle("hidden", cat !== "tahunan");
    khususWrap.classList.toggle("hidden", cat !== "khusus");
    specialSel.required = cat === "khusus";
    if (cat === "khusus") {
      setEndReadonly(true);
      recomputeEndDate();
    } else {
      setEndReadonly(false);
    }
    if (cat === "tahunan") loadSaldoInfo();
  }

  function updateCategoryVisibility() {
    const isCuti = typeSel.value === "cuti";
    catWrap.classList.toggle("hidden", !isCuti);
    catSel.required = isCuti;
    if (!isCuti) {
      catSel.value = "";
      tahunanWrap.classList.add("hidden");
      khususWrap.classList.add("hidden");
      specialSel.required = false;
      setEndReadonly(false);
    } else {
      updateSubcategory();
    }
  }

  typeSel.addEventListener("change", updateCategoryVisibility);
  catSel.addEventListener("change", updateSubcategory);
  specialSel.addEventListener("change", recomputeEndDate);
  startInput.addEventListener("change", () => { if (catSel.value === "khusus") recomputeEndDate(); });

  updateCategoryVisibility(); // status awal (form baru / nilai revisi yang sudah diisi)
}

// Validasi + kirim. Mengembalikan true kalau berhasil.
async function submitRequest(fd, user, revisionOf) {
  if (fd.get("end_date") < fd.get("start_date")) {
    toast("Tanggal selesai tidak boleh lebih awal dari tanggal mulai", "error");
    return false;
  }
  const type = fd.get("type");
  if (type === "cuti" && !fd.get("leave_category")) {
    toast("Pilih kategori cuti terlebih dahulu", "error");
    return false;
  }
  if (type === "cuti" && fd.get("leave_category") === "khusus" && !fd.get("special_leave_code")) {
    toast("Pilih jenis cuti khusus terlebih dahulu", "error");
    return false;
  }

  const payload = {
    user_id: user.id,
    type,
    start_date: fd.get("start_date"),
    end_date: fd.get("end_date"),
    reason: fd.get("reason"),
  };
  if (type === "cuti") {
    payload.leave_category = fd.get("leave_category");
    payload.special_leave_code = payload.leave_category === "khusus" ? fd.get("special_leave_code") : null;
  }
  if (revisionOf) payload.revision_of = revisionOf;

  const { error } = await supabase.from("leave_requests").insert(payload);
  if (error) {
    toast(submitErrorMessage(error), "error");
    if (revisionOf) loadList(user); // mis. sudah pernah diajukan ulang -> segarkan riwayat
    return false;
  }
  toast(revisionOf ? "Pengajuan ulang terkirim, menunggu approval" : "Pengajuan terkirim, menunggu approval", "success");
  loadList(user);
  return true;
}

export async function render(container, user) {
  current.userId = user.id;
  current.rules = await fetchSpecialLeaveRules();

  container.innerHTML = `
    <div class="page-header">
      <h1>Pengajuan Izin</h1>
      <p class="muted">Ajukan izin tidak masuk, sakit, atau cuti</p>
    </div>

    <form id="form-izin" class="card form-card">
      ${fieldsHTML()}
      <button type="submit" class="btn-primary btn-block">Kirim Pengajuan</button>
    </form>

    <h2 class="section-title">Riwayat Pengajuan</h2>
    <div id="izin-list" class="table-wrap"><p class="muted">Memuat…</p></div>
  `;

  const form = document.getElementById("form-izin");
  wireDynamicLeaveForm(form);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (await submitRequest(new FormData(form), user, null)) {
      form.reset();
      wireDynamicLeaveForm(form); // reset ulang tampilan field dinamis
    }
  });

  loadList(user);
}

function startRevision(id, user) {
  const r = current.data.find(x => x.id === id);
  if (!r) return;
  openRevisionModal({
    title: "Ajukan Ulang",
    subtitle: `${leaveTypeLabel(r, current.rules)} · ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`,
    reason: rejectionReason(r, current.steps[r.id]),
    fieldsHTML: fieldsHTML(),
    values: {
      type: r.type, leave_category: r.leave_category || "", special_leave_code: r.special_leave_code || "",
      start_date: r.start_date, end_date: r.end_date, reason: r.reason,
    },
    onMount: wireDynamicLeaveForm,
    onSubmit: fd => submitRequest(fd, user, r.id),
  });
}

async function loadList(user) {
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const el = document.getElementById("izin-list");
  if (!el) return;
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data.</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada pengajuan.</p>`; return; }

  const steps = await fetchSteps("leave", data.map(r => r.id));
  current = { ...current, data, steps };
  // Satu baris per "rantai" pengajuan: hanya yang TERBARU. Pengajuan lama yang
  // sudah diajukan ulang tidak jadi baris sendiri — dibuka lewat tombol "Riwayat".
  const heads = data.filter(r => !data.some(x => x.revision_of === r.id));
  el.innerHTML = `
    <table class="table">
      <thead><tr><th>Jenis</th><th>Periode</th><th>Alasan</th><th>Status</th><th>Tahap Approval</th><th></th></tr></thead>
      <tbody>
        ${heads.map(r => {
          const n = chainOf(data, r).length;
          return `
          <tr>
            <td>${esc(leaveTypeLabel(r, current.rules))}</td>
            <td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
            <td>${esc(r.reason)}</td>
            <td>
              <span class="badge ${badgeClass(r.status)}">${statusLabel(r.status)}</span>
              ${employeeStatusTag(n)}
            </td>
            <td>${stepsHTML(r, steps[r.id])}</td>
            <td>${employeeActionsHTML(r, n)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll(".btn-revisi").forEach(b => b.addEventListener("click", () => startRevision(b.dataset.id, user)));
  el.querySelectorAll(".btn-hist").forEach(b => b.addEventListener("click", () => {
    const r = data.find(x => x.id === b.dataset.id);
    if (r) openChainModal("Riwayat Pengajuan Izin", data, r, steps, describe);
  }));
}

// Ringkasan satu pengajuan izin untuk daftar riwayat.
function describe(r) {
  return `${esc(leaveTypeLabel(r, current.rules))} · ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}<div class="hist-reason">${esc(r.reason)}</div>`;
}

function badgeClass(s) {
  return { pending: "badge-warn", approved: "badge-ok", rejected: "badge-danger", dibatalkan: "badge-muted" }[s] || "badge-warn";
}

function statusLabel(s) {
  return { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak", dibatalkan: "Dibatalkan" }[s] || s;
}
