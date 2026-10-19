// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("js/fastRedirect.js", "utf8");

function run({ search = "", stored = null } = {}) {
  localStorage.clear();
  if (stored !== null) localStorage.setItem("absensi-auth", stored);
  const replace = vi.fn();
  const fakeLocation = { search, replace };
  new Function("location", "localStorage", src)(fakeLocation, localStorage);
  return replace;
}

beforeEach(() => localStorage.clear());

describe("fastRedirect (halaman login)", () => {
  it("ada sesi tersimpan -> langsung ke app.html", () => {
    const r = run({ stored: JSON.stringify({ refresh_token: "abc", access_token: "x" }) });
    expect(r).toHaveBeenCalledWith("app.html");
  });
  it("tidak ada sesi -> tetap di halaman login", () => {
    expect(run({ stored: null })).not.toHaveBeenCalled();
  });
  it("data rusak / tanpa refresh_token -> tetap di halaman login", () => {
    expect(run({ stored: "bukan json" })).not.toHaveBeenCalled();
    expect(run({ stored: JSON.stringify({ access_token: "x" }) })).not.toHaveBeenCalled();
  });
  it("?reason=... / ?reset=... -> tidak redirect (cegah putaran)", () => {
    const s = JSON.stringify({ refresh_token: "abc" });
    expect(run({ search: "?reason=no-profile", stored: s })).not.toHaveBeenCalled();
    expect(run({ search: "?reason=inactive", stored: s })).not.toHaveBeenCalled();
    expect(run({ search: "?reset=success", stored: s })).not.toHaveBeenCalled();
  });
});
