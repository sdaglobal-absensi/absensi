import { supabase } from "../supabaseClient.js";
import { toast, roleLabel } from "../core.js";

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
          <input type="text" id="employee-filter" placeholder="Cari nama karyawan…" style="margin-bottom:10px;">
          <div id="employee-checklist" class="employee-checklist"><p class="muted small">Memuat daftar karyawan…</p></div>

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
    document.getElementById("form-schedule").addEventListener("submit", onSubmit);
    document.querySelectorAll(".day-active").forEach((cb, i) => {
      cb.addEventListener("change", () => toggleDayInputs(i, cb.checked));
    });
    document.getElementById("employee-filter").addEventListener("input", e => filterEmployeeChecklist(e.target.value));

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
// Checklist karyawan yang memakai jadwal ini
// =====================================================================
let allEmployees = [];

async function loadEmployeeChecklist(scheduleId) {
  const el = document.getElementById("employee-checklist");
  // Tampilkan SEMUA profil aktif apa pun rolenya (karyawan, admin_hr,
  // super_admin_hr, admin_approval, super_admin) — bukan cuma role
  // "karyawan" seperti sebelumnya, karena staff dengan role lain pun bisa
  // ikut absen dan butuh jadwal kerja (lihat catatan di render() atas soal
  // kenapa filter role lama ini keliru).
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, employee_code, department, schedule_id, role")
    .eq("is_active", true)
    .order("full_name");

  if (error) { el.innerHTML = `<p class="muted small">Gagal memuat daftar karyawan.</p>`; return; }
  allEmployees = data || [];

  if (!allEmployees.length) { el.innerHTML = `<p class="muted small">Belum ada data karyawan.</p>`; return; }

  el.innerHTML = allEmployees.map(emp => `
    <label data-name="${(emp.full_name || "").toLowerCase()}">
      <input type="checkbox" class="emp-check" value="${emp.id}" ${emp.schedule_id === scheduleId ? "checked" : ""}>
      <span>${emp.full_name}</span>
      <span class="emp-meta">${[emp.employee_code, emp.department, roleLabel(emp.role)].filter(Boolean).join(" · ")}</span>
    </label>
  `).join("");
}

function filterEmployeeChecklist(query) {
  const q = query.toLowerCase();
  document.querySelectorAll("#employee-checklist label").forEach(label => {
    label.classList.toggle("hidden", !label.dataset.name.includes(q));
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
  document.getElementById("employee-filter").value = "";

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
  loadEmployeeChecklist(existing ? existing.id : null);
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-schedule").classList.add("hidden");
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

    // Terapkan pilihan karyawan: yang dicentang -> dikaitkan ke jadwal ini,
    // yang sebelumnya terkait tapi sekarang dicentang-lepas -> dilepas.
    const checkedIds = new Set(
      Array.from(document.querySelectorAll(".emp-check:checked")).map(cb => cb.value)
    );
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
