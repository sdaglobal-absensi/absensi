// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../js/supabaseClient.js", () => ({ supabase: {} }));
await import("../js/core.js"); // memasang pengamat modal global

beforeEach(() => { document.body.innerHTML = ""; });

describe("modal selalu terbuka dari atas", () => {
  it("scroll kotak modal di-reset saat class hidden dilepas", async () => {
    document.body.innerHTML = `<div id="m" class="modal hidden"><div class="modal-box"><form></form></div></div>`;
    const modal = document.getElementById("m");
    const box = modal.querySelector(".modal-box");
    box.scrollTop = 500; // sisa posisi scroll (jsdom menyimpan nilai ini apa adanya)
    modal.classList.remove("hidden");
    await vi.waitFor(() => expect(box.scrollTop).toBe(0));
  });

  it("modal yang dibuat dinamis (langsung tampil) juga di-reset", async () => {
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<div class="modal-box"></div>`;
    modal.querySelector(".modal-box").scrollTop = 300;
    document.body.appendChild(modal);
    await vi.waitFor(() => expect(modal.querySelector(".modal-box").scrollTop).toBe(0));
  });
});
