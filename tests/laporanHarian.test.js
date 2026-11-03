import { describe, it, expect } from "vitest";
import { buildDailyRows, summarize, matchesStatusFilter, scheduleIdOn, addDaysISO, fmtDurasi } from "../js/laporanHarian.js";

const TODAY = "2026-10-24"; // Sabtu
const days = new Map([["S1", { is_working_day: true, start_time: "08:00:00", end_time: "17:00:00", crosses_midnight: false }]]);
const emp = (id, extra = {}) => ({ id, full_name: id, schedule_id: "S1", join_date: "2025-01-01", resign_date: null, ...extra });
const ci = (user_id, extra = {}) => ({ user_id, check_in: "2026-10-23T01:00:00Z", check_out: "2026-10-23T10:00:00Z", check_in_status: "tepat_waktu", ...extra });
const build = (o = {}) => buildDailyRows({ date: "2026-10-23", today: TODAY, emps: [], days, ...o });
const byId = res => Object.fromEntries(res.rows.map(r => [r.emp.id, r]));

describe("buildDailyRows — status per karyawan", () => {
  it("hadir tepat waktu vs terlambat mengikuti check_in_status", () => {
    const r = byId(build({ emps: [emp("A"), emp("B")], att: [ci("A"), ci("B", { check_in_status: "telat" })] }));
    expect(r.A.status).toBe("hadir_tepat");
    expect(r.B.status).toBe("hadir_telat");
  });
  it("tidak check-in di hari kerja yang sudah lewat = tidak hadir", () => {
    expect(byId(build({ emps: [emp("A")] })).A.status).toBe("tidak_hadir");
  });
  it("hari ini belum check-in = belum (bukan tidak hadir)", () => {
    expect(byId(build({ date: TODAY, emps: [emp("A")] })).A.status).toBe("belum");
  });
  it("izin/cuti/sakit yang DISETUJUI = izin; yang pending tetap tidak hadir dengan catatan", () => {
    const approved = byId(build({ emps: [emp("A")], leaves: [{ user_id: "A", status: "approved", type: "sakit" }] })).A;
    expect(approved.status).toBe("izin");
    const pending = byId(build({ emps: [emp("A")], leaves: [{ user_id: "A", status: "pending", type: "izin" }] })).A;
    expect(pending.status).toBe("tidak_hadir");
    expect(pending.keterangan).toMatch(/menunggu persetujuan/);
  });
  it("approved menang atas pending kalau dua-duanya mencakup tanggal ini", () => {
    const r = byId(build({ emps: [emp("A")], leaves: [{ user_id: "A", status: "pending" }, { user_id: "A", status: "approved" }] })).A;
    expect(r.status).toBe("izin");
  });
  it("hari libur nasional: yang tidak masuk = libur, yang masuk tetap hadir dengan catatan", () => {
    const res = build({ emps: [emp("A"), emp("B")], att: [ci("B")], holiday: { name: "Hari Raya" } });
    const r = byId(res);
    expect(r.A.status).toBe("libur");
    expect(r.A.keterangan).toBe("Hari Raya");
    expect(r.B.status).toBe("hadir_tepat");
    expect(r.B.keterangan).toMatch(/hari libur/);
  });
  it("bukan hari kerja menurut jadwal = libur (bukan tidak hadir)", () => {
    const off = new Map([["S1", { is_working_day: false }]]);
    expect(byId(build({ emps: [emp("A")], days: off })).A.status).toBe("libur");
  });
  it("izin di hari libur tetap libur", () => {
    const off = new Map([["S1", { is_working_day: false }]]);
    expect(byId(build({ emps: [emp("A")], days: off, leaves: [{ user_id: "A", status: "approved" }] })).A.status).toBe("libur");
  });
});

