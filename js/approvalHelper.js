import { supabase } from "./supabaseClient.js";
import { isSuper } from "./core.js";

// =======================================================================
// Helper approval BERTINGKAT (izin & lembur) — dipakai bersama oleh halaman
// Approval Izin/Lembur (admin), Pengajuan Izin/Lembur (karyawan), Dashboard.
//
// Tahap approval per pengajuan disimpan di tabel request_approvals (dibentuk
// otomatis oleh trigger database saat pengajuan dibuat — lihat
// supabase-org-approval.sql). Approve/tolak HANYA lewat RPC decide_approval,
// yang mengecek di server bahwa user memang sedang giliran.
//   kind: "leave" (leave_requests) | "overtime" (overtime_requests)
// =======================================================================

const TABLE = { leave: "leave_requests", overtime: "overtime_requests" };

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Ambil semua tahap untuk sekumpulan pengajuan -> { [request_id]: [steps urut] }
export async function fetchSteps(kind, requestIds) {
  const map = {};
  if (!requestIds.length) return map;
  const { data, error } = await supabase
    .from("request_approvals")
    .select("*")
    .eq("request_type", kind)
    .in("request_id", requestIds)
    .order("step_order");
  if (error) return map;
  for (const s of data || []) (map[s.request_id] ??= []).push(s);
  return map;
}

export function currentStep(steps) {
  return (steps || []).find(s => s.status === "pending") || null;
}

// Apakah user ini boleh menyetujui/menolak pengajuan tsb SEKARANG?
// (server tetap memeriksa ulang di decide_approval — ini hanya untuk
// menampilkan/menyembunyikan tombol.)
export function canDecide(req, steps, user) {
  if (req.status !== "pending" || req.user_id === user.id) return false;
  const cur = currentStep(steps);
  if (cur) return cur.approver_ids.includes(user.id) || isSuper(user.role);
  return isSuper(user.role); // pengajuan tanpa tahap: hanya Super Admin
}

// HTML ringkas rincian tahap (dipakai di tabel approval & riwayat karyawan).
export function stepsHTML(req, steps) {
  if (!steps || !steps.length) {
    return req.status === "pending"
      ? `<span class="small muted">Menunggu Super Admin</span>`
      : (req.review_notes ? `<span class="small muted">${esc(req.review_notes)}</span>` : `<span class="small muted">-</span>`);
  }
  const label = s => ({
    waiting: `menunggu giliran`,
    pending: `<strong>menunggu</strong>`,
    approved: `disetujui${s.decided_by_name ? " oleh " + esc(s.decided_by_name) : ""}`,
    rejected: `ditolak${s.decided_by_name ? " oleh " + esc(s.decided_by_name) : ""}${s.notes ? ": " + esc(s.notes) : ""}`,
    skipped: `dilewati`,
  }[s.status] || s.status);
  return steps.map(s => `
    <div class="step-line step-${s.status}">
      <span class="step-no">${s.step_order}</span>
      <span class="small"><span class="step-who">${esc(s.approver_names || "-")}</span> — ${label(s)}</span>
    </div>`).join("");
}

// Daftar pengajuan yang relevan untuk sebuah approver:
//  - Super Admin: semua pengajuan (termasuk yang belum punya tahap);
//  - lainnya: hanya pengajuan yang dia tercatat sebagai approver di salah satu
//    tahapnya (bukan miliknya sendiri).
export async function loadApprovalList(kind, user, status, selectCols) {
  let ids = null;
  if (!isSuper(user.role)) {
    const { data: mine, error } = await supabase
      .from("request_approvals")
      .select("request_id")
      .eq("request_type", kind)
      .contains("approver_ids", [user.id])
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) return { error };
    ids = [...new Set((mine || []).map(s => s.request_id))];
    if (!ids.length) return { data: [], steps: {} };
  }

  let q = supabase.from(TABLE[kind]).select(selectCols).order("created_at", { ascending: false }).neq("user_id", user.id);
  if (ids) q = q.in("id", ids);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return { error };
  const steps = await fetchSteps(kind, (data || []).map(r => r.id));
  return { data: data || [], steps };
}

// Jumlah pengajuan yang sedang menunggu GILIRAN user ini (untuk Dashboard).
export async function countPendingForMe(kind, user) {
  if (isSuper(user.role)) {
    const { count } = await supabase.from(TABLE[kind]).select("id", { count: "exact", head: true }).eq("status", "pending").neq("user_id", user.id);
    return count ?? 0;
  }
  const { count } = await supabase
    .from("request_approvals")
    .select("id", { count: "exact", head: true })
    .eq("request_type", kind)
    .eq("status", "pending")
    .contains("approver_ids", [user.id]);
  return count ?? 0;
}

// Modal konfirmasi + catatan opsional. Resolve { notes } bila lanjut, null bila batal.
export function askDecision({ title, detail, decision }) {
  return new Promise(resolve => {
    const modal = document.createElement("div");
    modal.className = "modal";
    const approve = decision === "approved";
    modal.innerHTML = `
      <div class="modal-box">
        <h3>${esc(title)}</h3>
        <p class="muted" style="white-space:pre-line; margin-top:8px;">${esc(detail)}</p>
        <div class="form-row" style="margin-top:14px;">
          <label>Catatan ${approve ? "(opsional)" : "(alasan penolakan, opsional)"}
            <textarea id="decision-notes" rows="2" placeholder="Tulis catatan untuk pemohon…"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-x="cancel">Batal</button>
          <button type="button" class="${approve ? "btn-primary" : "btn-secondary"}" data-x="ok">${approve ? "Ya, Setujui" : "Ya, Tolak"}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const done = v => { modal.remove(); resolve(v); };
    modal.querySelector('[data-x="cancel"]').addEventListener("click", () => done(null));
    modal.querySelector('[data-x="ok"]').addEventListener("click", () => done({ notes: modal.querySelector("#decision-notes").value.trim() || null }));
    modal.addEventListener("mousedown", e => { if (e.target === modal) done(null); });
  });
}

// Panggil RPC keputusan. Mengembalikan { status } (status akhir pengajuan) atau { error }.
export async function decideRequest(kind, requestId, decision, notes) {
  const { data, error } = await supabase.rpc("decide_approval", {
    p_kind: kind, p_request_id: requestId, p_decision: decision, p_notes: notes ?? null,
  });
  if (error) return { error };
  return { status: data };
}
