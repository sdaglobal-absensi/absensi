# Tahap 4 — Paket & Fitur, Template UMKM (2 Role), Modul Opsional

## Yang baru

| Fitur | Di mana |
|---|---|
| **Paket** (`plans`): Gratis, Bisnis, Enterprise, Internal. Tiap paket punya batas karyawan dan daftar fitur | `004_tahap4_paket_fitur.sql` |
| **Fitur dikunci di SERVER**, bukan hanya disembunyikan: `has_menu_access()` ikut memeriksa paket, dan tabel milik fitur berbayar punya policy RLS `feature_gate` | SQL 004 |
| **Override per usaha**: tambah atau cabut satu fitur untuk satu usaha tanpa mengganti paket (`tenant_features`) | SQL 004 |
| **Menu di luar paket hilang** dari sidebar, termasuk untuk Super Admin | `js/core.js`, `app.html` |
| **Halaman Paket & Fitur** (baca-saja): paket, pemakaian karyawan, fitur yang termasuk / belum | `js/modules/super-paket.js` |
| **Template ringkas UMKM**: hanya 2 role (Pemilik dan Karyawan). Role lain ditolak oleh database | `tenants.role_mode`, trigger `ab_profiles_role_mode` |
| **Modul opsional**: Master PT/Vendor dan Invoice Outsourcing jadi fitur `vendor_invoice` (butuh `payroll`) | SQL 004 |
| **Helper pemilik platform** (`platform_set_plan`, dst.) lewat SQL Editor | SQL 004 |

## Isi paket bawaan

| Fitur | Gratis | Bisnis | Enterprise | Internal |
|---|:-:|:-:|:-:|:-:|
| Dasar (profil, absensi, riwayat, data karyawan, monitor absensi, laporan, master lokasi/jadwal/libur/level/departemen, approval perubahan data, pengaturan sistem) | ✔ | ✔ | ✔ | ✔ |
| `izin_cuti` — izin/sakit/cuti, kuota cuti | ✔ | ✔ | ✔ | ✔ |
| `koreksi_absen` | ✔ | ✔ | ✔ | ✔ |
| `lembur` | | ✔ | ✔ | ✔ |
| `struktur` — struktur organisasi & approval berjenjang | | ✔ | ✔ | ✔ |
| `payroll` — slip gaji, tunjangan, denda telat, kenaikan upah | | ✔ | ✔ | ✔ |
| `audit_ekspor` — audit log, ekspor & backup | | ✔ | ✔ | ✔ |
| `vendor_invoice` — Master PT/Vendor, invoice outsourcing | | | ✔ | ✔ |
| **Maks. karyawan** | 10 | 50 | tanpa batas | tanpa batas |

**Usaha utama (paket `internal`) tidak berubah sama sekali**: semua fitur, role lengkap.

Di paket Gratis tanpa Struktur Organisasi, pengajuan izin otomatis masuk ke Pemilik (aturan fallback approver yang sudah ada), jadi alurnya tetap jalan.

Angka dan isi paket bisa diubah kapan saja (skrip tidak menimpa kalau dijalankan ulang):

```sql
update plans set max_karyawan = 25 where kode = 'bisnis';
update plans set features = features || '{lembur}' where kode = 'free';   -- tambah fitur ke paket
```

Perubahan di tabel `plans` langsung berlaku untuk semua usaha di paket itu (fitur), tetapi **batas karyawan** usaha yang sudah ada baru ikut berubah lewat `platform_set_plan()`.

## Urutan pasang (± 15 menit)

1. **Backup** database (Dashboard → Database → Backups).
2. **SQL Editor** → jalankan seluruh `004_tahap4_paket_fitur.sql`. Harus muncul notice `OK — Tahap 4 (SQL) terpasang. Usaha utama: paket "internal", 7 fitur aktif.` Aman dijalankan dua kali.
   - Usaha non-utama yang nama paketnya bukan salah satu paket di atas dipindah ke `free` (ada notice jumlahnya).
3. **Upload file aplikasi**: `app.html`, `css/style.css`, `js/core.js`, dan di `js/modules/`: **`super-paket.js`** (baru), `super-pengaturan.js`, `admin-struktur-organisasi.js`.
   - Tidak ada Edge Function yang berubah, jadi tidak perlu deploy ulang.
4. **Tes sebagai Super Admin usaha utama** (harus sama persis seperti sebelum tahap 4):
   - Semua menu lama tetap ada di sidebar, ditambah **Paket & Fitur** di grup Super Admin.
   - Halaman Paket & Fitur menampilkan paket **Internal**, 7 fitur "Termasuk".
   - Pengaturan Sistem tetap menampilkan 4 kolom role.
