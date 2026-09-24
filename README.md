# Absensi & Database Karyawan

Aplikasi absensi karyawan berbasis web (vanilla JS + Supabase). Absensi memakai
verifikasi **GPS lokasi** + **foto selfie** saat check-in/check-out. Ada 5 role:
**Super Admin**, **Super Admin HR**, **Admin HR**, **Admin**, dan **Karyawan**.

## Role

| Role | Akses |
|---|---|
| **Super Admin** | All Akses — semua menu, semua data, satu-satunya role "root" yang tidak bisa dibatasi lewat toggle apapun. Satu-satunya yang bisa mengatur akses ketiga role lain lewat menu **Pengaturan Sistem** (default) & satu-satunya yang selalu tetap bisa membuka halaman itu apa pun kondisinya. |
| **Super Admin HR** | TIDAK otomatis All Akses lagi — diperlakukan generik & sama persis seperti Admin HR/Karyawan: menu mana saja yang boleh dibuka diatur satu-satu lewat **Pengaturan Sistem**. Defaultnya menyala untuk hampir semua menu operasional (setara "full akses" versi lama), **kecuali** menu **Pengaturan Sistem** itu sendiri, yang defaultnya mati. Super Admin bisa menyalakan menu itu untuk Super Admin HR kalau memang mau didelegasikan jadi admin cadangan (lihat bagian 6 di bawah). |
| **Admin HR** | Akses dibatasi. Menu mana saja yang boleh dibuka diatur oleh Super Admin (atau Super Admin HR, kalau sudah didelegasikan) lewat menu **Pengaturan Sistem** — baik menu staff (approval, laporan, master data, dst) maupun menu pribadi (absensi/izin/lembur sendiri, karena Admin HR juga karyawan). Secara default: boleh monitor absensi, approve izin & lembur, lihat laporan, dan absen/ajukan izin & lembur sendiri — tapi *tidak* boleh buka Data Karyawan, Slip Gaji, Kenaikan Upah, Master Data, atau Pengaturan Sistem sampai dinyalakan manual. |
| **Admin** | Admin ringan (nilai di database: `admin_approval`). Bukan staff HR: tidak otomatis bisa membaca data karyawan/gaji atau mengatur role orang lain. Akses menunya murni dari toggle **Pengaturan Sistem**. Default: menu pribadi + **Approval Izin** & **Approval Lembur** menyala, semua menu staff lain mati. Ditetapkan lewat **Struktur Organisasi → Ubah Role**, dan ia perlu menjadi anggota unit yang ia approve. Di halaman approval ia hanya bisa membaca profil pemohon yang ada di rantai approval-nya. |
| **Karyawan** | Check-in/out, ajukan izin & lembur, lihat riwayat sendiri. Menu mana saja dari keempat ini yang aktif juga diatur lewat **Pengaturan Sistem** (default: semua menyala, sama seperti sebelumnya). |

Menu pribadi (Absensi, Pengajuan Izin, Pengajuan Lembur, Riwayat Saya) kini
muncul di sidebar **semua role** — Super Admin, Super Admin HR, dan Admin HR
juga bisa absen dan mengajukan izin/lembur untuk diri sendiri, tidak cuma
role Karyawan.

## Profil Saya (koreksi data mandiri)

Semua role punya menu **Profil Saya** untuk melihat & memperbaiki data
sendiri kalau ada yang salah:

- **Bisa diubah langsung** (tanpa approval): No. HP, Alamat Domisili, Foto
  Profil, Pendidikan Terakhir, Agama, dan biodata keluarga (nama ayah & ibu,
  suami/istri, data anak) — tersimpan
  seketika. Lihat bagian **Biodata Karyawan** di bawah.
