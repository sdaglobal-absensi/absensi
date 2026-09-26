import { supabase } from "./supabaseClient.js";

// ---------------------------------------------------------------------
// Ambil sesi & profil user yang sedang login. Return null kalau belum login.
// ---------------------------------------------------------------------
export async function getCurrentUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !profile) return null;
  return { ...profile, email: session.user.email };
}

// ---------------------------------------------------------------------
// Wajib dipanggil di setiap halaman terproteksi. Redirect ke login kalau
// belum authenticated, atau redirect kalau role tidak diizinkan.
// ---------------------------------------------------------------------
export async function requireAuth(allowedRoles = null) {
  let user;
  try {
    user = await getCurrentUser();
  } catch (e) {
    console.error("requireAuth error:", e);
    user = null;
  }
  if (!user) {
    // Cek dulu apakah sebenarnya ada session tapi baris profiles-nya
    // yang bermasalah (RLS / trigger tidak jalan) — beri pesan jelas
    // di halaman login alih-alih diam-diam redirect (penyebab loop).
    const { data: { session } } = await supabase.auth.getSession();
    window.location.href = session ? "index.html?reason=no-profile" : "index.html";
    return null;
  }
  if (!user.is_active) {
    await supabase.auth.signOut();
    window.location.href = "index.html?reason=inactive";
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    window.location.href = "app.html?reason=forbidden";
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------
export async function logout() {
  await supabase.auth.signOut();
  window.location.href = "index.html";
}