describe("buildDailyRows — siapa yang dilaporkan", () => {
  it("karyawan tanpa jadwal tidak dilaporkan tapi dihitung terpisah", () => {
    const res = build({ emps: [emp("A"), emp("ADMIN", { schedule_id: null })] });
    expect(res.rows.map(r => r.emp.id)).toEqual(["A"]);
    expect(res.tanpaJadwal).toBe(1);
  });
  it("tanpa jadwal tapi ada check-in tetap dilaporkan (hadir) dengan catatan", () => {
    const res = build({ emps: [emp("X", { schedule_id: null })], att: [ci("X")] });
    expect(res.rows[0].status).toBe("hadir_tepat");
    expect(res.rows[0].keterangan).toMatch(/Belum punya jadwal/);
  });
  it("belum masuk (join_date) atau sudah resign pada tanggal itu tidak dilaporkan", () => {
    const res = build({ emps: [emp("BARU", { join_date: "2026-10-24" }), emp("KELUAR", { resign_date: "2026-10-22" }), emp("A")] });
    expect(res.rows.map(r => r.emp.id)).toEqual(["A"]);
  });
  it("tukar shift (override) mengalahkan jadwal profil & riwayat", () => {
    const days2 = new Map([["S1", { is_working_day: false }], ["S2", { is_working_day: true, start_time: "20:00:00", end_time: "04:00:00", crosses_midnight: true }]]);
    const r = byId(build({ emps: [emp("A")], days: days2, ovr: new Map([["A", "S2"]]) })).A;
    expect(r.status).toBe("tidak_hadir");
    expect(r.jam).toEqual({ start: "20:00", end: "04:00", lintasHari: true });
  });
  it("memakai riwayat jadwal pada TANGGAL itu, bukan jadwal sekarang", () => {
    const hist = { A: [{ schedule_id: "S1", effective_from: "2026-10-25" }] };
    const res = build({ emps: [emp("A")], hist }); // 23 Okt: jadwal baru belum berlaku
    expect(res.rows).toHaveLength(0);
    expect(res.tanpaJadwal).toBe(1);
  });
});

describe("check-out & durasi", () => {
  it("menghitung durasi kerja dalam menit", () => {
    expect(byId(build({ emps: [emp("A")], att: [ci("A")] })).A.durasiMenit).toBe(540);
  });
  it("lupa check-out hanya untuk tanggal yang sudah lewat", () => {
    const att = [ci("A", { check_out: null })];
    expect(byId(build({ emps: [emp("A")], att })).A.lupaCheckout).toBe(true);
    expect(byId(build({ date: TODAY, emps: [emp("A")], att })).A.lupaCheckout).toBe(false);
  });
  it("baris yang hanya berisi check-out dianggap belum check-in", () => {
    const r = byId(build({ emps: [emp("A")], att: [{ user_id: "A", check_in: null, check_out: "2026-10-23T10:00:00Z" }] })).A;
    expect(r.status).toBe("tidak_hadir");
    expect(r.keterangan).toMatch(/lupa check-in/);
  });
});

describe("summarize & filter", () => {
  const res = build({
    emps: [emp("A"), emp("B"), emp("C"), emp("D"), emp("E")],
    att: [ci("A"), ci("B", { check_in_status: "telat", check_out: null })],
    leaves: [{ user_id: "C", status: "approved" }],
  });
  const s = summarize(res.rows);
  it("hitungan ringkasan", () => {
    expect(s).toMatchObject({ terjadwal: 5, hadir: 2, tepat: 1, telat: 1, izin: 1, tidakHadir: 2, belum: 0, lupaCheckout: 1 });
  });
  it("tingkat kehadiran = hadir ÷ (terjadwal − izin)", () => {
    expect(s.rate).toBe(50); // 2 dari 4
  });
  it("tanpa data terjadwal -> rate null", () => {
    expect(summarize([]).rate).toBeNull();
  });
  it("filter status", () => {
    const f = st => res.rows.filter(r => matchesStatusFilter(r, st)).map(r => r.emp.id);
    expect(f("")).toHaveLength(5);
    expect(f("hadir")).toEqual(["A", "B"]);
    expect(f("hadir_telat")).toEqual(["B"]);
    expect(f("absen")).toEqual(["D", "E"]);
    expect(f("izin")).toEqual(["C"]);
    expect(f("lupa_out")).toEqual(["B"]);
  });
});

describe("helper", () => {
  it("scheduleIdOn urut naik & tanggal sama berlaku", () => {
    const hist = { A: [{ schedule_id: "S1", effective_from: "2026-01-01" }, { schedule_id: "S2", effective_from: "2026-10-23" }] };
    expect(scheduleIdOn(hist, { id: "A" }, "2026-10-22")).toBe("S1");
    expect(scheduleIdOn(hist, { id: "A" }, "2026-10-23")).toBe("S2");
  });
  it("addDaysISO & fmtDurasi", () => {
    expect(addDaysISO("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
    expect(fmtDurasi(485)).toBe("8j 05m");
    expect(fmtDurasi(null)).toBe("-");
  });
});
