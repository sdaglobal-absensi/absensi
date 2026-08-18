/* ======================================================================
   MODUL: Riwayat Saya (karyawan)
   Berdiri sendiri — tidak menyentuh modul Absen Saya sama sekali.
   ====================================================================== */
App.registerModule({
  id: "riwayat-saya",
  label: "Riwayat Saya",
  icon: "📖",
  roles: ["karyawan"],
  order: 2,

  async mount(container, ctx) {
    container.innerHTML = `
      <h1 class="page-title">Riwayat Absensi Saya</h1>
      <p class="page-sub">30 catatan terakhir.</p>
      <div class="ledger" id="my-history"><div class="empty-state">Memuat riwayat…</div></div>
    `;
    const { sb, user, util } = ctx;
    const { data, error } = await sb.from("attendance").select("*").eq("user_id", user.id).order("date", { ascending: false }).limit(30);
    const box = document.getElementById("my-history");
    if (error || !data || data.length === 0) {
      box.innerHTML = '<div class="empty-state">Belum ada riwayat absensi.</div>';
      return;
    }
    box.innerHTML = data.map(util.ticketHTML).join("");
  },
});
