// Service worker KERJORA — HANYA untuk push notification (pengingat
// check-out). Sengaja tidak melakukan caching/offline apa pun, supaya
// tidak mengganggu perilaku app.html yang sudah ada (semua data tetap
// selalu diambil langsung dari Supabase seperti biasa).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// Edge Function checkout-reminder (lihat supabase/functions/checkout-reminder)
// mengirim payload JSON: { title, body, url }
self.addEventListener("push", event => {
  let data = { title: "KERJORA", body: "Jangan lupa check-out.", url: "./app.html#absensi" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // payload bukan JSON (harusnya tidak terjadi) — pakai default di atas
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "assets/icon-192.png",
      badge: "assets/icon-96.png",
      data: { url: data.url },
      tag: "kerjora-checkout-reminder", // notifikasi baru menggantikan yang lama, tidak menumpuk
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
