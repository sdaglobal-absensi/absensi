// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../js/supabaseClient.js", () => ({ supabase: {} }));
const { openRequestModal } = await import("../js/requestModal.js");

const FIELDS = `
  <div class="form-row"><label>Tanggal <input type="date" name="date" required></label></div>
  <div class="form-row"><label>Alasan <textarea name="reason" required></textarea></label></div>`;

beforeEach(() => { document.body.innerHTML = ""; });

describe("openRequestModal", () => {
  it("menampilkan judul, catatan, dan mengisi nilai awal", () => {
    openRequestModal({ title: "Pengajuan X", fieldsHTML: FIELDS, notes: ["Catatan <b>1</b>"], values: { date: "2026-10-05" }, onSubmit: async () => true });
    expect(document.querySelector(".modal h3").textContent).toBe("Pengajuan X");
    expect(document.querySelector('input[name="date"]').value).toBe("2026-10-05");
    // catatan di-escape, bukan dirender sebagai HTML
    expect(document.querySelector(".req-notes li").innerHTML).toContain("&lt;b&gt;");
  });

  it("submit sukses menutup popup dan mengirim FormData", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { form } = openRequestModal({ title: "T", fieldsHTML: FIELDS, onSubmit });
    form.elements.date.value = "2026-10-06";
    form.elements.reason.value = "tes";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].get("reason")).toBe("tes");
    await vi.waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("submit gagal: popup tetap terbuka dan tombol aktif lagi", async () => {
    const { form } = openRequestModal({ title: "T", fieldsHTML: FIELDS, onSubmit: async () => false });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-x="ok"]').disabled).toBe(false));
    expect(document.querySelector(".modal")).not.toBeNull();
    expect(document.querySelector('[data-x="ok"]').textContent).toBe("Kirim Pengajuan");
  });

  it("Batal, Escape, dan klik latar menutup popup", () => {
    openRequestModal({ title: "T", fieldsHTML: FIELDS, onSubmit: async () => true });
    document.querySelector('[data-x="cancel"]').click();
    expect(document.querySelector(".modal")).toBeNull();

    openRequestModal({ title: "T", fieldsHTML: FIELDS, onSubmit: async () => true });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".modal")).toBeNull();

    openRequestModal({ title: "T", fieldsHTML: FIELDS, onSubmit: async () => true });
    document.querySelector(".modal").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("pesan validasi berbahasa Indonesia", () => {
    const { form } = openRequestModal({ title: "T", fieldsHTML: FIELDS, onSubmit: async () => true });
    form.elements.date.dispatchEvent(new Event("invalid"));
    expect(form.elements.date.validationMessage).toBe("Kolom ini wajib diisi.");
    form.elements.date.value = "2026-10-05";
    form.elements.date.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form.elements.date.validationMessage).toBe("");
  });
});
