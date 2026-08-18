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
        <button class="btn-mini" id="rw-export" type="button" style="margin-left:auto;">⬇️ Export CSV</button>
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
    document.getElementById("rw-export").onclick = () => this.exportCSV();
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
    this._rows = data || [];

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

  exportCSV() {
    const { util } = this._ctx;
    const rows = this._rows || [];
    if (!rows.length) { alert("Tidak ada data untuk diekspor pada rentang ini."); return; }
    const nameOf = (id) => (this._employees.find((p) => p.id === id) || {}).full_name || "—";

    const headers = [
      "Tanggal", "Karyawan", "Jam Masuk", "Jam Pulang", "Status",
      "Alamat Masuk", "Alamat Pulang", "Latitude Masuk", "Longitude Masuk",
      "Latitude Pulang", "Longitude Pulang", "Foto Masuk (URL)", "Foto Pulang (URL)",
    ];
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.map(esc).join(",")];
    rows.forEach((r) => {
      lines.push([
        r.date,
        nameOf(r.user_id),
        util.timeStr(r.check_in),
        util.timeStr(r.check_out),
        r.status,
        r.check_in_address || "",
        r.check_out_address || "",
        r.check_in_lat ?? "",
        r.check_in_lng ?? "",
        r.check_out_lat ?? "",
        r.check_out_lng ?? "",
        r.check_in_photo_url || "",
        r.check_out_photo_url || "",
      ].map(esc).join(","));
    });

    const from = document.getElementById("rw-from").value;
    const to = document.getElementById("rw-to").value;
    const csv = "\uFEFF" + lines.join("\r\n"); // BOM agar Excel baca UTF-8 (nama & alamat) dengan benar
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `absensi_${from}_sd_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
});
