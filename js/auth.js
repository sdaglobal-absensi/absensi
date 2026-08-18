/* ======================================================================
   AUTH — layar login & daftar. Independen dari sistem modul (berjalan
   sebelum pengguna login, jadi belum ada profil/role).
   ====================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);

  $("go-signup").onclick = () => { $("mode-login").style.display = "none"; $("mode-signup").style.display = "block"; clearMsg(); };
  $("go-login").onclick = () => { $("mode-signup").style.display = "none"; $("mode-login").style.display = "block"; clearMsg(); };

  function clearMsg() { const m = $("auth-msg"); m.className = "auth-msg"; m.textContent = ""; }
  function showMsg(text, type) { const m = $("auth-msg"); m.className = "auth-msg " + type; m.textContent = text; }

  function translateAuthError(msg) {
    if (/already registered/i.test(msg)) return "Email sudah terdaftar.";
    if (/Invalid login credentials/i.test(msg)) return "Email atau kata sandi salah.";
    if (/Password should be/i.test(msg)) return "Kata sandi minimal 6 karakter.";
    return msg;
  }

  $("btn-login").onclick = async () => {
    clearMsg();
    const email = $("li-email").value.trim();
    const password = $("li-pass").value;
    if (!email || !password) { showMsg("Email dan kata sandi wajib diisi.", "error"); return; }
    $("btn-login").disabled = true; $("btn-login").textContent = "Memproses…";
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $("btn-login").disabled = false; $("btn-login").textContent = "Masuk";
    if (error) showMsg(translateAuthError(error.message), "error");
  };

  $("btn-signup").onclick = async () => {
    clearMsg();
    const full_name = $("su-name").value.trim();
    const email = $("su-email").value.trim();
    const password = $("su-pass").value;
    if (!full_name || !email || !password) { showMsg("Lengkapi semua kolom.", "error"); return; }
    if (password.length < 6) { showMsg("Kata sandi minimal 6 karakter.", "error"); return; }
    $("btn-signup").disabled = true; $("btn-signup").textContent = "Memproses…";
    const { error } = await sb.auth.signUp({ email, password, options: { data: { full_name } } });
    $("btn-signup").disabled = false; $("btn-signup").textContent = "Daftar";
    if (error) { showMsg(translateAuthError(error.message), "error"); return; }
    showMsg("Akun berhasil dibuat. Silakan masuk.", "ok");
    $("mode-signup").style.display = "none"; $("mode-login").style.display = "block";
  };

  $("btn-logout").onclick = () => App.logout();
})();
