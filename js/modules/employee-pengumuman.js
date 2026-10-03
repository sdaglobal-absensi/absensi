import { supabase } from "../supabaseClient.js";
import { toast, fmtDateTime } from "../core.js";
import { esc } from "../approvalHelper.js";

// =======================================================================
// INFO INTERNAL (sisi karyawan) — daftar pengumuman yang ditujukan ke saya,
// tanda "Baru" untuk yang belum dibaca. Membuka sebuah pengumuman otomatis
// menandainya sudah dibaca (tabel announcement_reads). Yang boleh saya lihat
// ditentukan RLS di server (semua / unit saya), bukan filter di sini.
// =======================================================================

let state = { items: [], reads: new Set(), userId: null };

export async function render(container, user) {
  state.userId = user.id;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Info Internal</h1>
        <p class="muted">Pengumuman dari perusahaan untuk Anda.</p>
      </div>
      <button id="btn-read-all" class="btn-secondary hidden">Tandai semua dibaca</button>
    </div>
    <div id="ann-list"><p class="muted">Memuat…</p></div>
  `;
  document.getElementById("btn-read-all").addEventListener("click", markAllRead);
  await load();
}

async function load() {
  const [annRes, readRes] = await Promise.all([
    supabase.from("announcements")
      .select("id, title, body, is_pinned, created_at, expires_at, created_by")
      .eq("is_active", true)
      .order("is_pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("announcement_reads").select("announcement_id").eq("user_id", state.userId),
  ]);

  const el = document.getElementById("ann-list");
  if (annRes.error) {
    el.innerHTML = `<p class="muted">Gagal memuat pengumuman: ${esc(annRes.error.message)}</p>`;
    return;
  }
  state.items = annRes.data || [];
  state.reads = new Set((readRes.data || []).map(r => r.announcement_id));
  renderList();
}

function unreadCount() {
  return state.items.filter(a => !state.reads.has(a.id)).length;
}

function renderList() {
  const el = document.getElementById("ann-list");
  document.getElementById("btn-read-all")?.classList.toggle("hidden", unreadCount() === 0);

  if (!state.items.length) {
    el.innerHTML = `<div class="card"><p class="muted" style="margin:0;">Belum ada pengumuman.</p></div>`;
    return;
  }

  el.innerHTML = state.items.map(a => {
    const unread = !state.reads.has(a.id);
    return `
      <div class="card ann-card" data-id="${a.id}" style="margin-bottom:12px; ${unread ? "border-left:4px solid var(--primary, #2563eb);" : ""}">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
          ${a.is_pinned ? `<span class="badge badge-warn">📌 Penting</span>` : ""}
          ${unread ? `<span class="badge badge-ok">Baru</span>` : ""}
          <span class="muted small">${fmtDateTime(a.created_at)}</span>
        </div>
        <h3 style="margin:0 0 6px;">${esc(a.title)}</h3>
        <div class="ann-body" style="white-space:pre-line; word-break:break-word;">${esc(a.body)}</div>
        ${unread ? `<div style="margin-top:10px;"><button type="button" class="btn-link btn-mark" data-id="${a.id}">Tandai sudah dibaca</button></div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".btn-mark").forEach(b => b.addEventListener("click", () => markRead([b.dataset.id])));
}

async function markRead(ids) {
  const fresh = ids.filter(id => !state.reads.has(id));
  if (!fresh.length) return;
  const rows = fresh.map(id => ({ announcement_id: id, user_id: state.userId }));
  const { error } = await supabase.from("announcement_reads").upsert(rows, { onConflict: "announcement_id,user_id", ignoreDuplicates: true });
  if (error) { toast("Gagal menandai dibaca: " + error.message, "error"); return; }
  fresh.forEach(id => state.reads.add(id));
  renderList();
}

async function markAllRead() {
  await markRead(state.items.filter(a => !state.reads.has(a.id)).map(a => a.id));
}
