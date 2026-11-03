import { supabase } from "../supabaseClient.js";
import { toast, todayISO, fmtDate, escapeHtml, confirmDialog } from "../core.js";
import { addDaysISO } from "../laporanHarian.js";
import { normalizeSections, buildBlankData, normalizeData, completeness, validateForSubmit, isLateSubmission, isRowFilled } from "../laporanAktivitas.js";
import { renderEditableSections, sectionCountText } from "../laporanAktivitasView.js";

// =======================================================================
// LAPORAN HARIAN SAYA — karyawan mengisi laporan aktivitas harian sesuai
// template jabatannya (ditentukan HR di menu "Laporan Aktivitas").
// Boleh mengisi untuk hari ini sampai 7 hari ke belakang (dijaga juga di server).
// Draf bisa disimpan berkali-kali; setelah "Kirim" masih bisa diperbarui sampai
// HR menandainya "Ditinjau" (setelah itu terkunci).
// =======================================================================

const esc = escapeHtml;
const $ = id => document.getElementById(id);
const BACK_DAYS = 7;

let S = null; // state halaman

const fmtDateTime = iso => new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export async function render(container, user) {
  const today = todayISO();
  S = { me: user, today, minDate: addDaysISO(today, -BACK_DAYS), template: null, date: today, report: null, sections: [], data: {}, dirty: false, history: [], busy: false, radio: {} };

  container.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>Laporan Harian Saya</h1>
        <p class="pg-head-sub">Isi aktivitas, kendala, pekerjaan outstanding, dan rencana kerja setiap hari. Simpan sebagai draf kapan saja, lalu kirim kalau sudah selesai.</p>
      </div>
    </div>
    <div id="lap-body"><p class="muted">Memuat…</p></div>`;

  const { data: asg, error } = await supabase.from("daily_report_assignments").select("template_id").eq("user_id", user.id).limit(1);
  if (error) { $("lap-body").innerHTML = `<p class="muted">Gagal memuat: ${esc(error.message)}. Pastikan SQL <b>024_laporan_aktivitas.sql</b> sudah dijalankan.</p>`; return; }
  if (!asg?.length) {
    $("lap-body").innerHTML = `<div class="card"><p>Akunmu belum memakai template laporan harian.</p><p class="muted">Hubungi HR/Admin untuk dipasangkan dengan template laporan sesuai jabatanmu.</p></div>`;
    return;
  }
  const { data: tpl, error: e2 } = await supabase.from("daily_report_templates").select("*").eq("id", asg[0].template_id).single();
  if (e2 || !tpl) { $("lap-body").innerHTML = `<p class="muted">Template laporan tidak ditemukan. Hubungi HR/Admin.</p>`; return; }
  S.template = tpl;
  if (!tpl.is_active) { $("lap-body").innerHTML = `<div class="card"><p>Template laporan "${esc(tpl.name)}" sedang dinonaktifkan oleh HR.</p></div>`; return; }

  const chev = d => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  $("lap-body").innerHTML = `
    <div class="lap-top">
      <div class="lap-top-row">
        <div class="lap-datenav">
          <button type="button" id="lp-prev" class="btn-secondary lap-nav" aria-label="Hari sebelumnya" title="Hari sebelumnya">${chev("m15 18-6-6 6-6")}</button>
          <input type="date" id="lp-date" min="${S.minDate}" max="${today}" value="${today}" aria-label="Tanggal laporan">
          <button type="button" id="lp-next" class="btn-secondary lap-nav" aria-label="Hari berikutnya" title="Hari berikutnya">${chev("m9 18 6-6-6-6")}</button>
          <button type="button" id="lp-today" class="btn-secondary">Hari ini</button>
        </div>
        <div id="lp-status"></div>
      </div>
      <div id="lp-banner"></div>
      <div id="lp-progress" class="lap-progress"></div>
    </div>
    <div id="lp-form"></div>
    <div id="lp-actions" class="lap-actions"></div>
    <h2 class="dash-section-title" style="margin-top:28px;">Riwayat Laporan</h2>
    <div id="lp-history" class="table-wrap"><p class="muted">Memuat…</p></div>`;

  const go = async iso => {
    const d = !iso ? S.today : iso > S.today ? S.today : iso < S.minDate ? S.minDate : iso;
    if (d === S.date) { $("lp-date").value = d; return; }
    if (S.dirty && !(await confirmDialog({ title: "Perubahan belum disimpan", message: "Isian pada tanggal ini belum disimpan dan akan hilang. Lanjut pindah tanggal?", confirmLabel: "Pindah tanggal" }))) { $("lp-date").value = S.date; return; }
    $("lp-date").value = d;
    await loadDate(d);
  };
  $("lp-date").addEventListener("change", e => go(e.target.value));
  $("lp-prev").addEventListener("click", () => go(addDaysISO(S.date, -1)));
  $("lp-next").addEventListener("click", () => go(addDaysISO(S.date, 1)));
  $("lp-today").addEventListener("click", () => go(S.today));

  // Isian: satu pendengar untuk seluruh form (delegasi) supaya tetap jalan setelah render ulang.
  const form = $("lp-form");
  const setValue = (el, value) => {
    const row = S.data[el.dataset.sec]?.[Number(el.dataset.row)];
    if (!row) return;
    row[el.dataset.col] = value;
    const sec = S.sections.find(x => x.key === el.dataset.sec);
    if (sec) { // tanda centang & hitungan di kepala bagian ikut berubah langsung
      el.closest(".lap-row")?.classList.toggle("is-filled", isRowFilled(sec.kind, row));
      const cnt = [...form.querySelectorAll(".lap-sec-count")].find(c => c.dataset.count === sec.key);
      if (cnt) cnt.textContent = sectionCountText(sec.kind, S.data[sec.key]);
    }
    markDirty();
    updateProgress();
  };
  const onField = e => {
    const el = e.target.closest("[data-col]");
    if (el) setValue(el, el.value);
  };
  form.addEventListener("input", onField);
  form.addEventListener("change", onField);
  form.addEventListener("click", e => {
    // Ketuk pilihan yang sedang aktif sekali lagi = kosongkan pilihan.
    const rad = e.target.closest('input[type="radio"][data-col]');
    if (rad) {
      if (S.radio[rad.name] === rad.value) { rad.checked = false; S.radio[rad.name] = ""; setValue(rad, ""); }
      else S.radio[rad.name] = rad.value;
      return;
    }
    const add = e.target.closest("[data-add]");
    if (add) { (S.data[add.dataset.add] ||= []).push({}); markDirty(); renderForm(); updateProgress(); return; }
    const del = e.target.closest("[data-del]");
    if (del) { S.data[del.dataset.del]?.splice(Number(del.dataset.row), 1); markDirty(); renderForm(); updateProgress(); }
  });

  await loadDate(today);
}

function markDirty() {
  if (!S.dirty) { S.dirty = true; renderActions(); }
}

async function loadDate(date) {
  S.date = date; S.dirty = false;
  $("lp-next").disabled = date >= S.today;
  $("lp-prev").disabled = date <= S.minDate;
  $("lp-form").innerHTML = `<p class="muted">Memuat…</p>`;
  const [{ data: rep, error }, hist] = await Promise.all([
    supabase.from("daily_reports").select("*").eq("user_id", S.me.id).eq("report_date", date).limit(1),
    supabase.from("daily_reports").select("report_date, status, submitted_at, reviewed_at, review_note").eq("user_id", S.me.id).gte("report_date", addDaysISO(S.today, -30)).order("report_date", { ascending: false }),
  ]);
  if (error) { $("lp-form").innerHTML = `<p class="muted">Gagal memuat laporan: ${esc(error.message)}</p>`; return; }
  S.report = rep?.[0] || null;
  S.history = hist.data || [];
  if (S.report) {
    // Laporan yang sudah ada memakai SALINAN template saat dibuat, bukan template terbaru.
    S.sections = normalizeSections(S.report.template_snapshot?.sections);
    S.data = normalizeData(S.sections, S.report.data);
  } else {
    S.sections = normalizeSections(S.template.sections);
    S.data = buildBlankData(S.sections);
  }
  renderBanner(); renderForm(); updateProgress(); renderActions(); renderHistory();
}

const isLocked = () => !!S.report?.reviewed_at;

function renderBanner() {
  const r = S.report;
  const longDate = new Date(S.date + "T00:00:00Z").toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const chip = r?.reviewed_at ? `<span class="badge badge-ok">Ditinjau HR</span>`
    : r?.status === "submitted" ? `<span class="badge badge-ok">Terkirim</span>`
    : r ? `<span class="badge badge-warn">Draf</span>` : `<span class="badge badge-muted">Belum diisi</span>`;
  $("lp-status").innerHTML = chip;
  let html = `<div class="lap-meta"><b>${esc(S.template.name)}</b><span>${esc(longDate)}</span></div>`;
  if (r?.reviewed_at) {
    html += `<div class="lap-note ok"><b>Sudah ditinjau HR</b> pada ${fmtDateTime(r.reviewed_at)}. Laporan ini tidak bisa diubah lagi.${r.review_note ? `<div class="lap-note-sub">Catatan HR: ${esc(r.review_note)}</div>` : ""}</div>`;
  } else if (r?.status === "submitted") {
    html += `<div class="lap-note info">Terkirim ${fmtDateTime(r.submitted_at)}${isLateSubmission(r) ? ` <span class="badge badge-warn">Terlambat</span>` : ""}. Kamu masih bisa memperbaruinya sampai HR meninjau.</div>`;
  } else if (r) {
    html += `<div class="lap-note">Draf sudah tersimpan tapi belum dikirim ke HR.</div>`;
  }
  $("lp-banner").innerHTML = html;
}

function renderForm() {
  $("lp-form").innerHTML = renderEditableSections(S.sections, S.data, { disabled: isLocked() });
  S.radio = {};
  $("lp-form").querySelectorAll('input[type="radio"]:checked').forEach(r => { S.radio[r.name] = r.value; });
}

function updateProgress() {
  const c = completeness(S.sections, S.data);
  const el = $("lp-progress");
  if (c.pct == null) {
    el.innerHTML = c.filled ? `<span class="small muted">${c.filled} baris terisi</span>` : "";
    return;
  }
  el.innerHTML = `<div class="lap-bar" role="progressbar" aria-label="Kelengkapan laporan" aria-valuenow="${c.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${c.pct}%"></i></div>
    <span class="lap-pct"><b>${c.pct}%</b> <span class="muted">${c.presetFilled} dari ${c.presetTotal} poin terisi${c.extraFilled ? ` • ${c.extraFilled} tambahan` : ""}</span></span>`;
}

function renderActions() {
  const el = $("lp-actions");
  if (isLocked()) { el.innerHTML = ""; return; }
  const r = S.report;
  const submitted = r?.status === "submitted";
  const info = S.dirty ? `<span class="lap-dirty">● Belum disimpan</span>` : r ? `<span class="lap-saved">✓ Tersimpan</span>` : "";
  el.innerHTML = `
    <div class="lap-actions-info">${info}</div>
    <div class="lap-actions-btns">
      ${r && r.status === "draft" ? `<button type="button" id="lp-delete" class="btn-link lap-delete">Hapus draf</button>` : ""}
      <button type="button" id="lp-save" class="btn-secondary" ${S.busy ? "disabled" : ""}>${S.busy ? "Menyimpan…" : submitted ? "Simpan Perubahan" : "Simpan Draf"}</button>
      <button type="button" id="lp-submit" class="btn-primary" ${S.busy ? "disabled" : ""}>${submitted ? "Perbarui & Kirim Ulang" : "Kirim Laporan"}</button>
    </div>`;
  $("lp-save").addEventListener("click", () => save(false));
  $("lp-submit").addEventListener("click", () => save(true));
  $("lp-delete")?.addEventListener("click", removeDraft);
}

async function save(submit) {
  if (S.busy || isLocked()) return;
  if (submit) {
    const errors = validateForSubmit(S.sections, S.data);
    if (errors.length) { toast(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} lainnya)` : ""), "error"); return; }
  }
  S.busy = true; renderActions();
  const r = S.report;
  const now = new Date().toISOString();
  const payload = {
    template_id: S.template.id,
    status: submit ? "submitted" : (r?.status || "draft"),
    template_snapshot: r?.template_snapshot || { name: S.template.name, sections: S.sections },
    data: S.data,
    submitted_at: r?.submitted_at || (submit ? now : null),
  };
  try {
    let saved, error;
    if (r) ({ data: saved, error } = await supabase.from("daily_reports").update(payload).eq("id", r.id).select().single());
    else ({ data: saved, error } = await supabase.from("daily_reports").insert({ ...payload, user_id: S.me.id, report_date: S.date }).select().single());
    if (error) throw error;
    S.report = saved; S.dirty = false;
    toast(submit ? "Laporan terkirim." : "Draf disimpan.", "success");
    const { data: hist } = await supabase.from("daily_reports").select("report_date, status, submitted_at, reviewed_at, review_note").eq("user_id", S.me.id).gte("report_date", addDaysISO(S.today, -30)).order("report_date", { ascending: false });
    S.history = hist || S.history;
  } catch (e) {
    toast("Gagal menyimpan laporan: " + (e.message || e), "error");
  } finally {
    S.busy = false;
    renderBanner(); renderActions(); renderHistory();
  }
}

