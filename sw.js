// Service worker KERJORA — push notification + cache app-shell (offline ringan).
//
// Strategi: NETWORK-FIRST untuk file statis se-origin (HTML/JS/CSS/ikon), jadi
// pengguna selalu mendapat versi terbaru bila online; cache hanya dipakai saat
// offline. Semua request lintas-origin (Supabase, Turnstile, dsb.) dan non-GET
// TIDAK PERNAH disentuh/di-cache, sehingga data karyawan tidak tersimpan di cache.
// Naikkan CACHE_VERSION bila perlu membuang cache lama.

const CACHE_VERSION = "kerjora-shell-v2";
const OFFLINE_URL = "./offline.html";
const PRECACHE = [
  "./offline.html",
  "./index.html",
  "./app.html",
  "./css/style.css",
  "./assets/icon-192.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(PRECACHE))
      .catch(() => {}) // gagal precache tidak boleh menggagalkan instalasi
  );
  // Tidak skipWaiting otomatis: versi baru menunggu sampai halaman
  // mengirim pesan SKIP_WAITING (lihat js/registerSw.js -> banner "versi baru").
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase dll: langsung ke jaringan
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") return (await caches.match(OFFLINE_URL)) || Response.error();
        return Response.error();
      })
  );
});

// Edge Function checkout-reminder (lihat supabase/functions/checkout-reminder)
// mengirim payload JSON: { title, body, url }
self.addEventListener("push", event => {
  let data = { title: "KERJORA", body: "Jangan lupa check-out.", url: "./app.html#absensi" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // payload bukan JSON (harusnya tidak terjadi) — pakai default di atas
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "assets/icon-192.png",
      badge: "assets/icon-96.png",
      data: { url: data.url },
      tag: "kerjora-checkout-reminder", // notifikasi baru menggantikan yang lama, tidak menumpuk
      vibrate: [200, 100, 200], // getar tambahan (Android; diabaikan iOS Safari)
      requireInteraction: true, // tetap tampil sampai disentuh, tidak hilang sendiri dalam beberapa detik
    })
  );
});

// Klik notifikasi -> fokus tab yang sudah terbuka kalau ada, atau buka tab baru
// langsung ke halaman Absensi.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./app.html#absensi";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientsArr => {
      for (const client of clientsArr) {
        if (client.url.includes("app.html") && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
