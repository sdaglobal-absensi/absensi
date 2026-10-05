    import { supabase } from "../supabaseClient.js";
    import { setupCaptcha } from "../captcha.js";

    // CAPTCHA (Turnstile): widget dipasang saat form pendaftaran tampil.
    let capCtl = null;
    const cap = () => (capCtl ||= setupCaptcha(document.getElementById("captcha-daftar")));

    const PANELS = ["loading", "closed", "akun", "cek-email", "usaha", "selesai"];
    const show = name => {
      PANELS.forEach(p => document.getElementById("panel-" + p).classList.toggle("hidden", p !== name));
      if (name === "akun") cap();
    };
    const DRAFT_KEY = "kerjora-daftar-draft";
    const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; } };
    const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} };

    // Terjemahan pesan error yang paling sering muncul
    function friendly(err) {
      const m = String(err?.message || err);
      if (/already registered|already been registered/i.test(m)) return "Email ini sudah terdaftar. Silakan masuk, atau pakai email lain.";
      if (/password/i.test(m) && /(least|short|weak)/i.test(m)) return "Password terlalu pendek atau mudah ditebak.";
      if (/rate limit|too many|security purposes/i.test(m)) return "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.";
      if (/belum dibuka/i.test(m)) return "Pendaftaran usaha belum dibuka.";
      if (/captcha/i.test(m)) return "Verifikasi CAPTCHA gagal. Coba lagi.";
      if (/sudah terdaftar di sebuah usaha/i.test(m)) return "Akun ini sudah punya usaha. Silakan masuk.";
      return m;
    }

    async function createBusiness(namaUsaha, fullName) {
      const { error } = await supabase.rpc("register_tenant", { p_nama_usaha: namaUsaha.trim(), p_full_name: fullName.trim() });
      if (error) throw error;
      clearDraft();
      const { data: p } = await supabase.from("profiles").select("tenant_id").maybeSingle();
      const { data: t } = p ? await supabase.from("tenants").select("kode").eq("id", p.tenant_id).maybeSingle() : { data: null };
      document.getElementById("kode-usaha").textContent = t?.kode || "(lihat di aplikasi)";
      show("selesai");
    }

    (async () => {
      let open = false;
      try { open = (await supabase.rpc("public_signup_open")).data === true; } catch {}
      if (!open) return show("closed");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return show("akun");

      // Sudah login: kalau sudah punya usaha -> ke aplikasi; kalau belum -> langkah 2
      const { data: prof } = await supabase.from("profiles").select("id").eq("id", session.user.id).maybeSingle();
      if (prof) { location.replace("app.html"); return; }
      const d = readDraft();
      const f = document.getElementById("form-usaha");
      f.nama_usaha.value = d.nama_usaha || "";
      f.full_name.value = d.full_name || "";
      show("usaha");
    })();

    document.getElementById("form-akun").addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("akun-error");
      const btn = e.target.querySelector('button[type="submit"]');
      errEl.textContent = ""; btn.disabled = true;
      const namaUsaha = String(fd.get("nama_usaha")), fullName = String(fd.get("full_name"));
      const email = String(fd.get("email")).trim();
      try {
        try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ nama_usaha: namaUsaha, full_name: fullName })); } catch {}
        const captchaToken = await cap().getToken();
        const { data, error } = await supabase.auth.signUp({
          email, password: String(fd.get("password")),
          options: { emailRedirectTo: new URL("daftar.html?lanjut=1", location.href).href, captchaToken },
        });
        if (error) throw error;
        // Email yang sudah terdaftar: Supabase mengembalikan user tanpa identities
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error("Email ini sudah terdaftar. Silakan masuk, atau pakai email lain.");
        }
        if (data.session) {            // konfirmasi email dimatikan -> langsung lanjut
          await createBusiness(namaUsaha, fullName);
        } else {
          document.getElementById("email-sent").textContent = email;
          show("cek-email");
        }
      } catch (err) {
        errEl.textContent = friendly(err);
        btn.disabled = false;
        cap().reset();
      }
    });

    document.getElementById("form-usaha").addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = document.getElementById("usaha-error");
      const btn = e.target.querySelector('button[type="submit"]');
      errEl.textContent = ""; btn.disabled = true;
      try {
        await createBusiness(String(fd.get("nama_usaha")), String(fd.get("full_name")));
      } catch (err) {
        errEl.textContent = friendly(err);
        btn.disabled = false;
      }
    });
  