- **Butuh approval admin**: Nama Lengkap, NIK KTP, NPWP, Alamat Sesuai KTP,
  Jenis Kelamin, Tempat Lahir, Tanggal Lahir, **Status Pernikahan**, Unit/PT, Lokasi Kerja, Departemen, Bagian,
  dan Jabatan — field ini berkaitan dengan payroll/BPJS/dokumen resmi
  (alamat KTP, jenis kelamin & tempat/tanggal lahir mengacu ke KTP; status
  pernikahan menentukan PTKP), jadi karyawan cuma bisa **mengajukan**
  perubahan (lengkap dengan alasan), lalu menunggu disetujui lewat menu
  **Approval Perubahan Data** (Admin HR/Super Admin HR/Super Admin). Begitu
  disetujui, data di Data Karyawan langsung ikut berubah. Karyawan bisa
  membatalkan pengajuannya sendiri selama masih berstatus "Menunggu".
  Kode Karyawan, Role, dan Status Karyawan tidak bisa diubah lewat menu ini
  sama sekali (murni lewat menu Data Karyawan oleh admin).

## Biodata Karyawan

Selain data kepegawaian, tiap karyawan punya biodata pribadi & keluarga.
Admin mengisinya lewat **Data Karyawan** (Tambah/Edit), karyawan bisa
melengkapi sendiri lewat **Profil Saya**.

| Kelompok | Field |
|---|---|
| Data pribadi | Alamat Sesuai KTP, Alamat Domisili, Jenis Kelamin, Agama, Tempat Lahir, Tanggal Lahir, Pendidikan Terakhir |
| Status | Status Pernikahan (Belum Menikah / Menikah / Cerai Hidup / Cerai Mati) — admin mengisinya di Data Karyawan; karyawan hanya bisa mengubahnya lewat pengajuan |
| Orang tua | Nama Ayah, Nama Ibu |
| Suami / Istri | Nama, Tempat Lahir, Tanggal Lahir, Pekerjaan — hanya tampil kalau status **Menikah**; kalau status diganti ke selain Menikah, data pasangan ikut dikosongkan saat disimpan |
| Anak | Daftar dinamis (tombol **+ Tambah Anak**): Nama, Tempat Lahir, Tanggal Lahir, Pekerjaan. Urutan Anak Pertama, Kedua, dst. mengikuti urutan di form |

Catatan teknis:

- Ada **dua alamat**: **Alamat Sesuai KTP** (kolom baru `alamat_ktp`) dan
  **Alamat Domisili** (kolom `alamat` yang sudah ada, jadi alamat lama
  otomatis menjadi alamat domisili — tidak ada yang perlu dimigrasi).
- Data anak disimpan di tabel terpisah `employee_children` (satu baris per
  anak). Membacanya hanya boleh pemiliknya sendiri atau role yang menu
  **Data Karyawan**-nya menyala (Admin HR yang menu itu masih mati tidak
  bisa membacanya, sama seperti data karyawan lain).
- **Profil Saya** juga menampilkan **Level** (dan grade) serta **PTKP**.
  Keduanya hanya-baca: level diatur admin di Data Karyawan, PTKP dihitung
  otomatis (lihat di bawah).
- Semua ini ada di **bagian 13 dan 14** `supabase-schema.sql`. Untuk project yang
  sudah berjalan cukup jalankan ulang file itu di SQL Editor — data lama
  tidak berubah.
- **Tanggal Resign** (`resign_date`) ada di seksi Kepegawaian Data Karyawan;
  kosong = masih bekerja. Tidak boleh lebih awal dari tanggal masuk (dijaga
  form dan database). "Lama Bekerja" berhenti dihitung di tanggal resign.
  Mengisi tanggal resign **tidak** otomatis menonaktifkan akun — form hanya
  mengingatkan kalau akun masih aktif.
- Logika form (dipakai bersama oleh Data Karyawan & Profil Saya) ada di
  `js/biodata.js`.

### PTKP otomatis

Kolom `profiles.ptkp` diisi **otomatis oleh trigger database** dari status
pernikahan + jumlah anak, jadi selalu ikut benar tidak peduli siapa yang
mengubah datanya (admin, karyawan, atau approval). Nilai yang dikirim dari
aplikasi selalu ditimpa.

