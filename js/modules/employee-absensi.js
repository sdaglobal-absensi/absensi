import { supabase } from "../supabaseClient.js";
import { toast, getPosition, getNearestOffice, uploadPhoto, captureFrameAsBlob, fmtTime, fmtDate, todayISO } from "../core.js";

let stream = null;
let capturedBlob = null;
let pendingMode = null; // 'in' | 'out'

export async function render(container, user) {
  // Ambil absensi TERBARU milik user (bukan cuma "hari ini"), supaya shift
  // yang lintas hari (misal masuk jam 22:00, pulang besok jam 06:00) tetap
  // terdeteksi sebagai satu sesi yang sama saat check-out.
  const { data: latest } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", user.id)
    .order("check_in", { ascending: false })
    .limit(1)
    .maybeSingle();

  const today = todayISO();
  let openShift = !!(latest && !latest.check_out);
  let staleOpen = false;

  // Sesi terbuka HANYA dianggap "masih berjalan" (dan memblokir check-in baru)
  // kalau tanggalnya hari ini, atau kalau itu memang shift lintas hari dari
  // kemarin (sesuai Master Jadwal Kerja karyawan). Kalau bukan keduanya —
  // misal karyawan shift reguler yang lupa check-out — jangan diblokir;
  // anggap sesi lama itu tertinggal, dan izinkan check-in baru hari ini.
  if (openShift && latest.date !== today) {
    const continuation = await isOvernightContinuation(user, latest);
    if (!continuation) {
      staleOpen = true;
      openShift = false;
    }
  }

  const completedToday = !!(latest && latest.check_out && latest.date === today);
  const activeRow = openShift || completedToday ? latest : null;

  container.innerHTML = `
    <div class="page-header">
      <h1>Absensi</h1>
      <p class="muted">${new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
    </div>

    ${openShift ? `<p class="muted small" style="margin-top:-14px; margin-bottom:18px;">Sesi kerja dari ${fmtDate(activeRow.date)} masih berjalan (belum check-out).</p>` : ""}
    ${staleOpen ? `<p class="small" style="margin-top:-14px; margin-bottom:18px; color:var(--warn);">⚠️ Ada check-in tanggal ${fmtDate(latest.date)} yang belum di-check-out (kemungkinan lupa). Kamu tetap bisa check-in baru hari ini — data lama itu akan tercatat tidak lengkap sampai diperbaiki admin.</p>` : ""}

    <div class="status-grid">
      <div class="status-card ${activeRow?.check_in ? "done" : ""}">
        <span class="status-label">Check-in</span>
        <span class="status-value">${activeRow?.check_in ? fmtTime(activeRow.check_in) : "Belum absen"}</span>
        ${activeRow?.check_in_status ? `<span class="badge badge-${activeRow.check_in_status === "telat" ? "warn" : "ok"}">${activeRow.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : ""}
      </div>
      <div class="status-card ${activeRow?.check_out ? "done" : ""}">
        <span class="status-label">Check-out</span>
        <span class="status-value">${activeRow?.check_out ? fmtTime(activeRow.check_out) : "Belum absen"}</span>
      </div>
    </div>

    <div class="action-area">
      ${!openShift && !completedToday
        ? `<button id="btn-open-camera" class="btn-primary btn-lg" data-mode="in">Check-in Sekarang</button>`
        : openShift
        ? `<button id="btn-open-camera" class="btn-primary btn-lg" data-mode="out">Check-out Sekarang</button>`
        : `<p class="muted">Absensi hari ini sudah lengkap. Sampai jumpa besok 👋</p>`
      }
    </div>

    <div id="camera-modal" class="modal hidden">
      <div class="modal-box">
        <h3 id="camera-title">Ambil Foto</h3>
        <p class="muted small" id="camera-status">Menyiapkan kamera & lokasi…</p>
        <div class="camera-frame">
          <video id="camera-video" autoplay playsinline></video>
          <canvas id="camera-preview" class="hidden"></canvas>
        </div>
        <div class="modal-actions">
          <button id="btn-cancel" class="btn-secondary">Batal</button>
          <button id="btn-capture" class="btn-primary" disabled>Ambil Foto</button>
          <button id="btn-retake" class="btn-secondary hidden">Ambil Ulang</button>
          <button id="btn-submit" class="btn-primary hidden">Kirim Absen</button>
        </div>
      </div>
    </div>
  `;

  const btnOpen = document.getElementById("btn-open-camera");
  if (btnOpen) btnOpen.addEventListener("click", () => openCamera(btnOpen.dataset.mode, user, activeRow));

  document.getElementById("btn-cancel").addEventListener("click", closeCamera);
}

// Cek apakah sesi terbuka dari kemarin memang shift lintas hari (misal
// 22:00-06:00) berdasarkan Master Jadwal Kerja karyawan pada hari check-in
// tersebut terjadi. Kalau karyawan tidak punya jadwal, anggap bukan
// lintas hari (perilaku aman/default).
function yesterdayISO(base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function isOvernightContinuation(user, row) {
  if (!row || row.date !== yesterdayISO()) return false;
  if (!user.schedule_id) return false;
  const dow = new Date(row.check_in).getDay();
  const { data: day } = await supabase
    .from("work_schedule_days")
    .select("crosses_midnight")
    .eq("schedule_id", user.schedule_id)
    .eq("day_of_week", dow)
    .maybeSingle();
  return !!day?.crosses_midnight;
}

async function openCamera(mode, user, activeRow) {
  pendingMode = mode;
  capturedBlob = null;
  const modal = document.getElementById("camera-modal");
  modal.classList.remove("hidden");
  document.getElementById("camera-title").textContent = mode === "in" ? "Check-in" : "Check-out";
  document.getElementById("camera-status").textContent = "Menyiapkan kamera & lokasi…";
  document.getElementById("btn-capture").disabled = true;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    const video = document.getElementById("camera-video");
    video.srcObject = stream;
    document.getElementById("camera-status").textContent = "Kamera siap. Ambil lokasi GPS…";

    // Validasi GPS di background, tidak blokir kamera
    getPosition()
      .then(async pos => {
        const office = await getNearestOffice(pos.lat, pos.lng);
        window.__pendingPos = pos;
        window.__pendingOffice = office;
        if (office && office.distance > office.radius_meters) {
          document.getElementById("camera-status").textContent =
            `⚠️ Kamu ${Math.round(office.distance)}m dari kantor (radius ${office.radius_meters}m). Absen tetap bisa dikirim untuk ditinjau admin.`;
        } else {
          document.getElementById("camera-status").textContent = "Lokasi terverifikasi ✓. Silakan ambil foto.";
        }
        document.getElementById("btn-capture").disabled = false;
      })
      .catch(err => {
        document.getElementById("camera-status").textContent = "⚠️ " + err.message + " Kamu tetap bisa lanjut tanpa GPS.";
        window.__pendingPos = null;
        window.__pendingOffice = null;
        document.getElementById("btn-capture").disabled = false;
      });
  } catch (err) {
    document.getElementById("camera-status").textContent = "❌ Tidak bisa mengakses kamera: " + err.message;
  }

  document.getElementById("btn-capture").onclick = capturePhoto;
  document.getElementById("btn-retake").onclick = retake;
  document.getElementById("btn-submit").onclick = () => submitAttendance(user, activeRow);
}

async function capturePhoto() {
  const video = document.getElementById("camera-video");
  capturedBlob = await captureFrameAsBlob(video);

  video.classList.add("hidden");
  const canvas = document.getElementById("camera-preview");
  canvas.classList.remove("hidden");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  document.getElementById("btn-capture").classList.add("hidden");
  document.getElementById("btn-retake").classList.remove("hidden");
  document.getElementById("btn-submit").classList.remove("hidden");
}

function retake() {
  capturedBlob = null;
  document.getElementById("camera-video").classList.remove("hidden");
  document.getElementById("camera-preview").classList.add("hidden");
  document.getElementById("btn-capture").classList.remove("hidden");
  document.getElementById("btn-retake").classList.add("hidden");
  document.getElementById("btn-submit").classList.add("hidden");
}

// Tentukan status tepat-waktu/telat berdasarkan Master Jadwal Kerja milik
// karyawan. Kalau karyawan belum dikaitkan ke jadwal manapun, pakai jam
// 08:15 sebagai cadangan (perilaku lama) supaya tidak mengganggu yang
// belum sempat diatur adminnya.
async function getLateCutoff(user, now) {
  if (user.schedule_id) {
    const dow = now.getDay(); // 0=Minggu ... 6=Sabtu
    const [{ data: sched }, { data: day }] = await Promise.all([
      supabase.from("work_schedules").select("*").eq("id", user.schedule_id).maybeSingle(),
      supabase.from("work_schedule_days").select("*").eq("schedule_id", user.schedule_id).eq("day_of_week", dow).maybeSingle(),
    ]);
    if (day?.is_working_day && day.start_time) {
      const [h, m] = day.start_time.split(":").map(Number);
      const cutoff = new Date(now);
      cutoff.setHours(h, m, 0, 0);
      cutoff.setMinutes(cutoff.getMinutes() + (sched?.late_tolerance_minutes || 0));
      return cutoff;
    }
  }
  const fallback = new Date(now);
  fallback.setHours(8, 15, 0, 0);
  return fallback;
}

async function submitAttendance(user, activeRow) {
  if (!capturedBlob) { toast("Ambil foto dulu", "error"); return; }
  const submitBtn = document.getElementById("btn-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Mengirim…";

  try {
    const pos = window.__pendingPos;
    const office = window.__pendingOffice;
    const photoUrl = await uploadPhoto(capturedBlob, `${user.id}/${pendingMode}`);
    const now = new Date();

    if (pendingMode === "in") {
      const cutoff = await getLateCutoff(user, now);
      const status = now > cutoff ? "telat" : "tepat_waktu";

      const { error } = await supabase.from("attendance").insert({
        user_id: user.id,
        date: todayISO(),
        check_in: now.toISOString(),
        check_in_lat: pos?.lat ?? null,
        check_in_lng: pos?.lng ?? null,
        check_in_distance_m: office ? Math.round(office.distance) : null,
        check_in_photo_url: photoUrl,
        check_in_status: status,
      });
      if (error) throw error;
      toast("Check-in berhasil!", "success");
    } else {
      // Update baris sesi yang masih terbuka (bisa jadi tanggalnya kemarin,
      // untuk shift lintas hari), bukan selalu baris tanggal hari ini.
      if (!activeRow) throw new Error("Tidak ada sesi check-in yang terbuka.");
      const { error } = await supabase.from("attendance").update({
        check_out: now.toISOString(),
        check_out_lat: pos?.lat ?? null,
        check_out_lng: pos?.lng ?? null,
        check_out_distance_m: office ? Math.round(office.distance) : null,
        check_out_photo_url: photoUrl,
      }).eq("id", activeRow.id);
      if (error) throw error;
      toast("Check-out berhasil!", "success");
    }

    closeCamera();
    render(document.getElementById("content"), user);
  } catch (err) {
    toast("Gagal mengirim absen: " + err.message, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Kirim Absen";
  }
}

function closeCamera() {
  document.getElementById("camera-modal").classList.add("hidden");
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  capturedBlob = null;
}
