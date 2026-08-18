/* ======================================================================
   MODUL: Data Karyawan (admin)
   Contoh modul "data master" — terpisah total dari absensi/riwayat.
   Kalau nanti mau tambah kolom (mis. foto, alamat), cukup edit file ini.
   ====================================================================== */
App.registerModule({
  id: "admin-karyawan",
  label: "Data Karyawan",
  icon: "🧑\u200d💼",
  roles: ["admin"],
  order: 3,
  _ctx: null,
  _emails: {},

  async mount(container, ctx) {
    this._ctx = ctx;
    container.innerHTML = `
      <h1 class="page-title">Data Karyawan</h1>
      <p class="page-sub">Kelola informasi dan peran (role) setiap akun.</p>
      <div class="toolbar"><input type="text" id="kar-search" placeholder="Cari nama…" /></div>
      <table class="data">
        <thead>
          <tr>
            <th>Nama</th><th>Email</th><th>Kode</th><th>Departemen</th>
            <th>Jabatan</th><th>No. HP</th><th>Bergabung</th><th>Status</th><th>Role</th><th></th>
          </tr>
        </thead>
        <tbody id="kar-body"><tr><td colspan="10">Memuat…</td></tr></tbody>
      </table>
    `;
    document.getElementById("kar-search").oninput = (e) => this.render(e.target.value);
    await this.load();
  },

  async load() {
    const { sb } = this._ctx;
    // Coba ambil email asli lewat RPC khusus admin (lihat supabase-schema.sql: admin_list_users()).
    const [{ data: profiles }, rpcRes] = await Promise.all([
      sb.from("profiles").select("*").order("full_name"),
      sb.rpc("admin_list_users"),
    ]);
    this._profiles = profiles || [];
    this._emails = {};
    (rpcRes.data || []).forEach((u) => (this._emails[u.id] = u.email));
    this.render("");
  },

  render(filterText) {
    const { util } = this._ctx;
    const body = document.getElementById("kar-body");
    let list = this._profiles;
    if (filterText) {
      const f = filterText.toLowerCase();
      list = list.filter((p) => (p.full_name || "").toLowerCase().includes(f));
    }
    if (list.length === 0) { body.innerHTML = '<tr><td colspan="10">Tidak ada karyawan ditemukan.</td></tr>'; return; }

    body.innerHTML = list.map((p) => `
      <tr data-id="${p.id}">
        <td><input class="small-input" style="width:140px;" data-field="full_name" value="${util.escapeHtml(p.full_name || "")}" /></td>
        <td class="mono" style="font-size:12px;">${util.escapeHtml(this._emails[p.id] || "—")}</td>
        <td><input class="small-input" style="width:80px;" data-field="employee_code" value="${util.escapeHtml(p.employee_code || "")}" placeholder="NIK" /></td>
        <td><input class="small-input" data-field="department" value="${util.escapeHtml(p.department || "")}" placeholder="Departemen" /></td>
        <td><input class="small-input" data-field="position" value="${util.escapeHtml(p.position || "")}" placeholder="Jabatan" /></td>
        <td><input class="small-input" data-field="phone" value="${util.escapeHtml(p.phone || "")}" placeholder="08…" /></td>
        <td><input type="date" class="small-input" style="width:130px;" data-field="join_date" value="${p.join_date || ""}" /></td>
        <td>
          <select class="pill-select" data-field="is_active">
            <option value="true" ${p.is_active !== false ? "selected" : ""}>Aktif</option>
            <option value="false" ${p.is_active === false ? "selected" : ""}>Nonaktif</option>
          </select>
        </td>
        <td>
          <select class="pill-select" data-field="role">
            <option value="karyawan" ${p.role === "karyawan" ? "selected" : ""}>Karyawan</option>
            <option value="admin" ${p.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
        </td>
        <td><button class="btn-mini" data-action="save">Simpan</button></td>
      </tr>
    `).join("");

    body.querySelectorAll('button[data-action="save"]').forEach((btn) => {
      btn.onclick = () => this.saveRow(btn.closest("tr"));
    });
  },

  async saveRow(tr) {
    const { sb } = this._ctx;
    const id = tr.dataset.id;
    const get = (f) => tr.querySelector(`[data-field="${f}"]`).value;
    const payload = {
      full_name: get("full_name").trim(),
      employee_code: get("employee_code").trim(),
      department: get("department").trim(),
      position: get("position").trim(),
      phone: get("phone").trim(),
      join_date: get("join_date") || null,
      is_active: get("is_active") === "true",
      role: get("role"),
    };
    const btn = tr.querySelector('[data-action="save"]');
    btn.textContent = "…"; btn.disabled = true;
    const { error } = await sb.from("profiles").update(payload).eq("id", id);
    btn.disabled = false;
    btn.textContent = error ? "Gagal" : "Tersimpan";
    if (!error) {
      const local = this._profiles.find((p) => p.id === id);
      Object.assign(local, payload);
      setTimeout(() => { if (btn.isConnected) btn.textContent = "Simpan"; }, 1200);
    }
  },
});
