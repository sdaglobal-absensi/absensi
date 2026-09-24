import { supabase } from "../supabaseClient.js";
import { toast, fmtDate, fmtDateTime, getAllowedMenus } from "../core.js";
import { displayProfileValue } from "../biodata.js";
import { esc, askDecision } from "../approvalHelper.js";
import {
  pageHTML, initToolbar, filterAndSort, setMeta, emptyHTML, errorHTML,
  employeeCell, statusPill, cell, actionsCell, reviewNote, tableHTML, bindActions,
} from "../approvalUI.js";

// Approval Perubahan Data — pengajuan koreksi dari menu "Profil Saya".
// Menyetujui langsung menimpa data lama di Data Karyawan. Pencarian & urut
// abjad dikerjakan di browser atas data yang sudah dimuat.
let state = { data: [] };
let ui;
let seq = 0;

export async function render(container, user) {
  container.innerHTML = pageHTML({
    title: "Approval Perubahan Data",
    subtitle: "Pengajuan koreksi data dari menu \"Profil Saya\" karyawan. Menyetujui akan langsung menimpa data lama di Data Karyawan.",
    searchPlaceholder: "Cari nama, kode, data…",
  });
  ui = initToolbar(container, { onStatus: () => load(user), onView: () => paint(user) });
  await load(user);
}

async function load(user) {
  const my = ++seq;
  const el = document.getElementById("ap-table");
  el.innerHTML = `<p class="muted ap-loading">Memuat…</p>`;

  let query = supabase
    .from("profile_change_requests")
    .select("*, profiles!profile_change_requests_user_id_fkey(full_name, department, employee_code, photo_url)")
    .order("created_at", { ascending: false });
  if (ui.status !== "all") query = query.eq("status", ui.status);

  const { data, error } = await query;
  if (my !== seq) return;
  if (error) { el.innerHTML = errorHTML(error.message); return; }
  state = { data: data || [] };
  paint(user);
}

const val = (r, v) => displayProfileValue(r.field_key, v);

function paint(user) {
  const el = document.getElementById("ap-table");
  const { data } = state;

  const rows = filterAndSort(data, ui, {
    name: r => r.profiles?.full_name,
    text: r => [
      r.profiles?.full_name, r.profiles?.employee_code, r.profiles?.department,
      r.field_label, val(r, r.old_value), val(r, r.new_value), r.reason, r.review_notes,
    ].join(" "),
  });
  setMeta(rows.length, data.length, ui);
  if (!rows.length) { el.innerHTML = emptyHTML(ui, data.length); return; }

  el.innerHTML = tableHTML(
    ["Karyawan", "Data yang Diubah", "Perubahan", "Alasan", "Status", ""],
    rows.map(r => `
      <tr>
        ${cell("Karyawan", employeeCell(r.profiles), "ap-td-emp")}
        ${cell("Data", `<span class="ap-chip">${esc(r.field_label)}</span>`)}
        ${cell("Perubahan", diffHTML(r), "ap-td-diff")}
        ${cell("Alasan", `<div class="ap-reason">${esc(r.reason)}</div>${reviewNote(r)}`)}
        ${cell("Status", `
          ${statusPill(r.status)}
          <div class="ap-sub">${r.status === "pending"
            ? `Diajukan ${fmtDate(r.created_at)}`
            : `Diproses ${fmtDateTime(r.reviewed_at)}`}</div>`)}
        ${actionsCell(r, r.status === "pending")}
      </tr>
    `).join("")
  );

  bindActions(el,
    id => confirmDecide(id, "approved", user),
    id => confirmDecide(id, "rejected", user));
}

function diffHTML(r) {
  const oldV = val(r, r.old_value);
  const empty = !r.old_value || oldV === "-" || oldV === "";
  return `
    <div class="ap-diff">
      <span class="ap-diff-old${empty ? " is-empty" : ""}">${empty ? "kosong" : esc(oldV)}</span>
      <span class="ap-diff-arrow" aria-hidden="true">→</span>
      <span class="ap-diff-new">${esc(val(r, r.new_value))}</span>
    </div>`;
}

async function confirmDecide(id, status, user) {
  const row = state.data.find(r => r.id === id);
  if (!row) return;
  const detail = [
    ["Karyawan", row.profiles?.full_name || "-"],
    ["Data", row.field_label],
    ["Dari", val(row, row.old_value)],
    ["Menjadi", val(row, row.new_value)],
    ["Alasan", row.reason],
  ];

  const res = await askDecision({
    title: status === "approved" ? "Setujui perubahan data ini?" : "Tolak pengajuan ini?",
    detail: status === "approved" ? [...detail, ["Dampak", "Data di profil karyawan ini langsung diperbarui."]] : detail,
    decision: status,
  });
  if (!res) return;
  decide(row, status, res.notes, user);
}

async function decide(row, status, notes, user) {
  if (status === "approved") {
    // Menerapkan perubahan = menulis ke tabel profiles, yang di sisi server
    // butuh akses menu "Data Karyawan" (RLS). Tanpa itu update ditolak DIAM-DIAM
    // (0 baris berubah, tanpa error) dan pengajuan terlanjur ditandai
    // "Disetujui" padahal data karyawan tidak berubah — jadi cek dulu di sini.
    const allowed = await getAllowedMenus(user); // null = Super Admin (semua menu)
    if (allowed && !allowed.has("karyawan")) {
      toast("Perubahan tidak bisa diterapkan: akunmu belum punya akses ke menu Data Karyawan. Minta Super Admin menyalakannya di Pengaturan Sistem.", "error");
      return;
    }
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({ [row.field_key]: row.new_value })
      .eq("id", row.user_id);
    if (profileErr) { toast("Gagal menerapkan perubahan ke profil: " + profileErr.message, "error"); return; }
  }
  const { error } = await supabase.from("profile_change_requests").update({
    status, reviewed_by: user.id, reviewed_at: new Date().toISOString(), review_notes: notes,
  }).eq("id", row.id);
  if (error) { toast("Gagal memperbarui status pengajuan: " + error.message, "error"); return; }
  toast(status === "approved" ? "Perubahan data disetujui & diterapkan" : "Pengajuan ditolak", "success");
  load(user);
}
