#!/usr/bin/env bash
# Menyusun supabase/migrations/ (format Supabase CLI) dari file SQL di root,
# mengikuti urutan instalasi baru di README (bagian "Baca dulu").
#   ./scripts/build-migrations.sh
# Lalu:  supabase db reset   (uji dari database kosong)  /  supabase db push
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=supabase/migrations
rm -rf "$OUT"; mkdir -p "$OUT"

ORDER=(
  supabase-schema.sql supabase-org-approval.sql supabase-role-admin-approval.sql
  supabase-cuti-khusus.sql supabase-koreksi-absen.sql supabase-fix-decide-approval-merge.sql
  supabase-notifikasi.sql
  supabase-jenis-hubungan-kerja.sql supabase-master-pt.sql supabase-invoice-outsourcing.sql
  supabase-invoice-area.sql supabase-revisi-pengajuan.sql supabase-riwayat-jadwal.sql
  supabase-push-notifikasi.sql supabase-absensi-monitor-leave-select.sql
  001_multi_tenant.sql 002_tahap2_akun.sql 002b_tutup_signup_lama.sql 003_tahap3_storage_audit.sql
  004_tahap4_paket_fitur.sql 005_tahap5_billing.sql 006_pa_overview_fitur_paket.sql
  007_pa_edit_fitur_paket.sql 008_pengumuman.sql 009_dinas_luar.sql 010_kasbon.sql
  011_reimbursement.sql 012_dokumen_karyawan.sql 013_tukar_shift.sql 014_analitik_hr.sql
  015_onboarding_offboarding.sql 016_kpi_penilaian_kinerja.sql 017_kpi_saya_template_ringkas.sql
  018_absensi_server_side.sql 019_privasi_retensi.sql 020_client_errors.sql
)
i=0
for f in "${ORDER[@]}"; do
  [[ -f "$f" ]] || { echo "HILANG: $f" >&2; exit 1; }
  i=$((i+1))
  # Timestamp sintetis berurutan; migrasi baru cukup memakai timestamp setelahnya.
  ts=$(printf '2026010100%04d' "$i")
  base=$(basename "$f" .sql | sed 's/[^A-Za-z0-9_-]/_/g')
  cp "$f" "$OUT/${ts}_${base}.sql"
done
echo "OK: $i file -> $OUT"