| Status pernikahan | Kode PTKP |
|---|---|
| Menikah | `K/n` |
| Belum Menikah, Cerai Hidup, Cerai Mati | `TK/n` |
| Belum diisi | kosong |

`n` = jumlah anak, **maksimal 3**. Nominal per tahun: TK/0 Rp54.000.000,
K/0 Rp58.500.000, tambah Rp4.500.000 tiap tanggungan (angka ada di
`js/biodata.js`, kalau aturan berubah tinggal ubah di sana).

Batasan yang perlu diketahui:

- **K/I/n** (penghasilan istri digabung) tidak dihitung otomatis.
- Semua anak dihitung sebagai tanggungan (maks. 3); syarat lain seperti
  usia/penghasilan anak tidak dicek.
- **PPh21 di slip gaji saat ini masih memakai persentase tetap per level**
  (Master Level), belum memakai PTKP. Jadi PTKP saat ini informasi/data
  acuan, belum memengaruhi angka slip gaji.

Menu **Approval Perubahan Data** defaultnya menyala untuk Admin HR & Super
Admin HR (sama seperti Approval Izin/Lembur), bisa diatur lewat
**Pengaturan Sistem** seperti menu lainnya. Tabel `profile_change_requests`
& seed menu-nya ada di bagian akhir `supabase-schema.sql` (aman dijalankan
ulang di project yang sudah ada, sama seperti bagian lain schema ini).

Pembatasan akses Admin HR **dan** Karyawan ditegakkan di **dua lapis**: menu
disembunyikan di sidebar (UI), dan RLS (Row Level Security) di Supabase
menolak query langsung ke tabel terkait kalau menu itu belum diizinkan — jadi
bukan cuma "disembunyikan", tapi benar-benar tertutup di sisi server. Toggle
akses Admin HR dan Karyawan disimpan terpisah (per role), jadi mematikan
suatu menu untuk satu role tidak memengaruhi role lainnya.

## Struktur Organisasi & Approval Bertingkat

Approval izin/sakit/cuti dan lembur tidak lagi "siapa saja yang punya menu
approval bisa menyetujui semua", tapi mengikuti **struktur organisasi berbasis
unit**.

**Unit & anggota** (menu **Struktur Organisasi**)
- Unit membentuk pohon bebas kedalaman: Kantor Pusat → Cabang → Departemen →
  Bagian (atau bentuk lain). Cabang bisa dibuat di bawah Kantor Pusat dan
  isinya bisa **disalin** dari unit lain (tombol *Salin Struktur*).
- Satu karyawan boleh menjadi anggota **banyak unit**, tapi hanya satu yang
  ditandai **Unit Utama** — unit inilah yang menentukan rantai approval
  pengajuannya. Keanggotaan lain hanya untuk kolaborasi/tampilan.
- Struktur bisa dibentuk otomatis dari data lama (Lokasi Kantor → Departemen →
  Bagian) lewat tombol *Impor dari Data Lama* saat struktur masih kosong.

**Ubah Role dari pohon.** Role TIDAK diatur di Data Karyawan: akun baru selalu dibuat sebagai Karyawan, dan role diubah lewat tombol **Ubah Role** di tiap anggota Struktur Organisasi (perlu hak *Struktur Organisasi — Boleh Mengubah*). Pilihan role mengikuti kewenangan: Super Admin → semua role; Super Admin HR/Admin HR → Karyawan, Admin, Admin HR, Super Admin HR (tidak bisa menyentuh Super Admin); lainnya → hanya Karyawan ↔ Admin. Tidak bisa mengubah role diri sendiri. Ditegakkan di database lewat fungsi `set_member_role`, dan perubahan role langsung ke tabel `profiles` ditolak kecuali oleh Super Admin.

