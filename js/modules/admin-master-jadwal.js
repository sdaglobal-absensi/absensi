import { supabase } from "../supabaseClient.js";
import { toast, roleLabel, confirmDialog } from "../core.js";

const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

export async function render(container, user) {
  const canEdit = true; // siapa pun yang sampai ke sini sudah lolos guard permission menu ini

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Jadwal Kerja</h1>
        <p class="muted">Jam kerja per hari untuk tiap jadwal/shift, termasuk shift yang lintas hari (misal 22:00–06:00). Pilih karyawan mana saja yang memakai tiap jadwal langsung dari sini.</p>
      </div>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Jadwal</button>` : ""}
    </div>
    <div id="schedule-list"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-schedule" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3 id="modal-title">Tambah Jadwal</h3>
        <form id="form-schedule">
          <input type="hidden" name="id">
          <div class="form-row two-col">
            <label>Nama Jadwal <input name="name" required placeholder="Contoh: Reguler Kantor"></label>
            <label>Toleransi Telat (menit) <input type="number" name="late_tolerance_minutes" min="0" value="0" required></label>
          </div>

          <div class="form-section-label">Jam Kerja per Hari</div>
          <p class="small muted field-hint">Kalau Jam Pulang lebih kecil dari Jam Masuk, otomatis dianggap shift lintas hari (misal masuk 22:00, pulang 06:00 besok). Untuk Split Shift atau Jam Fleksibel/Long Shift yang polanya tidak sama tiap hari, isi jam per hari secara manual di tabel bawah.</p>

          <div class="shift-toolbar">
            <div class="shift-toolbar-group">
              <span class="small muted shift-toolbar-label">Hari kerja:</span>
              <button type="button" class="btn-secondary btn-sm btn-days" data-days="1,2,3,4,5">5 Hari (Sen–Jum)</button>
              <button type="button" class="btn-secondary btn-sm btn-days" data-days="1,2,3,4,5,6">6 Hari (Sen–Sab)</button>
              <button type="button" class="btn-secondary btn-sm btn-days" data-days="0,1,2,3,4,5,6">7 Hari (Semua)</button>
            </div>
          </div>
          <p class="small muted field-hint" style="margin-top:6px;">Centang hari kerjanya, lalu isi jam masuk & pulang masing-masing hari di tabel bawah.</p>

          <div class="table-wrap">
            <table class="table" id="day-grid">
              <thead><tr><th>Hari</th><th>Hari Kerja</th><th>Jam Masuk</th><th>Jam Pulang</th></tr></thead>
              <tbody>
                ${DAY_NAMES.map((name, i) => `
                  <tr>
                    <td>${name}</td>
                    <td><input type="checkbox" name="active_${i}" class="day-active"></td>
                    <td><input type="time" name="start_${i}" disabled></td>
                    <td><input type="time" name="end_${i}" disabled></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>

          <div class="form-row" style="margin-top:16px;">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif dipakai</label>
          </div>

          <div class="form-section-label">Karyawan yang Menggunakan Jadwal Ini</div>
          <div id="assigned-employee-list" class="assigned-employee-list"><p class="muted small">Memuat…</p></div>
          <div class="add-employee-area">
            <button type="button" id="btn-add-employee" class="btn-secondary btn-sm">+ Tambah Karyawan</button>
            <div id="add-employee-picker" class="hidden">
              <input type="text" id="employee-search" placeholder="Cari nama karyawan…">
              <div id="employee-search-results" class="employee-search-results"></div>
            </div>
          </div>

          <div class="modal-actions" style="justify-content:space-between;">
            <button type="button" id="btn-delete-schedule" class="btn-outline-danger hidden">Hapus Jadwal</button>
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
    document.getElementById("btn-delete-schedule").addEventListener("click", onDeleteSchedule);
    document.getElementById("form-schedule").addEventListener("submit", onSubmit);
    document.querySelectorAll(".day-active").forEach((cb, i) => {
      cb.addEventListener("change", () => toggleDayInputs(i, cb.checked));
    });
    document.getElementById("btn-add-employee").addEventListener("click", toggleAddEmployeePicker);
    document.getElementById("employee-search").addEventListener("input", e => renderEmployeeSearchResults(e.target.value));

    document.querySelectorAll(".btn-days").forEach(btn => {
      btn.addEventListener("click", () => {
        const wanted = new Set(btn.dataset.days.split(",").map(Number));
        DAY_NAMES.forEach((_, i) => {
          const form = document.getElementById("form-schedule");
          form[`active_${i}`].checked = wanted.has(i);
          toggleDayInputs(i, wanted.has(i));
        });
      });
    });
  }

  loadList(canEdit);
}

