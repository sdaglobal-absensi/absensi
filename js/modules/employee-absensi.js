/* ======================================================================
   MODUL: Absen Saya (karyawan)
   File ini berdiri sendiri — aman diedit/dihapus tanpa memengaruhi modul lain.
   Fitur: absen + FOTO (kamera) + LOKASI/ALAMAT realtime (geolocation).
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

  // state modal kamera
  _stream: null,
  _mode: null,        // "in" | "out"
  _photoBlob: null,
  _loc: null,          // { lat, lng, address }

  async mount(container, ctx) {
    this._ctx = ctx;
    container.innerHTML = `
      <h1 class="page-title">Absen Saya</h1>
      <p class="page-sub">Catat kehadiran Anda hari ini — lengkap dengan foto dan lokasi.</p>
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
    this._injectModal();

    const tick = () => {
      const now = new Date();
      document.getElementById("clock-time").textContent = now.toLocaleTimeString("id-ID", { hour12: false });
      document.getElementById("clock-date").textContent = ctx.util.dateLong(ctx.util.todayStr());
    };
    tick();
    this._interval = setInterval(tick, 1000);

    document.getElementById("btn-checkin").onclick = () => this.openCamModal("in");
    document.getElementById("btn-checkout").onclick = () => this.openCamModal("out");

    await this.loadTodayStatus();
  },

  unmount() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    this._stopCamera();
    const m = document.getElementById("cam-overlay");
    if (m) m.remove();
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

  /* ================= MODAL: kamera + lokasi ================= */
  _injectModal() {
    if (document.getElementById("cam-overlay")) return;
    const div = document.createElement("div");
    div.id = "cam-overlay";
    div.className = "cam-overlay";
    div.style.display = "none";
    div.innerHTML = `
      <div class="cam-modal">
        <div class="cam-head">
          <div class="title" id="cam-title">Absen Masuk</div>
          <button id="cam-close" type="button">✕</button>
        </div>
        <div class="cam-body">
          <div class="cam-stage">
            <video id="cam-video" autoplay playsinline muted></video>
            <img id="cam-photo" style="display:none;" alt="foto absen" />
            <div class="cam-hint" id="cam-hint">Mengaktifkan kamera…</div>
          </div>
          <canvas id="cam-canvas" style="display:none;"></canvas>
          <div class="cam-loc" id="cam-loc"><span class="dot"></span><span id="cam-loc-text">Mendapatkan lokasi…</span></div>
          <div class="cam-actions">
            <button class="btn-mini" id="cam-shot" type="button">📷 Ambil Foto</button>
            <button class="btn-mini" id="cam-retake" type="button" style="display:none;">↺ Ulangi</button>
            <button class="btn-primary" id="cam-submit" type="button" disabled>Konfirmasi</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);

    document.getElementById("cam-close").onclick = () => this.closeCamModal();
    document.getElementById("cam-shot").onclick = () => this.takeShot();
    document.getElementById("cam-retake").onclick = () => this.retake();
    document.getElementById("cam-submit").onclick = () => this.submitAttendance();
  },

  async openCamModal(mode) {
    this._mode = mode;
    this._photoBlob = null;
    this._loc = null;
    document.getElementById("cam-title").textContent = mode === "in" ? "Absen Masuk" : "Absen Pulang";
    document.getElementById("cam-overlay").style.display = "flex";
    document.getElementById("cam-photo").style.display = "none";
    document.getElementById("cam-video").style.display = "block";
    document.getElementById("cam-shot").style.display = "inline-block";
    document.getElementById("cam-retake").style.display = "none";
    document.getElementById("cam-submit").disabled = true;
    document.getElementById("cam-hint").textContent = "Mengaktifkan kamera…";
    document.getElementById("cam-hint").style.display = "flex";

    const locEl = document.getElementById("cam-loc");
    locEl.className = "cam-loc";
    document.getElementById("cam-loc-text").textContent = "Mendapatkan lokasi…";

    this._startCamera();
    this._getLocation();
  },

  closeCamModal() {
    document.getElementById("cam-overlay").style.display = "none";
    this._stopCamera();
  },

  async _startCamera() {
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      const video = document.getElementById("cam-video");
      video.srcObject = this._stream;
      document.getElementById("cam-hint").style.display = "none";
    } catch (e) {
      document.getElementById("cam-hint").textContent = "Tidak bisa mengakses kamera. Izinkan akses kamera di browser, lalu coba lagi.";
    }
  },

  _stopCamera() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  },

  _getLocation() {
    const locEl = document.getElementById("cam-loc");
    const txt = document.getElementById("cam-loc-text");
    if (!navigator.geolocation) {
      locEl.className = "cam-loc err";
      txt.textContent = "Perangkat tidak mendukung lokasi (geolocation).";
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        this._loc = { lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
        txt.textContent = "Mendeteksi alamat…";
        try {
          const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=id`);
          const d = await res.json();
          const parts = [d.locality, d.city && d.city !== d.locality ? d.city : null, d.principalSubdivision]
            .filter(Boolean);
          const address = parts.length ? parts.join(", ") : this._loc.address;
          this._loc.address = address;
          locEl.className = "cam-loc ok";
          txt.textContent = "📍 " + address;
        } catch (e) {
          locEl.className = "cam-loc ok";
          txt.textContent = "📍 " + this._loc.address + " (alamat tidak terdeteksi)";
        }
      },
      (err) => {
        locEl.className = "cam-loc err";
        txt.textContent = "Gagal mendapatkan lokasi: izinkan akses lokasi di browser, lalu coba lagi.";
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  },

  takeShot() {
    const video = document.getElementById("cam-video");
    const canvas = document.getElementById("cam-canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx2d = canvas.getContext("2d");
    ctx2d.translate(canvas.width, 0);
    ctx2d.scale(-1, 1); // mirror agar sesuai preview
    ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      this._photoBlob = blob;
      const img = document.getElementById("cam-photo");
      img.src = URL.createObjectURL(blob);
      img.style.display = "block";
      video.style.display = "none";
      document.getElementById("cam-shot").style.display = "none";
      document.getElementById("cam-retake").style.display = "inline-block";
      document.getElementById("cam-submit").disabled = false;
    }, "image/jpeg", 0.85);
  },

  retake() {
    this._photoBlob = null;
    document.getElementById("cam-photo").style.display = "none";
    document.getElementById("cam-video").style.display = "block";
    document.getElementById("cam-shot").style.display = "inline-block";
    document.getElementById("cam-retake").style.display = "none";
    document.getElementById("cam-submit").disabled = true;
  },

  async submitAttendance() {
    if (!this._photoBlob) { alert("Ambil foto terlebih dahulu."); return; }
    const { sb, user, util } = this._ctx;
    const submitBtn = document.getElementById("cam-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Menyimpan…";

    try {
      // upload foto ke Supabase Storage
      const fileName = `${user.id}/${util.todayStr()}-${this._mode}-${Date.now()}.jpg`;
      const { error: upErr } = await sb.storage.from("attendance-photos").upload(fileName, this._photoBlob, {
        contentType: "image/jpeg",
        upsert: true,
      });
      if (upErr) throw upErr;
      const { data: pub } = sb.storage.from("attendance-photos").getPublicUrl(fileName);
      const photoUrl = pub.publicUrl;

      const lat = this._loc ? this._loc.lat : null;
      const lng = this._loc ? this._loc.lng : null;
      const address = this._loc ? this._loc.address : null;

      if (this._mode === "in") {
        const now = new Date();
        const status = now.toTimeString().slice(0, 8) > window.JAM_MASUK ? "terlambat" : "hadir";
        const { data, error } = await sb.from("attendance")
          .insert({
            user_id: user.id, date: util.todayStr(), check_in: now.toISOString(), status,
            check_in_photo_url: photoUrl, check_in_lat: lat, check_in_lng: lng, check_in_address: address,
          })
          .select().single();
        if (error) throw error;
        this._todayRow = data;
      } else {
        if (!this._todayRow) throw new Error("Belum ada data absen masuk hari ini.");
        const now = new Date();
        const { data, error } = await sb.from("attendance")
          .update({
            check_out: now.toISOString(),
            check_out_photo_url: photoUrl, check_out_lat: lat, check_out_lng: lng, check_out_address: address,
          })
          .eq("id", this._todayRow.id).select().single();
        if (error) throw error;
        this._todayRow = data;
      }

      this.render();
      this.closeCamModal();
    } catch (e) {
      alert("Gagal menyimpan absen: " + e.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Konfirmasi";
    }
  },
});