**Siapa approver?**
1. Approver adalah **anggota unit yang role-nya Admin** (Super Admin, Super
   Admin HR, Admin HR, Admin) **dan** menu approval terkait (*Approval Izin* /
   *Approval Lembur*) menyala untuk role itu di Pengaturan Sistem. Role
   Karyawan tidak pernah jadi approver walau ditaruh di unit mana pun.
2. Pencarian mulai dari Unit Utama pemohon. Kalau unit itu tidak punya Admin,
   otomatis **naik ke unit induk**, dan seterusnya.
3. **Jumlah tingkat** per jenis pengajuan (izin, sakit, cuti, lembur) diatur di
   halaman Struktur Organisasi. Tiap tingkat = satu unit berbeda yang punya
   Admin; unit tanpa Admin dilewati. Beberapa Admin dalam satu unit: **salah
   satunya cukup** menyetujui tahap itu.
4. Belum punya Unit Utama, atau tidak ada Admin di seluruh rantai atas →
   diteruskan ke Super Admin + staff yang berhak approve (tanpa jenjang,
   sama seperti perilaku sebelum ada struktur). Super Admin yang mengajukan
   sendiri dan tidak punya approver di atasnya disetujui otomatis.
5. Approver dicatat (snapshot) saat pengajuan dibuat: memindahkan orang atau
   mengganti role sesudahnya **tidak** mengubah pengajuan yang sudah berjalan.
   Perubahan jumlah tingkat hanya berlaku untuk pengajuan baru.

**Hak akses menu.** *Struktur Organisasi* (lihat) dan *Struktur Organisasi —
Boleh Mengubah* (`struktur-kelola`: ubah unit/anggota/tingkat approval) diatur
di Pengaturan Sistem seperti menu lain. Default: hanya Super Admin HR yang boleh
mengubah; Super Admin selalu boleh. Tombol Setujui/Tolak baru muncul saat
**giliran** user itu; server mengecek ulang lewat fungsi `decide_approval`.

**Keamanan.** Karyawan tidak lagi bisa mengubah status pengajuannya sendiri lewat
API (policy `leave_update`/`overtime_update` kini hanya Super Admin), status
awal dipaksa `pending` oleh trigger, dan approve/tolak hanya lewat RPC
`decide_approval`. Daftar pengajuan di halaman approval dibatasi ke pengajuan
yang melibatkan user itu, tetapi izin *baca* tabel pengajuan masih mengikuti
toggle menu approval (dipakai juga oleh Laporan & Slip Gaji).

**Migrasi database yang sudah berjalan:** jalankan `supabase-org-approval.sql`
(aman diulang; pengajuan yang masih pending otomatis dibentuk tahap approvalnya).
Instalasi baru cukup menjalankan `supabase-schema.sql` (sudah termasuk).

## Fitur

- **Karyawan**: check-in/check-out dengan foto + validasi lokasi GPS terhadap
  radius kantor (bisa dari menu **Absensi** maupun langsung dari kartu
  Check-in/Check-out di **Dashboard** — tombolnya hanya muncul kalau menu
  Absensi diizinkan untuk role itu), ajukan izin/sakit/cuti/lembur, lihat riwayat & rekap kehadiran sendiri.
- **Admin**: menyetujui/menolak izin & lembur karyawan di unitnya (dan unit di bawahnya bila
  admin di unit itu tidak ada), plus menu pribadi. Tidak ada akses lain kecuali dinyalakan.
- **Admin HR**: monitor absensi semua karyawan, approve/reject izin & lembur,
  lihat laporan — plus menu tambahan (Data Karyawan, Slip Gaji, dst.) kalau
  diizinkan Super Admin.
- **Super Admin / Super Admin HR**: semua fitur Admin HR + kelola data karyawan,
  master data, slip gaji, kenaikan upah, dan mengatur akses Admin HR & periode
  cut-off gaji lewat **Pengaturan Sistem**.

## Struktur Proyek