function toggleDayInputs(i, active) {
  const form = document.getElementById("form-schedule");
  form[`start_${i}`].disabled = !active;
  form[`end_${i}`].disabled = !active;
  if (!active) { form[`start_${i}`].value = ""; form[`end_${i}`].value = ""; }
}

// =====================================================================
// Karyawan yang memakai jadwal ini — konsep "tambah lalu pilih nama":
// daftar yang tampil HANYA nama yang memang sudah dipasangkan ke jadwal
// ini (bukan checklist semua karyawan seperti sebelumnya). Untuk
// menambah, klik "+ Tambah Karyawan" lalu cari & pilih namanya dari
// karyawan yang belum masuk daftar ini. Perubahan baru benar-benar
// disimpan ke database saat form di-Simpan (lihat onSubmit), supaya
// tombol Batal tetap bisa membatalkan semuanya.
// =====================================================================
let allEmployees = [];
let scheduleNameById = {};
let assignedIds = new Set();

async function loadEmployeeData(scheduleId) {
  const el = document.getElementById("assigned-employee-list");
  const [{ data: profiles, error }, { data: schedules }] = await Promise.all([
    // Tampilkan SEMUA profil aktif apa pun rolenya (karyawan, admin_hr,
    // super_admin_hr, admin_approval, super_admin) — staff dengan role
    // lain pun bisa ikut absen dan butuh jadwal kerja.
    supabase.from("profiles").select("id, full_name, employee_code, department, schedule_id, role").eq("is_active", true).order("full_name"),
    supabase.from("work_schedules").select("id, name"),
  ]);

  if (error) { el.innerHTML = `<p class="muted small">Gagal memuat daftar karyawan.</p>`; return; }
  allEmployees = profiles || [];
  scheduleNameById = Object.fromEntries((schedules || []).map(s => [s.id, s.name]));
  // Jadwal baru (belum tersimpan) belum mungkin dipakai siapa pun —
  // jangan ikut mencocokkan profil yang schedule_id-nya kosong (null).
  assignedIds = new Set(scheduleId ? allEmployees.filter(e => e.schedule_id === scheduleId).map(e => e.id) : []);

  renderAssignedList();
  renderEmployeeSearchResults("");
}

function empMetaLabel(emp) {
  return [emp.employee_code, emp.department, roleLabel(emp.role)].filter(Boolean).join(" · ");
}

function renderAssignedList() {
  const el = document.getElementById("assigned-employee-list");
  if (!el) return;
  const rows = [...assignedIds]
    .map(id => allEmployees.find(e => e.id === id))
    .filter(Boolean)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  el.innerHTML = rows.length
    ? rows.map(emp => `
        <div class="assigned-employee-row">
          <div>
            <strong>${emp.full_name}</strong>
            <div class="small muted">${empMetaLabel(emp)}</div>
          </div>
          <button type="button" class="btn-link-danger btn-remove-emp" data-id="${emp.id}">Hapus</button>
        </div>
      `).join("")
    : `<p class="muted small">Belum ada karyawan yang memakai jadwal ini.</p>`;

  el.querySelectorAll(".btn-remove-emp").forEach(btn => {
    btn.addEventListener("click", () => {
      assignedIds.delete(btn.dataset.id);
      renderAssignedList();
      renderEmployeeSearchResults(document.getElementById("employee-search")?.value || "");
    });
  });
}

function toggleAddEmployeePicker() {
  const picker = document.getElementById("add-employee-picker");
  picker.classList.toggle("hidden");
  if (!picker.classList.contains("hidden")) {
    const search = document.getElementById("employee-search");
    search.value = "";
    renderEmployeeSearchResults("");
    search.focus();
  }
}

