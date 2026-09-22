import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah } from "../core.js";

// =======================================================================
// MASTER DENDA TERLAMBAT & PULANG CEPAT
// Tabel jam bertingkat yang dulu "hardcode" di kode Slip Gaji, sekarang
// jadi setting manual di sini. Dipakai bareng kolom "Denda Terlambat &
// Pulang Cepat" (Rp) di Master Level: kalau tipe tier "persen", nominal
// potongannya = persen x denda dasar level karyawan ybs; kalau "flat",
// nominalnya tetap berapa pun denda dasarnya.
// =======================================================================

const GROUPS = [
  { day_type: "weekday", jenis: "telat", title: "Terlambat — Senin s/d Jumat", hint: "Aturan dipakai berdasarkan jam check-in: makin siang datangnya (melewati jam yang lebih besar), makin besar potongannya." },
  { day_type: "saturday", jenis: "telat", title: "Terlambat — Sabtu", hint: "Aturan dipakai berdasarkan jam check-in: makin siang datangnya (melewati jam yang lebih besar), makin besar potongannya." },
  { day_type: "weekday", jenis: "pulang_cepat", title: "Pulang Cepat — Senin s/d Jumat", hint: "Aturan dipakai berdasarkan jam check-out: makin awal pulangnya (di bawah jam yang lebih kecil), makin besar potongannya." },
  { day_type: "saturday", jenis: "pulang_cepat", title: "Pulang Cepat — Sabtu", hint: "Aturan dipakai berdasarkan jam check-out: makin awal pulangnya (di bawah jam yang lebih kecil), makin besar potongannya." },
];

let rules = [];