```
index.html                Halaman login
app.html                  Shell aplikasi (sidebar + router modul + guard akses per menu)
css/style.css              Semua styling
js/supabaseClient.js       Koneksi Supabase (isi URL & anon key di sini)
js/auth.js                  Login, logout, proteksi halaman per role
js/core.js                   Util bersama: sidebar (dinamis sesuai permission), role helper,
                              periode cut-off slip gaji, GPS, kamera, upload foto, format
js/approvalHelper.js       Helper approval bertingkat (daftar per approver, tahap, keputusan via RPC)
js/biodata.js               Form & logika biodata pribadi/keluarga (dipakai admin-karyawan.js & employee-profil.js)
js/modules/
  employee-absensi.js       Check-in/out (GPS + kamera); alurnya juga dipakai kartu absen di dashboard.js
  employee-izin.js           Form & riwayat pengajuan izin
  employee-lembur.js         Form & riwayat pengajuan lembur
  employee-riwayat.js        Riwayat & rekap absensi pribadi
  employee-profil.js         Profil Saya: edit langsung (HP/alamat domisili/foto/biodata keluarga) + ajukan perubahan data sensitif
  admin-karyawan.js          CRUD data karyawan termasuk biodata pribadi & keluarga (menu "karyawan")
  admin-absensi.js           Monitor absensi semua karyawan (menu "absensi-monitor")
  admin-izin.js              Approval izin bertingkat (menu "izin-approval")
  admin-profil-approval.js   Approval pengajuan perubahan data profil (menu "profil-approval")
  admin-lembur.js            Approval lembur bertingkat (menu "lembur-approval")
  admin-struktur-organisasi.js  Pohon unit + anggota + tingkat approval; editor untuk yang punya hak "struktur-kelola"
  admin-kenaikan-upah.js     Riwayat & input kenaikan upah/gaji (menu "kenaikan-upah")
  admin-slip-gaji.js         Hitung & cetak slip gaji, ikut periode cut-off, bisa difinalisasi/dikunci (menu "slip-gaji")
  admin-laporan.js           Laporan bulanan + export (menu "laporan")
  admin-master-*.js          Master data (level, tunjangan, denda, departemen, jadwal, libur, lokasi)
  super-pengaturan.js        Kelola akses menu Admin HR + atur cut-off slip gaji (khusus Super Admin/Super Admin HR)
supabase-schema.sql         Semua tabel, RLS policy, trigger, storage bucket
supabase-org-approval.sql   Migrasi struktur organisasi + approval bertingkat (sudah termasuk di supabase-schema.sql)
supabase-role-admin-approval.sql  Migrasi role Admin untuk database yang SUDAH berjalan (instalasi baru tidak perlu; sudah termasuk di dua file di atas)
```

## Setup

