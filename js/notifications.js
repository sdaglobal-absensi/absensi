import { supabase } from "./supabaseClient.js";
import { toast } from "./core.js";
import { esc } from "./approvalHelper.js";

// =======================================================================
// Lonceng notifikasi (pojok kanan atas, semua halaman).
// Sumber datanya tabel `notifications` (lihat supabase-notifikasi.sql),
// diisi otomatis oleh create_approval_steps & decide_approval -- BUKAN
// dibuat dari sini. Modul ini cuma baca, tandai-terbaca, dan dengar
// Realtime supaya badge-nya update tanpa refresh.
//
// Ada DUA tombol lonceng di HTML (#btn-notif-mobile di dalam topbar HP,
// #btn-notif-desktop yang fixed di kanan atas untuk layar lebar) -- yang
// mana pun tampil tergantung CSS/lebar layar, tapi dua-duanya dipasangi
// listener yang sama & badge-nya selalu disamakan.
// =======================================================================

const LIST_LIMIT = 30;
let state = { items: [], unread: 0, user: null, channel: null };

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "baru saja";
  if (min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} hari lalu`;
  return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

// Tujuan tab kalau notifikasi ini diklik -- konteksnya beda tergantung
// jenisnya: "approval_needed" = giliran user meng-approve (buka halaman
// Approval-nya), "approval_decided" = ini status pengajuan user sendiri
// (buka halaman Pengajuan-nya).
function targetTab(n) {
  if (n.type === "approval_needed") {
    return { leave: "izin-approval", overtime: "lembur-approval", koreksi: "koreksi-approval" }[n.request_type] || null;
  }
  return { leave: "izin", overtime: "lembur", koreksi: "koreksi" }[n.request_type] || null;
}

function badgeText(n) {
  return n > 9 ? "9+" : String(n);
}

function renderBadges() {
  for (const id of ["notif-badge-mobile", "notif-badge-desktop"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = badgeText(state.unread);
    el.classList.toggle("hidden", state.unread === 0);
  }
}

function itemHTML(n) {
  return `
    <button type="button" class="notif-item ${n.is_read ? "" : "unread"}" data-id="${n.id}">
      ${!n.is_read ? `<span class="notif-dot"></span>` : ""}
      <span class="notif-item-body">
        <span class="notif-item-title">${esc(n.title)}</span>
        ${n.body ? `<span class="notif-item-text">${esc(n.body)}</span>` : ""}
        <span class="notif-item-time">${timeAgo(n.created_at)}</span>
      </span>
    </button>`;
}

function renderPanel() {
  const panel = document.getElementById("notif-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="notif-panel-head">
      <span>Notifikasi</span>
      ${state.unread ? `<button type="button" id="notif-mark-all" class="notif-mark-all">Tandai semua dibaca</button>` : ""}
    </div>
    <div class="notif-panel-list">
      ${state.items.length ? state.items.map(itemHTML).join("") : `<p class="muted small notif-empty">Belum ada notifikasi.</p>`}
    </div>`;

  panel.querySelector("#notif-mark-all")?.addEventListener("click", markAllRead);
  panel.querySelectorAll(".notif-item").forEach(btn => {
    btn.addEventListener("click", () => onItemClick(btn.dataset.id));
  });
}

async function onItemClick(id) {
  const n = state.items.find(x => x.id === id);
  if (!n) return;
  closePanel();
  if (!n.is_read) {
    n.is_read = true;
    state.unread = Math.max(0, state.unread - 1);
    renderBadges();
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
  }
  const tab = targetTab(n);
  if (tab) window.dispatchEvent(new CustomEvent("kerjora:navigate", { detail: { tab } }));
}

async function markAllRead() {
  const unreadIds = state.items.filter(n => !n.is_read).map(n => n.id);
  state.items.forEach(n => (n.is_read = true));
  state.unread = 0;
  renderBadges();
  renderPanel();
  if (unreadIds.length) {
    await supabase.from("notifications").update({ is_read: true }).eq("user_id", state.user.id).eq("is_read", false);
  }
}

function isPanelOpen() {
  return !document.getElementById("notif-panel")?.classList.contains("hidden");
}

function openPanel() {
  document.getElementById("notif-panel")?.classList.remove("hidden");
  document.addEventListener("mousedown", onOutsideClick);
  document.addEventListener("keydown", onEscape);
}

function closePanel() {
  document.getElementById("notif-panel")?.classList.add("hidden");
  document.removeEventListener("mousedown", onOutsideClick);
  document.removeEventListener("keydown", onEscape);
}

function togglePanel() {
  isPanelOpen() ? closePanel() : openPanel();
}

function onOutsideClick(e) {
  const panel = document.getElementById("notif-panel");
  if (!panel || panel.contains(e.target) || e.target.closest(".btn-notif")) return;
  closePanel();
}

function onEscape(e) {
  if (e.key === "Escape") closePanel();
}

async function loadInitial() {
  const [{ data: items }, { count }] = await Promise.all([
    supabase.from("notifications").select("*").eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(LIST_LIMIT),
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", state.user.id).eq("is_read", false),
  ]);
  state.items = items || [];
  state.unread = count ?? 0;
  renderBadges();
  renderPanel();
}

function onRealtimeInsert(row) {
  state.items = [row, ...state.items].slice(0, LIST_LIMIT);
  state.unread += 1;
  renderBadges();
  if (isPanelOpen()) renderPanel();
  toast(row.title, "info");
}

export async function initNotifications(user) {
  state.user = user;

  document.getElementById("btn-notif-mobile")?.addEventListener("click", e => { e.stopPropagation(); togglePanel(); });
  document.getElementById("btn-notif-desktop")?.addEventListener("click", e => { e.stopPropagation(); togglePanel(); });

  await loadInitial();

  // Realtime: notifikasi baru untuk user ini muncul langsung tanpa refresh.
  state.channel = supabase
    .channel(`notifications-${user.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
      payload => onRealtimeInsert(payload.new))
    .subscribe();
}
