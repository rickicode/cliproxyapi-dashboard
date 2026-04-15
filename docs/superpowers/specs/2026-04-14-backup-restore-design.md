# Backup & Restore Design

## Summary

Tambahkan fitur admin-only Backup & Restore di dashboard untuk dua mode backup database:

1. **Settings backup** — mengekspor seluruh konfigurasi dashboard yang disimpan di database dan merestore-nya dengan model **replace total** untuk domain konfigurasi yang termasuk scope backup.
2. **Provider credentials backup** — mengekspor hanya data kredensial/ownership provider yang relevan dan merestore-nya dengan model **merge aman** tanpa menghapus kredensial lain di sistem.

Selain itu, ubah default port dashboard lokal dari `3000` menjadi `8318` tanpa mengubah port CLIProxyAPI yang tetap `8317`.

## Goals

- Menyediakan backup/restore dari UI dashboard untuk data berbasis database yang penting secara operasional.
- Memisahkan backup konfigurasi global dashboard dari backup kredensial provider.
- Menjaga restore settings tetap deterministic dengan perilaku replace total yang dibatasi hanya pada domain settings yang didukung.
- Menjaga restore provider credentials tetap aman dengan perilaku merge yang tidak menghapus data lain.
- Menyamakan default port dashboard lokal/dev/docs ke `8318`.

## Non-Goals

- Tidak mencakup backup file/volume infrastruktur seperti `infrastructure/config/config.yaml`, Docker volumes, TLS certs, atau auth volume CLIProxyAPI.
- Tidak mencakup audit log, usage history, session sementara, dan data operasional non-konfigurasi lain.
- Tidak menambahkan scheduler backup otomatis, retention policy, encryption at rest, atau background job system pada iterasi ini.
- Tidak mengganti mekanisme backup shell yang sudah ada di `scripts/backup.sh` dan `scripts/restore.sh`.

## User-Facing Design

### Navigation and Page Placement

Tambahkan halaman admin baru di:

- `dashboard/src/app/dashboard/admin/backup/page.tsx`

Tambahkan item navigasi admin baru di:

- `dashboard/src/components/dashboard-nav.tsx`

Halaman ini berada di bawah area admin yang sudah ada, konsisten dengan `admin/users` dan `admin/logs`, dan hanya terlihat untuk admin.

### Page Sections

Halaman Backup & Restore menampilkan empat kartu utama:

1. **Backup Settings**
   - Tombol download backup JSON
   - Ringkasan scope data yang termasuk
   - Informasi versi backup dan timestamp

2. **Restore Settings**
   - Upload file JSON
   - Validasi jenis file backup
   - Warning eksplisit bahwa restore ini akan replace total domain settings yang didukung
   - Konfirmasi sebelum eksekusi
   - Summary hasil restore

3. **Backup Provider Credentials**
   - Tombol download backup JSON
   - Ringkasan scope data kredensial yang termasuk

4. **Restore Provider Credentials**
   - Upload file JSON
   - Validasi jenis file backup
   - Warning bahwa restore berjalan dengan model merge aman
   - Summary hasil restore: `created`, `updated`, `skipped`, `failed`

### Interaction Model

- Semua aksi hanya tersedia untuk admin.
- Export menghasilkan file JSON yang didownload browser.
- Restore dilakukan dari upload file JSON.
- Restore settings membutuhkan konfirmasi eksplisit via dialog.
- Toast/notifikasi digunakan untuk sukses/gagal, mengikuti pola admin pages yang sudah ada.

## Backup File Formats

Gunakan format JSON versioned agar bisa divalidasi dengan ketat dan kompatibel untuk migrasi format di masa depan.

### Settings Backup Format

```json
{
  "type": "dashboard-settings-backup",
  "version": 1,
  "exportedAt": "2026-04-14T12:00:00.000Z",
  "sourceApp": "cliproxyapi-dashboard",
  "payload": {
    "systemSettings": [],
    "customProviders": [],
    "providerGroups": [],
    "customProviderModels": [],
    "customProviderExcludedModels": []
  }
}
```

#### Included data

Backup settings mencakup domain database global yang berperan sebagai konfigurasi dashboard:

- `SystemSetting`
- `CustomProvider`
- `ProviderGroup`
- `CustomProviderModel`
- `CustomProviderExcludedModel`
- relasi dan kolom pendukung yang diperlukan agar konfigurasi bisa dibangun ulang secara utuh

Untuk model yang berelasi ke user, file backup **tidak boleh** bergantung pada internal `userId` database sumber. Backup harus menyimpan referensi user dengan identitas yang portable, yaitu `username`, lalu restore akan memetakan kembali ke `userId` target berdasarkan username yang sudah ada di sistem target.