### 1. Buat project Supabase
Buka [supabase.com](https://supabase.com) → New Project.

### 2. Jalankan schema
Buka **SQL Editor** di dashboard Supabase → paste isi `supabase-schema.sql` →
**Run**. Ini akan membuat semua tabel, trigger, RLS policy, storage bucket
`attendance-photos`, tabel `role_permissions` (default akses Admin HR & akses
Karyawan, satu baris per role per menu), dan tabel `payroll_settings` (default
cut-off = tanggal 1, alias kalender biasa).

> **Upgrade ke role Admin** (database yang sudah berjalan): jalankan sekali
> `supabase-role-admin-approval.sql` di SQL Editor, lalu deploy file JS/HTML yang baru.
> Aman dijalankan ulang. Pengajuan yang sudah dibuat tidak berubah.
>
> Kalau ini upgrade dari versi lama (role `admin`/`hr`), script yang sama aman
> dijalankan ulang — akun `admin` otomatis jadi `super_admin`, akun `hr`
> otomatis jadi `admin_hr`, tanpa perlu bikin ulang akun.
>
> Kalau ini upgrade dari versi sebelum `role_permissions` punya kolom `role`
> (toggle akses masih cuma untuk Admin HR), script yang sama juga aman
> dijalankan ulang — kolom `role` otomatis ditambahkan, baris lama dilabeli
> `admin_hr`, lalu baris default baru untuk menu pribadi (Admin HR) dan untuk
> role Karyawan ditambahkan tanpa menimpa pengaturan yang sudah ada.

### 3. Sambungkan aplikasi ke Supabase
Buka **Project Settings → API**, salin **Project URL** dan **anon public key**,
lalu isi di `js/supabaseClient.js`:

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

### 4. Set lokasi kantor
Di tabel `office_locations` (lewat Table Editor), sesuaikan `lat`, `lng`, dan
`radius_meters` dengan koordinat kantor asli. Bisa lebih dari satu baris kalau
ada beberapa cabang.

### 5. Buat akun Super Admin pertama
Tidak ada halaman daftar publik (sengaja dihilangkan) — semua akun karyawan
dibuat lewat panel admin. Untuk akun Super Admin pertama:

1. Di Supabase Dashboard → **Authentication → Users → Add user** → buat user
   dengan email & password kamu sendiri (centang **Auto Confirm User**).
   Trigger otomatis akan membuat baris di tabel `profiles` dengan role
   `karyawan`.
2. Di **SQL Editor**, jadikan Super Admin:
   ```sql
   update public.profiles set role = 'super_admin'
   where id = (select id from auth.users where email = 'emailkamu@contoh.com');
   ```
   (Ganti `'super_admin'` jadi `'super_admin_hr'` kalau mau akun ini jadi
   Super Admin HR — keduanya All Akses, tinggal pilih salah satu.)
3. Login di `index.html` — sekarang kamu masuk sebagai Super Admin dan bisa
   menambah karyawan/Admin HR lain lewat menu **Data Karyawan** (otomatis
   membuat akun login untuk mereka).

### 6. Atur akses Super Admin HR, Admin HR, Admin, akses Karyawan & periode cut-off slip gaji
Login sebagai Super Admin (atau Super Admin HR, kalau sudah didelegasikan
akses ke menu ini — lihat poin terakhir di bawah) → buka menu **Pengaturan
Sistem**:
- **Kelola Akses Menu** — satu tabel dengan tiga kolom checkbox berdampingan,
  **Akses Super Admin HR**, **Akses Admin HR**, dan **Akses Karyawan**, jadi
  bisa diatur sekaligus di satu tempat. Ketiga toggle independen satu sama
  lain (mematikan menu untuk satu role tidak memengaruhi role lainnya). Menu
  pribadi (Absensi, Pengajuan Izin, Pengajuan Lembur, Riwayat Saya) berlaku
  untuk ketiganya — default: menyala semua (ketiganya juga karyawan yang
  perlu absen/ajukan izin & lembur sendiri). Menu staff selain itu, default
  sesuai tabel Role di atas.
- Salah satu baris di tabel itu adalah **Pengaturan Sistem** — yaitu halaman
  ini sendiri. Defaultnya mati untuk ketiga role. Nyalakan kolom **Akses
  Super Admin HR** di baris itu kalau kamu mau mendelegasikan pengelolaan
  akses & periode cut-off gaji ke Super Admin HR — begitu dinyalakan, akun
  Super Admin HR bisa buka halaman ini dan ikut mengubah tabel Kelola Akses
  (termasuk akses role lain, dan akses dirinya sendiri) serta Periode
  Cut-Off Slip Gaji, persis seperti Super Admin. Super Admin tetap selalu
  bisa membuka halaman ini untuk mematikannya lagi kapan saja.
- **Periode Cut-Off Slip Gaji** — isi `1` untuk periode kalender biasa
  (tanggal 1 s/d akhir bulan), atau isi tanggal lain (mis. `26`) kalau
  perusahaan pakai cut-off, misalnya periode berjalan dari tanggal 26 bulan
  sebelumnya sampai tanggal 25 bulan yang dipilih. Berlaku global untuk semua
  karyawan.

> **Catatan tentang mengubah cut-off setelah berjalan lama:** pengaturan ini
> cuma satu angka global, dan periode gaji yang **belum difinalisasi** selalu
> dihitung ulang pakai cut-off yang *sedang* berlaku. Jadi kalau cut-off
> diubah 6 bulan/setahun lagi, membuka ulang slip gaji periode lama yang
> belum difinalisasi bisa menggeser rentang tanggalnya dan mengubah
> angkanya. Data absensi/lembur asli tidak ikut berubah — cuma cara
> pengelompokannya ke periode yang bergeser. Supaya slip gaji yang sudah
> dicetak/diserahkan ke karyawan tidak ikut berubah, gunakan tombol
> **🔒 Finalisasi Periode Ini** di menu Slip Gaji setiap periode selesai —
> begitu difinalisasi, angkanya dibekukan permanen (tabel `payroll_periods` +
> `payroll_slips`) dan tidak lagi dihitung ulang otomatis walau cut-off atau
> tarif di Master Level/Master Denda/Master Tunjangan berubah di kemudian
> hari. Kalau perlu dikoreksi, ada tombol **🔓 Buka Kunci** untuk kembali ke
> mode draft, lalu finalisasi ulang setelah dikoreksi.

### 7. Aktifkan email untuk fitur "Lupa Password"
Fitur reset password memakai `supabase.auth.resetPasswordForEmail`, yang
otomatis aktif begitu project Supabase dibuat (pakai email bawaan Supabase).
Kalau mau pakai domain email sendiri, atur di **Authentication → Email
Templates / SMTP Settings**. Pastikan juga di **Authentication → URL
Configuration**, `reset-password.html` (URL lengkap situs kamu, contoh
`https://namamu.github.io/absensi/reset-password.html`) ditambahkan ke
**Redirect URLs**, atau reset password tidak akan berfungsi.

### 8. Jalankan secara lokal
Karena pakai ES Modules, buka lewat local server (bukan `file://`), misalnya:

```bash
npx serve .
# atau
python3 -m http.server 8080
```

### 9. Deploy
Bisa langsung deploy folder ini ke **GitHub Pages**, **Netlify**, atau
**Vercel** — murni file statis, tidak butuh backend server sendiri (backend =
Supabase).

## Catatan Keamanan

- Semua akses data diatur lewat **Row Level Security (RLS)** di Supabase —
  karyawan hanya bisa melihat/mengubah data miliknya sendiri; Super Admin &
  Super Admin HR bisa melihat/mengubah semua data; Admin HR mengikuti
  `role_permissions` per menu (lihat tabel Role di atas).
- Role akun **tidak pernah** dipercaya dari data yang dikirim browser saat
  signup — trigger di server selalu membuat akun baru dengan role `karyawan`,
  lalu Super Admin/Admin HR menaikkan role-nya lewat update yang tunduk RLS.
  Ini mencegah siapa pun membuat akun dengan role tinggi lewat cara di luar
  aplikasi (mis. memanggil API Supabase langsung).
- Admin HR **tidak bisa** menaikkan role siapa pun (termasuk dirinya sendiri)
  ke Admin HR/Super Admin/Super Admin HR — ditegakkan di RLS, bukan cuma di
  form. Kalaupun menu Data Karyawan diizinkan, Admin HR cuma bisa membuat/edit
  akun ber-role Karyawan.
- Validasi radius GPS saat ini dilakukan di sisi klien untuk kenyamanan UX
  (tetap mengirim absen meski di luar radius, ditandai untuk ditinjau admin).
  Untuk validasi yang tidak bisa dimanipulasi user, pertimbangkan menambahkan
  **Supabase Edge Function** yang memvalidasi jarak sebelum insert.
- Foto disimpan di storage bucket publik `attendance-photos` supaya mudah
  ditampilkan admin; jika perlu lebih privat, ubah bucket jadi private dan
  gunakan signed URL.