async function removeDraft() {
  if (!S.report || S.report.status !== "draft") return;
  const ok = await confirmDialog({ title: "Hapus Draf", message: "Draf laporan tanggal ini akan dihapus. Lanjutkan?", confirmLabel: "Hapus", confirmClass: "btn-danger" });
  if (!ok) return;
  const { error } = await supabase.from("daily_reports").delete().eq("id", S.report.id);
  if (error) { toast("Gagal menghapus draf: " + error.message, "error"); return; }
  toast("Draf dihapus.", "success");
  await loadDate(S.date);
}

function renderHistory() {
  const el = $("lp-history");
  if (!S.history.length) { el.innerHTML = `<p class="muted" style="padding:12px;">Belum ada laporan dalam 30 hari terakhir.</p>`; return; }
  const label = h => h.reviewed_at ? `<span class="badge badge-ok">Ditinjau</span>` : h.status === "submitted" ? `<span class="badge badge-ok">Terkirim</span>` : `<span class="badge badge-warn">Draf</span>`;
  el.innerHTML = `<table class="table"><thead><tr><th>Tanggal</th><th>Status</th><th>Dikirim</th><th>Catatan HR</th><th></th></tr></thead><tbody>
    ${S.history.map(h => `<tr>
      <td>${fmtDate(h.report_date)}</td><td>${label(h)}</td>
      <td>${h.submitted_at ? fmtDateTime(h.submitted_at) : "-"}${isLateSubmission(h) ? ` <span class="badge badge-warn">Terlambat</span>` : ""}</td>
      <td class="small">${esc(h.review_note || "-")}</td>
      <td>${h.report_date >= S.minDate ? `<button type="button" class="btn-link lp-open" data-date="${h.report_date}">Buka</button>` : ""}</td></tr>`).join("")}
  </tbody></table>`;
  el.querySelectorAll(".lp-open").forEach(b => b.addEventListener("click", async () => {
    const d = b.dataset.date;
    if (S.dirty && !(await confirmDialog({ title: "Perubahan belum disimpan", message: "Isian pada tanggal ini belum disimpan dan akan hilang. Lanjut?", confirmLabel: "Lanjut" }))) return;
    $("lp-date").value = d;
    await loadDate(d);
    $("lp-form").scrollIntoView?.({ behavior: "smooth", block: "start" });
  }));
}