5. **Tes dua usaha uji** (buat lewat SQL Editor, akun dibuat dulu di Authentication → Users dengan Auto Confirm):

   ```sql
   -- Gratis + template ringkas (bawaan)
   select public.create_tenant_for_owner('Toko Uji', 'tokouji',
     (select id from auth.users where email = 'owner-uji@contoh.com'), 'Pemilik Uji');
   -- Bisnis + template lengkap
   select public.create_tenant_for_owner('Toko Bisnis', 'tokobisnis',
     (select id from auth.users where email = 'owner-bisnis@contoh.com'), 'Pemilik Bisnis',
     'bisnis', null, 'lengkap');
   ```

   Login sebagai pemilik **Toko Uji** (Gratis):
   - Sidebar **tidak** punya: Pengajuan Lembur, Approval Lembur, Struktur Organisasi, Slip Gaji (dan turunannya), Audit Log, Ekspor & Backup, Master PT, Invoice Outsourcing.
   - Buka `app.html#lembur` langsung di address bar → muncul pesan "Fitur ini tidak termasuk paket usahamu".
   - Pengaturan Sistem hanya punya kolom **Akses Karyawan**, tanpa baris menu di luar paket.
   - Karyawan di usaha ini bisa absen dan mengajukan izin, izinnya masuk ke Pemilik.
   - Setelah usaha ini di-upgrade ke Bisnis, Struktur Organisasi hanya menawarkan role Karyawan/Super Admin (template ringkas tetap berlaku).

   Login sebagai pemilik **Toko Bisnis**: lembur, slip gaji, audit log, ekspor, struktur ada; Master PT dan Invoice **tidak** ada.
6. **Tes upgrade**: `select platform_set_plan('tokouji', 'bisnis');` lalu muat ulang halaman pemilik Toko Uji → menu lembur dst. muncul, data lama utuh.

## Cara mengatur paket (pemilik aplikasi, lewat SQL Editor)

```sql
select * from platform_tenant_overview();                       -- semua usaha: paket, mode, fitur aktif, override

select platform_set_plan('tokouji', 'bisnis');                  -- ganti paket (ikut mengganti batas karyawan)
select platform_set_plan('tokouji', 'free', true);              -- turun paket, pertahankan batas lama

select platform_set_feature('tokouji', 'lembur', true);         -- tambah satu fitur di luar paket
select platform_set_feature('tokouji', 'audit_ekspor', false);  -- cabut satu fitur dari paket
select platform_clear_feature('tokouji', 'lembur');             -- kembali ke aturan paket

select platform_set_role_mode('tokouji', 'ringkas', true);      -- ke 2 role; anggota ber-role lain jadi Karyawan
select platform_set_role_mode('tokouji', 'lengkap');            -- kembali ke 5 role
```

Penjagaan bawaan:
- Turun paket ditolak kalau jumlah karyawan melebihi batas paket baru (kecuali `true` untuk mempertahankan batas lama).
- Kombinasi fitur yang melanggar ketergantungan ditolak (mis. `vendor_invoice` tanpa `payroll`, atau mencabut `payroll` saat `vendor_invoice` aktif).
- Pindah ke `ringkas` ditolak kalau masih ada anggota ber-role lain, kecuali `p_convert => true`.
- Semua fungsi `platform_*` **tidak bisa dipanggil dari aplikasi**, hanya dari SQL Editor / service role.
- Perubahan lewat SQL Editor tidak masuk Audit Log (sama seperti migrasi lain).

Setelah paket diubah, pengguna yang sedang membuka aplikasi baru melihat perubahannya saat memuat ulang halaman.

## Usaha baru

`create_tenant_for_owner(nama, kode, owner, nama_pemilik, paket = 'free', max_karyawan = null, template = 'ringkas')`. Parameter baru ada di belakang, jadi pemanggilan lama dengan 4 argumen tetap jalan, tetapi sekarang menghasilkan **paket Gratis + template ringkas**. `register_tenant` (pendaftaran publik) juga memakai Gratis + ringkas. Template `ringkas` memberi karyawan hanya menu pribadi dan mematikan semua role lain.

## Data tidak hilang saat paket turun

Policy `feature_gate` hanya menutup akses baca/tulis. Data lembur, slip gaji, invoice, dan lainnya tetap ada di database dan terbaca lagi begitu fiturnya aktif. Tabel `audit_log` hanya dikunci untuk dibaca; pencatatan tetap berjalan.