function renderEmployeeSearchResults(query) {
  const el = document.getElementById("employee-search-results");
  if (!el) return;
  const q = query.trim().toLowerCase();
  const candidates = allEmployees.filter(e => !assignedIds.has(e.id));
  const filtered = q ? candidates.filter(e => (e.full_name || "").toLowerCase().includes(q)) : candidates;

  if (!filtered.length) {
    el.innerHTML = `<p class="muted small" style="padding:8px 2px;">${candidates.length ? "Tidak ada nama yang cocok." : "Semua karyawan aktif sudah masuk daftar ini."}</p>`;
    return;
  }

  el.innerHTML = filtered.map(emp => {
    // Satu orang cuma bisa punya satu jadwal — kalau dia sedang dipakai
    // jadwal lain, ingatkan admin bahwa memilihnya di sini akan
    // memindahkannya, bukan menambah jadwal kedua.
    const currentSchedule = emp.schedule_id ? scheduleNameById[emp.schedule_id] : null;
    return `
      <button type="button" class="employee-search-result" data-id="${emp.id}">
        <span>
          <strong>${emp.full_name}</strong>
          <span class="small muted" style="display:block;">${empMetaLabel(emp)}</span>
          ${currentSchedule ? `<span class="small" style="display:block; color:var(--warn);">Saat ini di ${currentSchedule} — akan dipindah ke jadwal ini</span>` : ""}
        </span>
        <span class="btn-link">+ Tambah</span>
      </button>
    `;
  }).join("");

  el.querySelectorAll(".employee-search-result").forEach(btn => {
    btn.addEventListener("click", () => {
      assignedIds.add(btn.dataset.id);
      renderAssignedList();
      document.getElementById("add-employee-picker").classList.add("hidden");
    });
  });
}

