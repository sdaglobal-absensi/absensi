/* ======================================================================
   MODUL: Riwayat Absensi (admin)
   ====================================================================== */
App.registerModule({
  id: "admin-riwayat",
  label: "Riwayat Absensi",
  icon: "🗂️",
  roles: ["admin"],
  order: 2,
  _ctx: null,
  _employees: [],

  async mount(container, ctx) {
    this._ctx = ctx;
    container.innerHTML = `
      <h1 class="page-title">Riwayat Absensi</h1>
      <p class="page-sub">Telusuri riwayat berdasarkan rentang tanggal dan karyawan.</p>
      <div class="toolbar">
        <input type="date" id="rw-from" />
        <span style="color:var(--muted); font-size:13px;">s/d</span>
        <input type="date" id="rw-to" />
        <select id="rw-employee"><option value="">Semua karyawan</option></select>
      </div>
      <table class="data">
        <thead><tr><th>Tanggal</th><th>Karyawan</th><th>Masuk</th><th>Pulang</th><th>Alamat</th><th>Foto</th><th>Status</th></tr></thead>
        <tbody id="rw-body"><tr><td colspan="7">Memuat…</td></tr></tbody>
      </table>
    `;
    const { sb, util } = ctx;
    document.getElementById("rw-from").value = util.todayStr();
    document.getElementById("rw-to").value = util.todayStr();

    const { data: profiles } = await sb.from("profiles").select("*").order("full_name");
    this._employees = profiles || [];
    document.getElementById("rw-employee").innerHTML =
      '<option value="">Semua karyawan</option>' +
      this._employees.map((p) => `<option value="${p.id}">${util.escapeHtml(p.full_name || "(tanpa nama)")}</option>`).join("");

    ["rw-from", "rw-to", "rw-employee"].forEach((id) => (document.getElementById(id).onchange = () => this.load()));
    await this.load();
  },

  async load() {
    const { sb, util } = this._ctx;
    const from = document.getElementById("rw-from").value || util.todayStr();
    const to = document.getElementById("rw-to").value || util.todayStr();
    const empId = document.getElementById("rw-employee").value;

    let q = sb.from("attendance").select("*").gte("date", from).lte("date", to).order("date", { ascending: false });
    if (empId) q = q.eq("user_id", empId);
    const { data, error } = await q;

    const body = document.getElementById("rw-body");
    if (error || !data || data.length === 0) { body.innerHTML = '<tr><td colspan="7">Tidak ada data pada rentang ini.</td></tr>'; return; }
    const nameOf = (id) => (this._employees.find((p) => p.id === id) || {}).full_name || "—";
    body.innerHTML = data.map((r) => {
      const address = r.check_in_address || r.check_out_address || "—";
      const photoIn = r.check_in_photo_url;
      const photoOut = r.check_out_photo_url;
      const photos = `
        ${photoIn ? `<a href="${photoIn}" target="_blank" rel="noopener" title="Foto masuk"><img src="${photoIn}" style="width:30px;height:30px;border-radius:6px;object-fit:cover;border:1px solid var(--border);margin-right:4px;" /></a>` : ""}
        ${photoOut ? `<a href="${photoOut}" target="_blank" rel="noopener" title="Foto pulang"><img src="${photoOut}" style="width:30px;height:30px;border-radius:6px;object-fit:cover;border:1px solid var(--border);" /></a>` : ""}
      `.trim();
      return `
      <tr>
        <td class="mono">${r.date}</td>
        <td>${util.escapeHtml(nameOf(r.user_id))}</td>
        <td class="mono">${util.timeStr(r.check_in)}</td>
        <td class="mono">${util.timeStr(r.check_out)}</td>
        <td style="max-width:200px; font-size:12.5px;">${util.escapeHtml(address)}</td>
        <td>${photos || "—"}</td>
        <td><span class="badge ${r.status}">${r.status}</span></td>
      </tr>`;
    }).join("");
  },
});
