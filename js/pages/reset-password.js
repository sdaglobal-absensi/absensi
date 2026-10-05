    import { supabase } from "../supabaseClient.js";
    import { wirePasswordToggles } from "../core.js";

    wirePasswordToggles();

    // supabase-js otomatis membaca token recovery dari URL (#access_token=...)
    // dan membuat session sementara khusus untuk ganti password.
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        show("panel-form");
      }
    });

    // Fallback: kalau event PASSWORD_RECOVERY sudah lewat sebelum listener
    // terpasang, cek session yang ada.
    setTimeout(async () => {
      if (document.getElementById("panel-loading").classList.contains("hidden")) return;
      const { data: { session } } = await supabase.auth.getSession();
      show(session ? "panel-form" : "panel-invalid");
    }, 1500);

    function show(id) {
      ["panel-loading", "panel-form", "panel-invalid"].forEach(p =>
        document.getElementById(p).classList.toggle("hidden", p !== id)
      );
    }

    document.getElementById("form-reset").addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("reset-error");
      errEl.textContent = "";

      if (fd.get("password") !== fd.get("password2")) {
        errEl.textContent = "Password tidak sama.";
        return;
      }

      try {
        const { error } = await supabase.auth.updateUser({ password: fd.get("password") });
        if (error) throw error;
        await supabase.auth.signOut();
        window.location.href = "index.html?reset=success";
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  