#### Excluded data

- `AuditLog`
- `UsageRecord`
- `User`
- `SyncToken`
- `UserApiKey`
- `PerplexityCookie`
- data runtime/operasional lain yang bukan konfigurasi global dashboard

### Provider Credentials Backup Format

```json
{
  "type": "provider-credentials-backup",
  "version": 1,
  "exportedAt": "2026-04-14T12:00:00.000Z",
  "sourceApp": "cliproxyapi-dashboard",
  "payload": {
    "providerKeyOwnership": [],
    "providerOAuthOwnership": []
  }
}
```

#### Included data

Backup provider credentials mencakup hanya data ownership/kredensial provider yang memang dikelola oleh dashboard dan memiliki identitas yang bisa dicocokkan saat merge:

- `ProviderKeyOwnership`
- `ProviderOAuthOwnership`

Jika selama implementasi ditemukan bahwa salah satu model menyimpan referensi wajib ke data yang tidak ada di backup, backup harus menyertakan field minimum yang diperlukan untuk restore konsisten, tetapi tetap tidak melebar ke domain non-kredensial.

Seperti settings backup, payload provider credentials juga harus menyimpan referensi user secara portable dengan `username`, bukan `userId` mentah.

## API Design

Tambahkan endpoint admin khusus di:

- `dashboard/src/app/api/admin/backup/route.ts`
- `dashboard/src/app/api/admin/restore/route.ts`

Tambahkan konstanta baru di:

- `dashboard/src/lib/api-endpoints.ts`

### Export Endpoint

`GET /api/admin/backup?mode=settings|provider-credentials`

Perilaku:

- Verifikasi session dan role admin
- Validasi query `mode`
- Ambil data dari Prisma berdasarkan mode
- Bangun JSON backup versioned
- Return JSON payload yang akan di-download dari client

Response shape:

```ts
{
  success: true,
  data: {
    fileName: string,
    backup: SettingsBackup | ProviderCredentialsBackup
  }
}
```

### Restore Endpoint

`POST /api/admin/restore`

Request body:

```ts
{
  backup: unknown
}
```

Perilaku:

- Verifikasi session dan role admin
- Validasi origin untuk request mutasi
- Validasi schema backup berdasarkan field `type`
- Dispatch ke restore handler yang sesuai
- Simpan audit log
- Return summary hasil restore

Response shape untuk settings restore:

```ts
{
  success: true,
  data: {
    mode: "settings",
    replacedDomains: string[]
  }
}
```

Response shape untuk provider credentials restore:

```ts
{
  success: true,
  data: {
    mode: "provider-credentials",
    created: number,
    updated: number,
    skipped: number,
    failed: number
  }
}
```

## Validation Design

Tambahkan Zod schema khusus untuk backup format baru di layer validation yang sudah ada.

Validasi minimal:

- `type` harus salah satu dari dua jenis backup yang didukung
- `version` harus versi yang dikenali
- `exportedAt` harus ISO datetime valid
- `payload` harus sesuai schema tiap mode
- restore settings harus menolak file provider credentials, dan sebaliknya

Jika ada kebutuhan kompatibilitas ke depan, version check menjadi titik kontrol migrasi format.

## Restore Semantics

### Settings Restore: Replace Total

Restore settings berjalan sebagai transaksi database tunggal dan hanya menyentuh domain dalam scope backup settings.

Aturan:

- Hapus data existing pada domain settings yang termasuk scope
- Insert ulang data dari backup
- Jaga urutan operasi agar foreign key tetap valid
- Jangan menyentuh tabel di luar scope
- Untuk row yang terkait user, lakukan pemetaan `username -> userId` terhadap user yang sudah ada di sistem target
- Jika backup mereferensikan username yang tidak ada di sistem target, restore settings harus gagal fast sebelum transaksi menulis perubahan apa pun

Implikasi:

- Settings restore bersifat deterministic
- Config global dashboard setelah restore akan sama dengan isi backup untuk domain yang didukung

### Provider Credentials Restore: Safe Merge

Restore provider credentials tidak menghapus data lain. Sistem mencocokkan record backup dengan record existing berdasarkan identitas unik yang relevan per model.

Aturan:

- Jika belum ada, buat record baru
- Jika ada dan payload berbeda, update record
- Jika ada dan identik, skip
- Jika record tidak bisa dicocokkan/invalid, hitung sebagai failed dan laporkan di summary
- Jangan delete record yang ada di sistem tetapi tidak ada di backup
- Mapping owner user dilakukan dengan `username -> userId`; jika username tidak ditemukan di sistem target, item dihitung sebagai `failed` dan restore item lain tetap lanjut

