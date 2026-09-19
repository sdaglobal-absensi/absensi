import { supabase } from "../supabaseClient.js";
import { toast } from "../core.js";

const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

export async function render(container, user) {
  const canEdit = user.role === "admin";

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Jadwal Kerja</h1>
        <p class="muted">Jam kerja per hari untuk tiap jadwal/shift, termasuk shift yang lintas hari (misal 22:00–06:00). Karyawan dikaitkan ke salah satu jadwal ini lewat Data Karyawan.</p>
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
          <p class="small muted field-hint">Kalau Jam Pulang lebih kecil dari Jam Masuk, otomatis dianggap shift lintas hari (misal masuk 22:00, pulang 06:00 besok).</p>
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
  }

  loadList(canEdit);
}

function toggleDayInputs(i, active) {
  const form = document.getElementById("form-schedule");
  form[`start_${i}`].disabled = !active;
  form[`end_${i}`].disabled = !active;
  if (!active) { form[`start_${i}`].value = ""; form[`end_${i}`].value = ""; }
}

async function loadList(canEdit) {
  const { data: schedules, error } = await supabase.from("work_schedules").select("*").order("name");
  const el = document.getElementById("schedule-list");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!schedules.length) { el.innerHTML = `<p class="muted">Belum ada jadwal kerja.</p>`; return; }

  const { data: days } = await supabase.from("work_schedule_days").select("*");

  el.innerHTML = schedules.map(s => {
    const myDays = (days || []).filter(d => d.schedule_id === s.id).sort((a, b) => a.day_of_week - b.day_of_week);
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

    toast("Jadwal kerja tersimpan", "success");
    closeModal();
    loadList(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
