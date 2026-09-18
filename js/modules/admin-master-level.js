import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah } from "../core.js";

export async function render(container, user) {
  const canEdit = user.role === "admin";

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Level</h1>
        <p class="muted">Data grade/level jabatan beserta denda, upah lembur, uang perjalanan dinas, BPJS, dan PPh21 — dipakai sebagai acuan perhitungan gaji.</p>
      </div>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Level</button>` : ""}
    </div>
    <div id="level-table" class="table-wrap"><p class="muted">Memuat…</p></div>

    ${canEdit ? `
    <div id="modal-level" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <h3 id="modal-title">Tambah Level</h3>
        <form id="form-level">
          <input type="hidden" name="id">

          <div class="form-section-label">Identitas</div>
          <div class="form-row two-col">
            <label>Grade <input name="grade" required placeholder="Contoh: I"></label>
            <label>Level <input name="level" required placeholder="Contoh: Staff"></label>
          </div>

          <div class="form-section-label">Denda &amp; Tunjangan</div>
          <div class="form-row two-col">
            <label>Denda Terlambat &amp; Pulang Cepat (Rp) <input type="number" name="denda_terlambat" min="0" step="1000" required></label>
            <label>Uang Perjalanan Dinas (Rp) <input type="number" name="uang_perjalanan_dinas" min="0" step="1000" required></label>
          </div>
          <div class="form-row two-col">
            <label>Upah Lembur Hari Biasa (Rp/jam) <input type="number" name="upah_lembur_hari_biasa" min="0" step="1000" required></label>
            <label>Upah Lembur Hari Libur (Rp/jam) <input type="number" name="upah_lembur_hari_libur" min="0" step="1000" required></label>
          </div>

          <div class="form-section-label">BPJS Kesehatan</div>
          <div class="form-row three-col">
            <label>Upah Lapor BPJS (Rp) <input type="number" name="upah_lapor_bpjs" min="0" step="1000" required></label>
            <label>% Ditanggung Karyawan <input type="number" name="bpjs_kesehatan_karyawan_persen" min="0" max="100" step="0.1" required></label>
            <label>% Ditanggung Perusahaan <input type="number" name="bpjs_kesehatan_perusahaan_persen" min="0" max="100" step="0.1" required></label>
          </div>

          <div class="form-section-label">BPJS Ketenagakerjaan</div>
          <div class="form-row two-col">
            <label>% Ditanggung Karyawan <input type="number" name="bpjs_tk_karyawan_persen" min="0" max="100" step="0.1" required></label>
            <label>% Ditanggung Perusahaan <input type="number" name="bpjs_tk_perusahaan_persen" min="0" max="100" step="0.1" required></label>
          </div>
          <p class="small muted field-hint">Upah lapor BPJS Kesehatan di atas juga dipakai sebagai dasar perhitungan BPJS Ketenagakerjaan.</p>

          <div class="form-section-label">Pajak</div>
          <div class="form-row">
            <label>PPh21 (%) <input type="number" name="pph21_persen" min="0" max="100" step="0.1" required></label>
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
    document.getElementById("form-level").addEventListener("submit", onSubmit);
  }

  loadTable(canEdit);
}

async function loadTable(canEdit) {
  const { data, error } = await supabase
    .from("job_levels")
    .select("*")
    .order("grade", { ascending: true });

  const el = document.getElementById("level-table");
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="muted">Belum ada data master level.</p>`; return; }

  el.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Grade</th><th>Level</th>
          <th>Denda Telat &amp; Pulang Cepat</th>
          <th>Lembur Biasa</th><th>Lembur Libur</th>
          <th>Uang Dinas</th>
          <th>Upah Lapor BPJS</th>
          <th>BPJS Kesehatan<br><span class="th-sub">Karyawan / Perusahaan</span></th>
          <th>BPJS Ketenagakerjaan<br><span class="th-sub">Karyawan / Perusahaan</span></th>
          <th>PPh21</th>
          <th>Status</th>${canEdit ? "<th></th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.grade}</td>
            <td>${r.level}</td>
            <td>${fmtRupiah(r.denda_terlambat)}</td>
            <td>${fmtRupiah(r.upah_lembur_hari_biasa)}/jam</td>
            <td>${fmtRupiah(r.upah_lembur_hari_libur)}/jam</td>
            <td>${fmtRupiah(r.uang_perjalanan_dinas)}</td>
            <td>${fmtRupiah(r.upah_lapor_bpjs)}</td>
            <td>${r.bpjs_kesehatan_karyawan_persen}% / ${r.bpjs_kesehatan_perusahaan_persen}%</td>
            <td>${r.bpjs_tk_karyawan_persen}% / ${r.bpjs_tk_perusahaan_persen}%</td>
            <td>${r.pph21_persen}%</td>
            <td><span class="badge badge-${r.is_active ? "ok" : "danger"}">${r.is_active ? "Aktif" : "Nonaktif"}</span></td>
            ${canEdit ? `<td><button class="btn-link btn-edit" data-id="${r.id}">Edit</button></td>` : ""}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  if (canEdit) {
    el.querySelectorAll(".btn-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = data.find(r => r.id === btn.dataset.id);
        openModal(row);
      });
    });
  }
}

const FIELDS = [
  "grade", "level", "denda_terlambat", "uang_perjalanan_dinas",
  "upah_lembur_hari_biasa", "upah_lembur_hari_libur",
  "upah_lapor_bpjs", "bpjs_kesehatan_karyawan_persen", "bpjs_kesehatan_perusahaan_persen",
  "bpjs_tk_karyawan_persen", "bpjs_tk_perusahaan_persen", "pph21_persen",
];

function openModal(existing = null) {
  const modal = document.getElementById("modal-level");
  const form = document.getElementById("form-level");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Level" : "Tambah Level";

  if (existing) {
    form.id.value = existing.id;
    FIELDS.forEach(f => { form[f].value = existing[f]; });
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-level").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const payload = { grade: fd.get("grade"), level: fd.get("level"), is_active: fd.get("is_active") === "on" };
  FIELDS.slice(2).forEach(f => { payload[f] = Number(fd.get(f)); });

  try {
    const { error } = id
      ? await supabase.from("job_levels").update(payload).eq("id", id)
      : await supabase.from("job_levels").insert(payload);
    if (error) throw error;
    toast("Master level tersimpan", "success");
    closeModal();
    loadTable(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}