## Kalau ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| Menu baru "Paket & Fitur" menampilkan "belum bisa dimuat" | SQL 004 belum dijalankan, atau terjadi galat jaringan; muat ulang. |
| Semua menu tetap muncul padahal paket Gratis | `js/core.js` lama masih di-cache browser (Ctrl+Shift+R), atau SQL 004 belum dijalankan. Server tetap menolak aksinya. |
| Menu hilang setelah upgrade paket | Muat ulang halaman; info paket di-cache selama halaman terbuka. |
| `platform_set_plan` menolak: melebihi batas | Kurangi karyawan, atau pakai `platform_set_plan(kode, paket, true)`. |
| Gagal mengubah role: "template ringkas: hanya ada 2 role" | Usaha itu memakai mode ringkas. `platform_set_role_mode(kode, 'lengkap')` untuk membukanya. |
| Karyawan di paket Gratis tidak melihat Slip Gaji Saya | Normal: `slip-gaji-saya` ikut fitur `payroll`. |

### Mundur
Jalankan `004z_rollback_tahap4.sql`, lalu upload kembali JS Tahap 3 (`super-paket.js` boleh dihapus). Semua fitur terbuka lagi untuk semua usaha, template ringkas dicabut, tabel paket/fitur dihapus. Data usaha tidak disentuh.

## Catatan penting

- **Paket tidak menggantikan role.** Menu harus lolos dua pemeriksaan: ada di paket usaha, DAN diizinkan untuk role itu di Pengaturan Sistem (Super Admin melewati yang kedua, bukan yang pertama).
- **Pembayaran belum ada.** Tidak ada penagihan atau upgrade mandiri; paket diganti manual lewat SQL. Itu isi Tahap 5 (billing + halaman admin platform).
- **Sebelum menyalakan `public_mode`**, syarat dari Tahap 3 tetap berlaku (CAPTCHA, uji dua usaha sungguhan, email konfirmasi). Tambahan dari tahap ini: putuskan dulu paket mana yang boleh dipilih pendaftar baru (sekarang otomatis Gratis, 10 karyawan).
- Kolom `trial_ends_at` dan status `trial` hanya ditampilkan di halaman Paket & Fitur; belum ada pemblokiran otomatis saat percobaan habis (Tahap 5).
- Kuota karyawan dihitung dari semua baris `profiles` di usaha itu (sama seperti aturan batas yang sudah ada sejak Tahap 1), termasuk akun nonaktif.

## Yang sudah diuji / belum

**Sudah (PostgreSQL 16 di atas skema asli proyek, semua file SQL lama + 001 + 002 + 002b + 003, dengan tiruan `auth` dan `storage`):**
- SQL 004 aman dijalankan dua kali; rollback jalan, aman dijalankan dua kali, dan 004 bisa dipasang ulang setelahnya.
- 40 tes skenario lolos: paket & template terisi benar untuk tiga jenis usaha (Gratis/ringkas, Bisnis/lengkap, Internal); template ringkas hanya menyalakan menu pribadi karyawan; trigger menolak role selain Pemilik/Karyawan di mode ringkas dan menerimanya di mode lengkap; di usaha Gratis insert lembur/payroll ditolak RLS, baca slip gaji dan audit log kosong, izin tetap bisa diajukan; usaha Bisnis bisa lembur dan tidak melihat data usaha lain; audit log tetap tertulis untuk usaha tanpa fitur audit; user biasa tidak bisa memanggil `platform_*`, `effective_features`, atau membaca tabel `plans`; override fitur, pemeriksaan ketergantungan, upgrade, turun paket melebihi batas, `p_keep_limit`, konversi role, dan `register_tenant` bekerja.
- Pengajuan izin di usaha Gratis (tanpa struktur organisasi) masuk ke Pemilik dan bisa disetujui.
- Logika JS di Node dengan klien Supabase tiruan: penyaringan menu untuk Super Admin dan Karyawan menurut paket, toggle role tetap berlaku, cache, perilaku saat RPC gagal (menu tidak disaring, server tetap menjaga), dan semua `menu_id` di SQL dikenal aplikasi.
- Sintaks seluruh JS dan skrip `app.html` valid.

**Belum bisa diuji di sini, itulah gunanya langkah 4–6:**
- Supabase asli (hak akses default, `auth.uid()` dari JWT sungguhan).
- Tampilan di browser dan HP: halaman Paket & Fitur, sidebar yang menyusut, dan tabel Pengaturan Sistem satu kolom belum dilihat langsung. Halaman baru memakai kelas CSS yang sudah ada ditambah beberapa baris untuk bar pemakaian.
- Edge Function `account-admin` tidak diubah; di mode ringkas ia membuat akun ber-role `karyawan`, yang lolos trigger, tetapi belum dicoba di runtime asli.
