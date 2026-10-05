// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const logout = vi.fn().mockResolvedValue();
vi.mock("../js/supabaseClient.js", () => ({ supabase: { rpc: (...a) => rpc(...a) } }));
vi.mock("../js/auth.js", () => ({ logout: (...a) => logout(...a) }));
const { ensurePrivacyConsent, PRIVACY_VERSION } = await import("../js/privacy.js");

beforeEach(() => { document.body.innerHTML = ""; rpc.mockReset(); logout.mockClear(); });

describe("ensurePrivacyConsent", () => {
  it("tidak menampilkan apa pun bila sudah setuju", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    await ensurePrivacyConsent();
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("tidak mengunci aplikasi bila RPC belum ada (migrasi 019 belum dijalankan)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "function not found" } });
    await ensurePrivacyConsent();
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("tombol Setuju mati sampai kotak dicentang, lalu mencatat persetujuan", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const done = ensurePrivacyConsent();
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const [reject, accept] = document.querySelectorAll(".modal-actions button");
    expect(reject.textContent).toBe("Tolak & Keluar");
    expect(accept.disabled).toBe(true);

    const cb = document.querySelector('.modal input[type="checkbox"]');
    cb.checked = true; cb.dispatchEvent(new Event("change"));
    expect(accept.disabled).toBe(false);

    rpc.mockResolvedValueOnce({ error: null });
    accept.click();
    await done;
    expect(rpc).toHaveBeenLastCalledWith("accept_privacy", { p_version: PRIVACY_VERSION });
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("Tolak & Keluar memanggil logout dan TIDAK mencatat persetujuan", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    ensurePrivacyConsent();
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    document.querySelector(".modal-actions button").click();
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledTimes(1); // hanya has_accepted_privacy
  });

  it("gagal menyimpan: popup tetap, pesan galat tampil, bisa coba lagi", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    ensurePrivacyConsent();
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const cb = document.querySelector('.modal input[type="checkbox"]');
    cb.checked = true; cb.dispatchEvent(new Event("change"));
    rpc.mockResolvedValueOnce({ error: { message: "boom" } });
    const accept = document.querySelectorAll(".modal-actions button")[1];
    accept.click();
    await vi.waitFor(() => expect(document.querySelector(".modal").textContent).toContain("Gagal menyimpan persetujuan: boom"));
    expect(accept.disabled).toBe(false);
  });
});