## Server-Side Structure

Pisahkan logika menjadi unit yang jelas agar file route tetap tipis.

Struktur yang disarankan:

- route admin untuk auth, request parsing, dan response
- modul service untuk export settings
- modul service untuk export provider credentials
- modul service untuk restore settings
- modul service untuk restore provider credentials
- modul schema/validator untuk format backup

Kemungkinan lokasi:

- `dashboard/src/lib/backup/*`

Ini menjaga route tetap kecil dan testable.

## Security and Audit

### Access control

- Semua endpoint backup/restore harus admin-only.
- Restore harus memakai validasi origin seperti endpoint admin mutasi lain.

### Audit logging

Tambahkan action audit baru untuk export dan restore, misalnya:

- `BACKUP_EXPORTED`
- `BACKUP_RESTORED`

Metadata audit minimal:

- mode backup
- version
- filename jika ada
- counts hasil restore

### Safety UX

- Restore settings wajib melalui dialog konfirmasi.
- UI harus menampilkan warning bahwa settings restore mengganti konfigurasi global yang termasuk scope.
- UI harus membedakan jelas mode settings vs provider credentials agar admin tidak salah import.

## Internationalization

Semua string baru di UI harus masuk ke:

- `dashboard/messages/en.json`
- `dashboard/messages/de.json`

`en.json` menjadi source of truth dan `de.json` harus mengikuti struktur yang sama.

## Testing Strategy

### Unit/API tests

Tambahkan test untuk:

- validasi schema backup settings
- validasi schema backup provider credentials
- export endpoint admin authorization
- restore endpoint admin authorization
- settings restore replace total behavior pada domain yang didukung
- provider credentials restore merge behavior (`created`, `updated`, `skipped`, `failed`)
- penolakan mode/type backup yang salah

### UI tests

Tambahkan test komponen/page untuk:

- rendering admin page
- state loading untuk export/restore
- konfirmasi restore settings
- summary hasil restore

### Regression around scope

Tambahkan verifikasi bahwa settings restore tidak menyentuh model di luar scope backup settings.

## Port Change Design

Ubah default dashboard lokal/dev dari `3000` menjadi `8318` di seluruh tempat yang mendefinisikan atau mendokumentasikan default dashboard URL/port.

Target utama yang perlu diperbarui:

- `docker-compose.local.yml`
- `docker-compose.yml`
- `setup-local.sh`
- `dashboard/dev-local.sh` jika ada asumsi hardcoded ke `3000`
- `README.md`
- `docs/INSTALLATION.md`
- `docs/CONFIGURATION.md`
- env/default references lain yang memakai `DASHBOARD_URL=http://localhost:3000`

Aturan port:

- dashboard default lokal/dev: `8318`
- CLIProxyAPI tetap: `8317`
- production reverse proxy via Caddy tetap di `80/443`

## Risks and Mitigations

### Risk: relational restore order for settings

Mitigasi:

- definisikan urutan delete/insert yang sesuai foreign key
- bungkus dalam transaksi

### Risk: provider credential identity mismatch

Mitigasi:

- tetapkan rule matching eksplisit per model sebelum implementasi
- jika ambigu, skip dan laporkan dalam `failed`

### Risk: backup tidak portable karena memakai internal userId

Mitigasi:

- gunakan `username` sebagai referensi user di file backup
- restore melakukan mapping ke `userId` target saat import
- settings restore gagal fast bila ada username yang dibutuhkan tetapi tidak ada di target
- provider credentials restore melaporkan item terkait sebagai `failed` tanpa menghapus data lain

### Risk: admin salah restore file mode berbeda

Mitigasi:

- validasi schema ketat
- tampilkan label mode file di UI sebelum submit jika memungkinkan

### Risk: port update tidak konsisten di docs/scripts

Mitigasi:

- perlakukan port change sebagai scope eksplisit lintas compose, scripts, dan docs
- verifikasi semua referensi `localhost:3000`

## Implementation Boundaries

Iterasi ini dianggap selesai jika:

- ada halaman admin Backup & Restore baru
- export settings dan provider credentials dapat menghasilkan JSON valid
- restore settings melakukan replace total untuk scope settings
- restore provider credentials melakukan safe merge
- audit log dan i18n string dasar tersedia
- default port dashboard lokal/dev/docs berpindah ke `8318`

Iterasi ini belum mencakup:

- preview diff detail sebelum restore
- encryption/password-protected backups
- scheduled backups
- download/restore infra-level tarball dari dashboard UI
