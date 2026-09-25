import { supabase } from "./supabaseClient.js";
import { toast } from "./core.js";

// Kunci publik VAPID — AMAN untuk ditaruh di kode client (ini memang
// kegunaannya, mirip anon key Supabase). Pasangan privatenya HANYA dipasang
// sebagai secret di Edge Function (lihat README-PUSH-NOTIFIKASI.md),
// TIDAK PERNAH ditaruh di sini.
//
// Kalau mau generate pasangan baru sendiri: `npx web-push generate-vapid-keys`
const VAPID_PUBLIC_KEY = "BJuVJ1JAIxOp2PkrRMKHA7C4Mc8EIfvs8hrnVvVjLZ99q2WIahJGcy6KXzvmr3AhG5UNECmM26TKE4g4MxV74N0";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

let swRegistration = null;
async function getRegistration() {
  if (swRegistration) return swRegistration;
  swRegistration = await navigator.serviceWorker.register("./sw.js");
  return swRegistration;
}

// Status yang relevan untuk ditampilkan di UI: apakah browser ini sudah
// aktif langganan notifikasi check-out untuk user yang sedang login.
export async function getPushStatus() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await getRegistration();
    const sub = await reg.pushManager.getSubscription();
    return sub ? "subscribed" : "not-subscribed";
  } catch {
    return "not-subscribed";
  }
}

// Dipanggil dari tombol "Aktifkan Pengingat Check-out" (lihat
// employee-absensi.js). Memunculkan prompt izin notifikasi browser, lalu
// menyimpan endpoint-nya ke tabel push_subscriptions supaya Edge Function
// checkout-reminder bisa mengirim push ke device ini.
export async function subscribeToPush(user) {
  if (!pushSupported()) {
    toast("Browser ini tidak mendukung notifikasi push", "error");
    return false;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Izin notifikasi ditolak. Kamu bisa mengaktifkannya lagi lewat pengaturan browser.", "error");
      return false;
    }

    const reg = await getRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: user.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent,
      },
      { onConflict: "endpoint" }
    );
    if (error) throw error;

    toast("Pengingat check-out diaktifkan ✓", "success");
    return true;
  } catch (err) {
    toast("Gagal mengaktifkan pengingat: " + err.message, "error");
    return false;
  }
}

export async function unsubscribeFromPush() {
  try {
    const reg = await getRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    toast("Pengingat check-out dimatikan", "info");
  } catch (err) {
    toast("Gagal mematikan pengingat: " + err.message, "error");
  }
}
