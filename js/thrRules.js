// Aturan hitung THR — fungsi murni (tanpa database/DOM) supaya mudah dites.
// Dipakai oleh js/modules/admin-thr.js. Lihat komentar aturan di file itu.
const NUM = n => Math.round(Number(n) || 0);

// Masa kerja dari tanggal masuk sampai tanggal acuan.
//   full     = bulan PENUH yang sudah dilalui (dasar syarat "minimal 1 bulan")
//   dipakai  = bulan yang dipakai di rumus (maks 12). Pembulatan 'atas15':
//              sisa hari >= 15 dibulatkan ke 1 bulan lagi.
export function masaKerja(joinISO, refISO, pembulatan = "bawah") {
  if (!joinISO || !refISO || joinISO > refISO) return { full: 0, dipakai: 0, sisaHari: 0 };
  const [jy, jm, jd] = joinISO.split("-").map(Number);
  const [ry, rm, rd] = refISO.split("-").map(Number);
  // tanggal masuk + n bulan, dijepit ke akhir bulan (mis. 31 Jan + 1 bln = 28/29 Feb)
  const anchor = n => {
    const last = new Date(Date.UTC(jy, jm - 1 + n + 1, 0)).getUTCDate();
    return Date.UTC(jy, jm - 1 + n, Math.min(jd, last));
  };
  const ref = Date.UTC(ry, rm - 1, rd);
  let full = (ry - jy) * 12 + (rm - jm);
  while (full > 0 && anchor(full) > ref) full--;
  const sisaHari = Math.round((ref - anchor(full)) / 86400000);
  const dipakai = Math.min(12, full + (pembulatan === "atas15" && sisaHari >= 15 ? 1 : 0));
  return { full, dipakai, sisaHari };
}

// Tanggal acuan dikurangi n bulan (untuk jendela 12 bulan terakhir).
export function addMonthsISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

// pay: { reference_date, pembulatan, include_tunjangan, pph21_persen }
// salary: baris salary_history terbaru <= tanggal acuan (atau undefined)
// allowances: [{ nama, nominal }]   slips: [{ period, pokok, tunjangan }] (terbaru dulu, maks 12)
export function computeThr({ emp, pay, salary, allowances = [], slips = [] }) {
  const mk = masaKerja(emp.join_date, pay.reference_date, pay.pembulatan);
  const warnings = [];
  const include = pay.include_tunjangan !== false;
  const tunjangan = include ? allowances.map(a => ({ nama: a.nama, nominal: NUM(a.nominal) })) : [];
  const tunjanganTotal = tunjangan.reduce((s, t) => s + t.nominal, 0);

  const snap = {
    emp: {
      id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code || "", position: emp.position || "",
      department: emp.department || "", bagian: emp.bagian || "", unit_pt: emp.unit_pt || "",
      status_karyawan: emp.status_karyawan || "", join_date: emp.join_date || null,
    },
    reference_date: pay.reference_date, pembulatan: pay.pembulatan,
    masa_kerja_bulan: mk.full, masa_kerja_dipakai: mk.dipakai, masa_kerja_sisa_hari: mk.sisaHari,
    eligible: true, alasan: "", basis: null,
    gaji_pokok: 0, tunjangan, tunjangan_total: tunjanganTotal, upah_sebulan: 0, slip_count: 0,
    faktor: 0, rumus: "", thr_bruto: 0, pph21_persen: Number(pay.pph21_persen) || 0, pph21: 0, thr_neto: 0,
    warnings, manual: false, catatan: "",
  };
  const done = () => {
    snap.pph21 = NUM(snap.thr_bruto * snap.pph21_persen / 100);
    snap.thr_neto = snap.thr_bruto - snap.pph21;
    return { eligible: snap.eligible, thr_bruto: snap.thr_bruto, pph21: snap.pph21, thr_neto: snap.thr_neto, snapshot: snap };
  };
  const tidakBerhak = alasan => { snap.eligible = false; snap.alasan = alasan; snap.rumus = alasan; return done(); };

  if (!emp.join_date) return tidakBerhak("Tanggal masuk belum diisi di Data Karyawan");
  if (emp.join_date > pay.reference_date) return tidakBerhak("Belum masuk pada tanggal acuan");
  if (mk.full < 1) return tidakBerhak("Masa kerja kurang dari 1 bulan");
  if (emp.status_karyawan !== "bulanan" && emp.status_karyawan !== "harian") return tidakBerhak("Status karyawan (Bulanan/Harian) belum diatur");

  snap.basis = emp.status_karyawan;
  if (emp.status_karyawan === "bulanan") {
    snap.gaji_pokok = NUM(salary?.monthly_salary);
    if (!salary) warnings.push("Riwayat gaji bulanan belum ada pada tanggal acuan");
    snap.upah_sebulan = snap.gaji_pokok + tunjanganTotal;
  } else {
    // harian: rata-rata dari slip final (<= 12 bulan terakhir)
    const n = slips.length;
    snap.slip_count = n;
    const avgPokok = n ? slips.reduce((s, x) => s + NUM(x.pokok), 0) / n : 0;
    const avgTunj = n && include ? slips.reduce((s, x) => s + NUM(x.tunjangan), 0) / n : 0;
    snap.gaji_pokok = NUM(avgPokok);
    snap.tunjangan = include && n ? [{ nama: "Tunjangan (rata-rata slip)", nominal: NUM(avgTunj) }].filter(t => t.nominal > 0) : [];
    snap.tunjangan_total = snap.tunjangan.reduce((s, t) => s + t.nominal, 0);
    snap.upah_sebulan = snap.gaji_pokok + snap.tunjangan_total;
    const diharapkan = Math.min(12, mk.full);
    if (!n) warnings.push("Belum ada slip gaji final untuk pekerja harian ini; isi THR manual");
    else if (n < diharapkan) warnings.push(`Rata-rata hanya dari ${n} slip final (masa kerja ${mk.full} bulan); cek apakah sudah sesuai`);
  }
  if (snap.upah_sebulan <= 0 && !warnings.length) warnings.push("Dasar upah Rp 0");

  snap.faktor = mk.dipakai >= 12 ? 1 : mk.dipakai / 12;
  snap.thr_bruto = NUM(snap.upah_sebulan * snap.faktor);
  snap.rumus = mk.dipakai >= 12
    ? "1 bulan upah (masa kerja 12 bulan atau lebih)"
    : `${mk.dipakai}/12 × upah sebulan (prorata, masa kerja ${mk.full} bulan${mk.dipakai > mk.full ? " dibulatkan ke atas" : ""})`;
  return done();
}
