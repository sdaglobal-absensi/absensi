import { supabase } from "../supabaseClient.js";
import { toast, getPosition, getNearestOffice, uploadPhoto, captureFrameAsBlob, fmtTime, todayISO } from "../core.js";

let stream = null;
let capturedBlob = null;
let pendingMode = null; // 'in' | 'out'

export async function render(container, user) {
  const { data: today } = await supabase
    .from("attendance")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", todayISO())
    .maybeSingle();

  const hasCheckedIn = !!today?.check_in;
  const hasCheckedOut = !!today?.check_out;

  container.innerHTML = `
    <div class="page-header">
      <h1>Absensi Hari Ini</h1>
      <p class="muted">${new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
    </div>

    <div class="status-grid">
      <div class="status-card ${hasCheckedIn ? "done" : ""}">
        <span class="status-label">Check-in</span>
        <span class="status-value">${hasCheckedIn ? fmtTime(today.check_in) : "Belum absen"}</span>
        ${today?.check_in_status ? `<span class="badge badge-${today.check_in_status === "telat" ? "warn" : "ok"}">${today.check_in_status === "telat" ? "Telat" : "Tepat waktu"}</span>` : ""}
      </div>
      <div class="status-card ${hasCheckedOut ? "done" : ""}">
        <span class="status-label">Check-out</span>
        <span class="status-value">${hasCheckedOut ? fmtTime(today.check_out) : "Belum absen"}</span>
      </div>
    </div>

    <div class="action-area">
      ${!hasCheckedIn
        ? `<button id="btn-open-camera" class="btn-primary btn-lg" data-mode="in">Check-in Sekarang</button>`
        : !hasCheckedOut
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
  if (btnOpen) btnOpen.addEventListener("click", () => openCamera(btnOpen.dataset.mode, user));

  document.getElementById("btn-cancel").addEventListener("click", closeCamera);
}

async function openCamera(mode, user) {
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
  document.getElementById("btn-submit").onclick = () => submitAttendance(user);
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

async function submitAttendance(user) {
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
      // Jam kerja default: masuk sebelum 08:15 = tepat waktu
      const cutoff = new Date(now); cutoff.setHours(8, 15, 0, 0);
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
      const { data: row } = await supabase
        .from("attendance").select("id").eq("user_id", user.id).eq("date", todayISO()).single();
      const { error } = await supabase.from("attendance").update({
        check_out: now.toISOString(),
        check_out_lat: pos?.lat ?? null,
        check_out_lng: pos?.lng ?? null,
        check_out_distance_m: office ? Math.round(office.distance) : null,
        check_out_photo_url: photoUrl,
      }).eq("id", row.id);
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