async function loadList(canEdit) {
  const { data: schedules, error } = await supabase.from("work_schedules").select("*").order("name");
  const el = document.getElementById("schedule-list");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!schedules.length) { el.innerHTML = `<p class="muted">Belum ada jadwal kerja.</p>`; return; }

  const { data: days } = await supabase.from("work_schedule_days").select("*");
  const { data: employees } = await supabase.from("profiles").select("id, schedule_id").eq("is_active", true);

  el.innerHTML = schedules.map(s => {
    const myDays = (days || []).filter(d => d.schedule_id === s.id).sort((a, b) => a.day_of_week - b.day_of_week);
    const empCount = (employees || []).filter(e => e.schedule_id === s.id).length;
    const ringkasan = myDays.filter(d => d.is_working_day).map(d => {
      const jam = `${(d.start_time || "").slice(0, 5)}–${(d.end_time || "").slice(0, 5)}${d.crosses_midnight ? " (+1 hari)" : ""}`;
      return `${DAY_NAMES[d.day_of_week].slice(0, 3)}: ${jam}`;
    }).join(" · ") || "Belum ada hari kerja diatur";

    return `
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="display:flex; align-items:center; gap:10px;">
              <strong>${s.name}</strong>
              <span class="badge badge-${s.is_active ? "ok" : "danger"}">${s.is_active ? "Aktif" : "Nonaktif"}</span>
              <span class="small muted">${empCount} karyawan</span>
            </div>
            <p class="small muted" style="margin:6px 0 0;">${ringkasan}</p>
            <p class="small muted" style="margin:4px 0 0;">Toleransi telat: ${s.late_tolerance_minutes} menit</p>
          </div>
          ${canEdit ? `<button class="btn-link btn-edit" data-id="${s.id}">Edit</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  if (canEdit) {
    el.querySelectorAll(".btn-edit").forEach(btn => {
      btn.addEventListener("click", async () => {
        const s = schedules.find(x => x.id === btn.dataset.id);
        const myDays = (days || []).filter(d => d.schedule_id === s.id);
        openModal(s, myDays);
      });
    });
  }
}

function openModal(existing = null, existingDays = []) {
  const modal = document.getElementById("modal-schedule");
  const form = document.getElementById("form-schedule");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Jadwal" : "Tambah Jadwal";
  document.getElementById("btn-delete-schedule").classList.toggle("hidden", !existing);
  document.getElementById("add-employee-picker").classList.add("hidden");

  DAY_NAMES.forEach((_, i) => toggleDayInputs(i, false));

  if (existing) {
    form.id.value = existing.id;
    form.name.value = existing.name;
    form.late_tolerance_minutes.value = existing.late_tolerance_minutes;
    form.is_active.checked = existing.is_active;

    existingDays.forEach(d => {
      const i = d.day_of_week;
      form[`active_${i}`].checked = d.is_working_day;
      toggleDayInputs(i, d.is_working_day);
      if (d.is_working_day) {
        form[`start_${i}`].value = (d.start_time || "").slice(0, 5);
        form[`end_${i}`].value = (d.end_time || "").slice(0, 5);
      }
    });
  } else {
    form.id.value = "";
  }
  loadEmployeeData(existing ? existing.id : null);
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-schedule").classList.add("hidden");
}

async function onDeleteSchedule() {
  const id = document.querySelector('#form-schedule input[name="id"]').value;
  if (!id) return;
  const affected = allEmployees.filter(e => e.schedule_id === id).length;
  const warning = affected
    ? `${affected} karyawan yang masih memakainya akan kehilangan jadwal kerja (tidak akan ditandai telat/tepat waktu) sampai diberi jadwal baru.`
    : "Tindakan ini tidak bisa dibatalkan.";
  const ok = await confirmDialog({ title: "Hapus jadwal ini?", message: warning, confirmLabel: "Hapus", confirmClass: "btn-danger" });
  if (!ok) return;

  try {
    // Lepas dulu karyawan yang masih memakainya, baru hapus hari kerja &
    // jadwalnya sendiri — supaya tidak ada referensi yang menggantung.
    await supabase.from("profiles").update({ schedule_id: null }).eq("schedule_id", id);
    await supabase.from("work_schedule_days").delete().eq("schedule_id", id);
    const { error } = await supabase.from("work_schedules").delete().eq("id", id);
    if (error) throw error;

    toast("Jadwal dihapus", "success");
    closeModal();
    loadList(true);
  } catch (err) {
    toast("Gagal menghapus: " + err.message, "error");
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const id = fd.get("id");

  const schedulePayload = {
    name: fd.get("name"),
    late_tolerance_minutes: Number(fd.get("late_tolerance_minutes")),
    is_active: fd.get("is_active") === "on",
  };

  try {
    let scheduleId = id;
    if (id) {
      const { error } = await supabase.from("work_schedules").update(schedulePayload).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from("work_schedules").insert(schedulePayload).select().single();
      if (error) throw error;
      scheduleId = data.id;
    }

    const dayRows = DAY_NAMES.map((_, i) => {
      const active = form[`active_${i}`].checked;
      const start = form[`start_${i}`].value || null;
      const end = form[`end_${i}`].value || null;
      const crosses = active && start && end && end < start;
      return {
        schedule_id: scheduleId,
        day_of_week: i,
        is_working_day: active,
        start_time: active ? start : null,
        end_time: active ? end : null,
        crosses_midnight: !!crosses,
      };
    });

    // Ganti seluruh baris hari untuk jadwal ini (lebih sederhana & aman daripada upsert parsial)
    await supabase.from("work_schedule_days").delete().eq("schedule_id", scheduleId);
    const { error: dayError } = await supabase.from("work_schedule_days").insert(dayRows);
    if (dayError) throw dayError;

    // Terapkan pilihan karyawan: yang ada di assignedIds -> dikaitkan ke
    // jadwal ini, yang sebelumnya terkait tapi sekarang dihapus dari daftar
    // -> dilepas (lihat renderAssignedList/renderEmployeeSearchResults untuk
    // bagaimana assignedIds diisi lewat UI "+ Tambah Karyawan" / "Hapus").
    const checkedIds = assignedIds;
    const previouslyAssignedIds = new Set(
      allEmployees.filter(emp => emp.schedule_id === scheduleId).map(emp => emp.id)
    );
    const toAssign = [...checkedIds].filter(id => !previouslyAssignedIds.has(id));
    const toUnassign = [...previouslyAssignedIds].filter(id => !checkedIds.has(id));

    if (toAssign.length) {
      const { error } = await supabase.from("profiles").update({ schedule_id: scheduleId }).in("id", toAssign);
      if (error) throw error;
    }
    if (toUnassign.length) {
      const { error } = await supabase.from("profiles").update({ schedule_id: null }).in("id", toUnassign);
      if (error) throw error;
    }

    toast("Jadwal kerja tersimpan", "success");
    closeModal();
    loadList(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