export async function render(container, user) {
  const canEdit = user.role === "admin";

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Master Denda Terlambat &amp; Pulang Cepat</h1>
        <p class="muted">Tabel jam bertingkat untuk potongan telat &amp; pulang cepat di Slip Gaji. Tier bertipe "% dari denda level" mengalikan persentase dengan kolom "Denda Terlambat &amp; Pulang Cepat" di Master Level masing-masing karyawan; tier bertipe "Nominal tetap" selalu memotong sejumlah itu berapa pun denda levelnya.</p>
      </div>
      ${canEdit ? `<button id="btn-new" class="btn-primary">+ Tambah Tier</button>` : ""}
    </div>

    <div id="denda-groups"></div>

    ${canEdit ? `
    <div id="modal-denda" class="modal hidden">
      <div class="modal-box">
        <h3 id="modal-title">Tambah Tier</h3>
        <form id="form-denda">
          <input type="hidden" name="id">
          <div class="form-row two-col">
            <label>Hari <select name="day_type" required>
              <option value="weekday">Senin – Jumat</option>
              <option value="saturday">Sabtu</option>
            </select></label>
            <label>Jenis <select name="jenis" required>
              <option value="telat">Terlambat</option>
              <option value="pulang_cepat">Pulang Cepat</option>
            </select></label>
          </div>
          <div class="form-row">
            <label id="label-jam">Terlambat lebih dari jam <input type="time" name="jam" required></label>
          </div>
          <div class="form-row">
            <label>Tipe Potongan <select name="tipe" required>
              <option value="percent">% dari denda level (Master Level)</option>
              <option value="flat">Nominal tetap (Rp)</option>
            </select></label>
          </div>
          <div class="form-row" id="row-persen">
            <label>Persentase (%) <input type="number" name="persen" min="0" max="100" step="0.01" value="0"></label>
          </div>
          <div class="form-row hidden" id="row-nominal">
            <label>Nominal (Rp) <input type="number" name="nominal" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Label (opsional, tampil di rincian internal) <input name="label" placeholder="Dikosongkan = dibuat otomatis"></label>
          </div>
          <div class="form-row">
            <label class="checkbox-row"><input type="checkbox" name="is_active" checked> Aktif</label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-delete-denda" class="btn-secondary" style="display:none; color:#c0392b;">Hapus</button>
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
    document.getElementById("btn-delete-denda").addEventListener("click", onDelete);
    document.getElementById("form-denda").addEventListener("submit", onSubmit);
    document.getElementById("form-denda").tipe.addEventListener("change", syncTipeFields);
    document.getElementById("form-denda").jenis.addEventListener("change", syncJamLabel);
  }

  await loadGroups(canEdit);
}

async function loadGroups(canEdit) {
  const el = document.getElementById("denda-groups");
  el.innerHTML = `<p class="muted">Memuat…</p>`;

  const { data, error } = await supabase.from("late_penalty_rules").select("*").order("jam", { ascending: true });
  if (error) { el.innerHTML = `<p class="muted">Gagal memuat data: ${error.message}</p>`; return; }
  rules = data || [];

  el.innerHTML = GROUPS.map(g => renderGroup(g, canEdit)).join("");

  if (canEdit) {
    el.querySelectorAll(".btn-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = rules.find(r => r.id === btn.dataset.id);
        openModal(row);
      });
    });
  }
}

function renderGroup(g, canEdit) {
  const rows = rules.filter(r => r.day_type === g.day_type && r.jenis === g.jenis);
  return `
    <div class="table-wrap" style="margin-bottom:20px;">
      <h4 style="margin-bottom:2px;">${g.title}</h4>
      <p class="small muted" style="margin-top:0; margin-bottom:10px;">${g.hint}</p>
      ${!rows.length ? `<p class="muted">Belum ada tier untuk kelompok ini.</p>` : `
      <table class="table">
        <thead><tr><th>Jam</th><th>Potongan</th><th>Label</th><th>Status</th>${canEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${r.jenis === "telat" ? "&gt;" : "&lt;"} ${r.jam.slice(0, 5)}</td>
              <td>${r.tipe === "flat" ? fmtRupiah(r.nominal) : `${r.persen}% dari denda level`}</td>
              <td>${r.label || "-"}</td>
              <td><span class="badge badge-${r.is_active ? "ok" : "danger"}">${r.is_active ? "Aktif" : "Nonaktif"}</span></td>
              ${canEdit ? `<td><button class="btn-link btn-edit" data-id="${r.id}">Edit</button></td>` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>`}
    </div>
  `;
}

function syncTipeFields() {
  const form = document.getElementById("form-denda");
  const isFlat = form.tipe.value === "flat";
  document.getElementById("row-nominal").classList.toggle("hidden", !isFlat);
  document.getElementById("row-persen").classList.toggle("hidden", isFlat);
}

function syncJamLabel() {
  const form = document.getElementById("form-denda");
  document.getElementById("label-jam").firstChild.textContent =
    form.jenis.value === "telat" ? "Terlambat lebih dari jam " : "Pulang kurang dari jam ";
}

function openModal(existing = null) {
  const modal = document.getElementById("modal-denda");
  const form = document.getElementById("form-denda");
  form.reset();
  document.getElementById("modal-title").textContent = existing ? "Edit Tier" : "Tambah Tier";
  document.getElementById("btn-delete-denda").style.display = existing ? "" : "none";

  if (existing) {
    form.id.value = existing.id;
    form.day_type.value = existing.day_type;
    form.jenis.value = existing.jenis;
    form.jam.value = existing.jam.slice(0, 5);
    form.tipe.value = existing.tipe;
    form.persen.value = existing.persen || 0;
    form.nominal.value = existing.nominal || 0;
    form.label.value = existing.label || "";
    form.is_active.checked = existing.is_active;
  } else {
    form.id.value = "";
  }
  syncTipeFields();
  syncJamLabel();
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-denda").classList.add("hidden");
}

async function onSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const tipe = fd.get("tipe");
  const payload = {
    day_type: fd.get("day_type"),
    jenis: fd.get("jenis"),
    jam: fd.get("jam"),
    tipe,
    nominal: tipe === "flat" ? Number(fd.get("nominal")) || 0 : 0,
    persen: tipe === "percent" ? Number(fd.get("persen")) || 0 : 0,
    label: fd.get("label") || null,
    is_active: fd.get("is_active") === "on",
  };

  try {
    const { error } = id
      ? await supabase.from("late_penalty_rules").update(payload).eq("id", id)
      : await supabase.from("late_penalty_rules").insert(payload);
    if (error) throw error;
    toast("Tier denda tersimpan", "success");
    closeModal();
    loadGroups(true);
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  }
}

async function onDelete() {
  const form = document.getElementById("form-denda");
  const id = form.id.value;
  if (!id) return;
  if (!confirm("Hapus tier ini?")) return;
  try {
    const { error } = await supabase.from("late_penalty_rules").delete().eq("id", id);
    if (error) throw error;
    toast("Tier denda dihapus", "success");
    closeModal();
    loadGroups(true);
  } catch (err) {
    toast("Gagal menghapus: " + err.message, "error");
  }
}
