import { esc } from "./approvalHelper.js";

// Popup formulir pengajuan baru — pola yang sama untuk Izin, Lembur, Koreksi
// Absen (halaman: judul + tombol "+ Ajukan" + daftar riwayat; formulir di popup).
// Popup dibuat saat dibuka dan dibuang saat ditutup (tidak ada elemen tersisa di DOM).
//
//   title       judul popup
//   fieldsHTML  isi form (nama field bebas, dibaca lewat FormData)
//   notes       daftar catatan singkat (array string) — menggantikan panel "Informasi"
//   values      nilai awal field {nama: nilai} (mis. prefill)
//   onMount     (form) => void — pasang logika field dinamis
//   onSubmit    async (FormData) => boolean — true = berhasil, popup ditutup
//
// Mengembalikan { close, form }.
export function openRequestModal({ title, fieldsHTML, notes = [], values, onMount, onSubmit, submitLabel = "Kirim Pengajuan" }) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `
    <div class="modal-box">
      <h3>${esc(title)}</h3>
      <form class="req-form">
        ${fieldsHTML}
        ${notes.length ? `<ul class="req-notes">${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
          <button type="submit" class="btn-primary" data-x="ok">${esc(submitLabel)}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);

  const form = modal.querySelector(".req-form");
  for (const [k, v] of Object.entries(values || {})) if (form.elements[k] && v != null) form.elements[k].value = v;
  if (onMount) onMount(form);

  // Pesan validasi bawaan browser berbahasa Inggris ("Please fill out this field").
  form.addEventListener("invalid", e => {
    const el = e.target;
    if (el.validity.valueMissing) el.setCustomValidity("Kolom ini wajib diisi.");
    else if (el.validity.rangeUnderflow || el.validity.rangeOverflow) el.setCustomValidity("Nilai di luar batas yang diizinkan.");
    else if (el.validity.badInput) el.setCustomValidity("Format isian tidak valid.");
  }, true);
  form.addEventListener("input", e => e.target.setCustomValidity?.(""));
  form.addEventListener("change", e => e.target.setCustomValidity?.(""));

  const onKey = e => { if (e.key === "Escape") close(); };
  const close = () => { document.removeEventListener("keydown", onKey); modal.remove(); };
  document.addEventListener("keydown", onKey);

  modal.querySelector('[data-x="cancel"]').addEventListener("click", close);
  modal.addEventListener("mousedown", e => { if (e.target === modal) close(); });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const okBtn = modal.querySelector('[data-x="ok"]');
    okBtn.disabled = true;
    okBtn.textContent = "Mengirim…";
    let done = false;
    try { done = await onSubmit(new FormData(form)); } catch (err) { console.error(err); }
    if (done) { close(); return; }
    okBtn.disabled = false;
    okBtn.textContent = submitLabel;
  });

  // Fokus ke kolom pertama yang bisa diisi.
  form.querySelector("input:not([type=hidden]), select, textarea")?.focus();
  return { close, form };
}

// Kartu "belum ada data" yang seragam untuk semua halaman pengajuan.
export const EMPTY_REQUESTS_HTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada pengajuan.</p></div>`;
