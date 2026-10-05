// =======================================================================
// Helper Excel bersama untuk fitur Template / Import / Export di halaman
// master (Data Karyawan, Master Tunjangan, Master Departemen).
// Memakai SheetJS (window.XLSX, dimuat lewat <script> di app.html).
// =======================================================================

export function hasXLSX() { return typeof XLSX !== "undefined"; }

// Normalisasi nama kolom supaya "Kode Karyawan", "kode_karyawan", dan
// " KODE  KARYAWAN " dianggap sama.
export const normKey = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Baca sheet pertama -> array baris. Tiap baris: { _row: nomorBarisExcel, get(...namaKolom) }.
export async function readFirstSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
  return raw.map((r, i) => {
    const map = {};
    Object.keys(r).forEach(k => { map[normKey(k)] = r[k]; });
    return {
      _row: i + 2, // baris 1 = header
      keys: Object.keys(r),
      get: (...names) => {
        for (const n of names) { const v = map[normKey(n)]; if (v !== undefined && v !== "") return v; }
        return "";
      },
    };
  }).filter(r => r.keys.some(k => String(r.get(k)).trim() !== ""));
}

export const cellText = v => String(v ?? "").trim();

// Sel tanggal Excel bisa berupa angka serial, "2025-11-21", atau "21/11/2025".
// Hasil: "YYYY-MM-DD", "" kalau kosong, null kalau formatnya tidak dikenali.
export function cellDateISO(v) {
  if (v === "" || v == null) return "";
  const pad = n => String(n).padStart(2, "0");
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return null;
}
function validDate(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Angka rupiah: 153210, "153.210", "Rp 153.210" -> 153210. NaN kalau bukan angka.
export function cellNumber(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  if (!/^[\sRrPp.,\d]+$/.test(s)) return NaN;
  const digits = s.replace(/\D/g, "");
  return digits ? Number(digits) : NaN;
}

// Tulis file .xlsx. sheets = [{ name, rows: [[...], ...], widths?: [..] }]
// Sheet pertama adalah yang dibaca saat import.
export function writeWorkbook(filename, sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(sh => {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    if (sh.widths) ws["!cols"] = sh.widths.map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, sh.name);
  });
  XLSX.writeFile(wb, filename);
}

export function widthsFor(headers, rows = [], min = 12, max = 40) {
  return headers.map((h, i) => {
    const longest = Math.max(String(h).length, ...rows.map(r => String(r[i] ?? "").length));
    return Math.min(max, Math.max(min, longest + 2));
  });
}

export function pickFileThen(inputEl, handler) {
  inputEl.addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = ""; // supaya file yang sama bisa dipilih ulang
    if (file) await handler(file);
  });
}
