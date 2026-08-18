/* ======================================================================
   MODUL: Absen Saya (karyawan)
   File ini berdiri sendiri — aman diedit/dihapus tanpa memengaruhi modul lain.
   ====================================================================== */
App.registerModule({
  id: "absensi",
  label: "Absen Saya",
  icon: "🕒",
  roles: ["karyawan"],
  order: 1,

  _interval: null,
  _todayRow: null,
  _ctx: null,

  async mount(container, ctx) {
    this._ctx = ctx;
    container.innerHTML = `
      <h1 class="page-title">Absen Saya</h1>
      <p class="page-sub">Catat kehadiran Anda hari ini.</p>
      <div class="clock-card">
        <div class="clock-left">
          <div class="date mono" id="clock-date">—</div>
          <div class="time mono" id="clock-time">00:00:00</div>
          <div class="clock-status" id="today-status"><span class="dot"></span><span>Memuat status…</span></div>
        </div>
        <div class="clock-actions">
          <button class="btn-clock btn-in" id="btn-checkin">Absen Masuk</button>
          <button class="btn-clock btn-out" id="btn-checkout">Absen Pulang</button>
        </div>
      </div>
    `;

    const tick = () => {
      const now = new Date();
      document.getElementById("clock-time").textContent = now.toLocaleTimeString("id-ID", { hour12: false });
      document.getElementById("clock-date").textContent = ctx.util.dateLong(ctx.util.todayStr());
    };
    tick();
    this._interval = setInterval(tick, 1000);

    document.getElementById("btn-checkin").onclick = () => this.checkIn();
    document.getElementById("btn-checkout").onclick = () => this.checkOut();

    await this.loadTodayStatus();
  },

  unmount() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  },

  async loadTodayStatus() {
    const { sb, user, util } = this._ctx;
    const { data } = await sb.from("attendance").select("*").eq("user_id", user.id).eq("date", util.todayStr()).maybeSingle();
    this._todayRow = data || null;
    this.render();
  },

  render() {
    const { util } = this._ctx;
    const el = document.getElementById("today-status");
    const btnIn = document.getElementById("btn-checkin");
    const btnOut = document.getElementById("btn-checkout");
    if (!el) return; // modul sudah di-unmount

    const row = this._todayRow;
    if (!row) {
      el.innerHTML = '<span class="dot" style="background:#F2A65A;"></span><span>Belum absen masuk hari ini</span>';
      btnIn.disabled = false; btnOut.disabled = true;
    } else if (row.check_in && !row.check_out) {
      el.innerHTML = `<span class="dot"></span><span>Masuk pukul ${util.timeStr(row.check_in)} · sedang bekerja</span>`;
      btnIn.disabled = true; btnOut.disabled = false;
    } else {
      el.innerHTML = `<span class="dot"></span><span>Selesai · ${util.timeStr(row.check_in)} – ${util.timeStr(row.check_out)}</span>`;
      btnIn.disabled = true; btnOut.disabled = true;
    }
  },

  async checkIn() {
    const { sb, user, util } = this._ctx;
    document.getElementById("btn-checkin").disabled = true;
    const now = new Date();
    const status = now.toTimeString().slice(0, 8) > window.JAM_MASUK ? "terlambat" : "hadir";
    const { data, error } = await sb.from("attendance")
      .insert({ user_id: user.id, date: util.todayStr(), check_in: now.toISOString(), status })
      .select().single();
    if (error) { alert("Gagal absen masuk: " + error.message); document.getElementById("btn-checkin").disabled = false; return; }
    this._todayRow = data;
    this.render();
  },

  async checkOut() {
    if (!this._todayRow) return;
    const { sb } = this._ctx;
    document.getElementById("btn-checkout").disabled = true;
    const now = new Date();
    const { data, error } = await sb.from("attendance").update({ check_out: now.toISOString() }).eq("id", this._todayRow.id).select().single();
    if (error) { alert("Gagal absen pulang: " + error.message); document.getElementById("btn-checkout").disabled = false; return; }
    this._todayRow = data;
    this.render();
  },
});
