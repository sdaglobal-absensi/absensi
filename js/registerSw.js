// Daftarkan service worker + tampilkan banner bila ada versi baru.
// Dipisah dari HTML supaya Content-Security-Policy tidak perlu 'unsafe-inline'.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    let reg;
    try { reg = await navigator.serviceWorker.register("./sw.js"); } catch { return; }

    const showUpdateBanner = worker => {
      if (document.getElementById("sw-update-banner")) return;
      const bar = document.createElement("div");
      bar.id = "sw-update-banner";
      bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#1F4D3A;color:#fff;padding:12px 16px;border-radius:10px;display:flex;gap:12px;align-items:center;justify-content:space-between;box-shadow:0 4px 16px rgba(0,0,0,.25);";
      const msg = document.createElement("span");
      msg.textContent = "Versi baru KERJORA tersedia.";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Muat ulang";
      btn.style.cssText = "background:#fff;color:#1F4D3A;border:0;border-radius:8px;padding:6px 12px;font-weight:600;cursor:pointer;";
      btn.addEventListener("click", () => worker.postMessage("SKIP_WAITING"));
      bar.append(msg, btn);
      document.body.appendChild(bar);
    };

    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(nw);
      });
    });

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  });
}
