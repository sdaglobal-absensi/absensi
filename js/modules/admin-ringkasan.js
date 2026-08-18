/* ======================================================================
   MODUL: Ringkasan Harian (admin)
   ====================================================================== */
App.registerModule({
  id: "admin-ringkasan",
  label: "Ringkasan Harian",
  icon: "📊",
  roles: ["admin"],
  order: 1,
  _ctx: null,

  async mount(container, ctx) {
    this._ctx = ctx;
    container.innerHTML = `
      <h1 class="page-title">Ringkasan Harian</h1>
      <p class="page-sub">Status kehadiran seluruh karyawan pada tanggal tertentu.</p>
      <div class="stat-row" id="admin-stats"></div>
      <div class="toolbar"><input type="date" id="ring-date" /></div>
      <table class="data">
        <thead><tr><th>Karyawan</th><th>Departemen</th><th>Masuk</th><th>Pulang</th><th>Status</th></tr></thead>
        <tbody id="ring-body"><tr><td colspan="5">Memuat…</td></tr></tbody>
      </table>
    `;
    document.getElementById("ring-date").value = ctx.util.todayStr();
    document.getElementById("ring-date").onchange = () => this.load();
    await this.load();
  },

  async load() {
    const { sb, util } = this._ctx;
    const date = document.getElementById("ring-date").value || util.todayStr();

    const [{ data: profiles }, { data: rows }] = await Promise.all([
      sb.from("profiles").select("*").eq("role", "karyawan").order("full_name"),
      sb.from("attendance").select("*").eq("date", date),
    ]);
    const employees = profiles || [];
    const attRows = rows || [];
    const byUser = {};
    attRows.forEach((r) => (byUser[r.user_id] = r));

    const total = employees.length;
    const hadir = attRows.filter((r) => r.status === "hadir").length;
    const terlambat = attRows.filter((r) => r.status === "terlambat").length;
    const belum = Math.max(total - attRows.length, 0);

    document.getElementById("admin-stats").innerHTML = [
      [total, "Total Karyawan"], [hadir, "Hadir Tepat Waktu"], [terlambat, "Terlambat"], [belum, "Belum Absen"],
    ].map(([n, l]) => `<div class="stat-card"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join("");

    const body = document.getElementById("ring-body");
    if (employees.length === 0) { body.innerHTML = '<tr><td colspan="5">Belum ada data karyawan.</td></tr>'; return; }
    body.innerHTML = employees.map((p) => {
      const r = byUser[p.id];
      const status = r ? r.status : "alpha";
      return `<tr>
        <td>${util.escapeHtml(p.full_name || "—")}</td>
        <td>${util.escapeHtml(p.department || "—")}</td>
        <td class="mono">${util.timeStr(r && r.check_in)}</td>
        <td class="mono">${util.timeStr(r && r.check_out)}</td>
        <td><span class="badge ${status}">${status === "alpha" ? "belum absen" : status}</span></td>
      </tr>`;
    }).join("");
  },
});
