# Connected Accounts Redesign Design

## Summary

Pisahkan manajemen OAuth connected accounts dari halaman `Providers` menjadi area top-level baru bernama **Connected Accounts** agar tetap rapi dan usable saat jumlah akun tumbuh ke ratusan atau ribuan. Halaman `Providers` tetap menjadi tempat setup dan koneksi provider, sementara halaman baru menangani pencarian, filter status, pagination, dan bulk actions untuk dataset besar.

## Goals

- Menjadikan halaman `Providers` fokus ke konfigurasi dan onboarding provider, bukan list operasional skala besar.
- Menambahkan halaman top-level baru **Connected Accounts** untuk mengelola ratusan/ribuan akun OAuth.
- Mendukung **server-side search**, **status filter**, dan **numbered pagination** dengan default `50` item per halaman.
- Menyimpan state list di URL agar bisa di-refresh, di-bookmark, dan di-share tanpa kehilangan konteks.
- Menambahkan **bulk actions** awal untuk enable, disable, dan disconnect akun yang dipilih.
- Memperbaiki kontrak backend listing supaya tidak lagi memuat seluruh akun sekaligus ke client.

## Non-Goals

- Tidak mendesain ulang seluruh halaman `Providers` di luar reposisi section OAuth dan penambahan preview ringkas.
- Tidak menambahkan bulk claim pada iterasi ini.
- Tidak mendukung “select all results across all pages” pada bulk actions v1.
- Tidak menambahkan background jobs, queue system, atau cache layer baru pada iterasi ini.
- Tidak mengubah flow OAuth connect/import inti selain memindahkan entry point UI-nya.

## Current State Problems

### UI

- `dashboard/src/components/providers/oauth-section.tsx` sudah menjadi file besar yang mencampur connect flow, import flow, listing akun, toggle, delete, dan claim.
- `dashboard/src/components/providers/oauth-credential-list.tsx` me-render seluruh akun sekaligus di client.
- Halaman `dashboard/src/app/dashboard/providers/page.tsx` saat ini menaruh `OAuthSection` di dalam halaman `Providers`, sehingga halaman konfigurasi ikut memikul beban list operasional.

### Backend

- `loadAccounts()` di `oauth-section.tsx` memanggil `API_ENDPOINTS.PROVIDERS.OAUTH` tanpa parameter pencarian, filter, atau pagination.
- Analisis backend menunjukkan endpoint OAuth list saat ini memuat seluruh record tanpa pagination, yang akan lambat dan berat saat data tumbuh besar.
- Dengan model fetch-all lalu render-all, pencarian/filter yang ditambahkan di client hanya akan memindahkan bottleneck dari render ke network dan memory.

## User-Facing Design

### Navigation and Information Architecture

Tambahkan menu top-level baru:

- **Connected Accounts**

Struktur baru menjadi:

- `Providers`
  - API key management
  - Connect new OAuth account
  - OAuth connected accounts preview terbatas
  - Custom providers dan section lain yang sudah ada
- `Connected Accounts`
  - Halaman operasional penuh untuk list akun OAuth skala besar

Alasan pemisahan ini adalah perbedaan mental model:

- `Providers` = setup / connect / configure
- `Connected Accounts` = browse / filter / operate at scale

### Providers Page Changes

Halaman `Providers` tetap mempertahankan pengalaman yang familiar, tetapi bagian OAuth dipecah jadi dua area:

1. **Connect New Account**
   - Dipindahkan ke atas, tepat di bawah `API Key Providers`
   - Tetap memakai aksi connect/import yang sama seperti saat ini
   - Secara visual menjadi kartu aksi onboarding, bukan bercampur dengan list besar

2. **Connected Accounts Preview**
   - Tetap memakai gaya list yang mirip dengan tampilan saat ini
   - Menampilkan **maksimal 10 akun**
   - Menampilkan total akun terhubung
   - Menyediakan tombol/link **View All Connected Accounts** yang mengarah ke halaman baru
   - Jika total akun lebih dari 10, preview tidak mencoba memuat atau merender sisanya

Preview ini menjaga continuity untuk user lama, sambil mendorong operasi dataset besar ke halaman yang tepat.

### Connected Accounts Page

Tambahkan halaman baru yang didedikasikan untuk dataset besar:

- `dashboard/src/app/dashboard/connected-accounts/page.tsx`

Halaman ini menjadi data-management screen untuk akun OAuth.

#### Page Header

Header menampilkan:

- Judul halaman: `Connected Accounts`
- Deskripsi singkat bahwa halaman ini dipakai untuk mencari, memfilter, dan mengelola akun yang terhubung
- Ringkasan hasil, misalnya total akun sesuai filter aktif

#### Toolbar

Toolbar bagian atas berisi:

- **Search input** untuk pencarian terhadap account name, account email, provider, dan status text
- **Status dropdown filter** yang mengambil nilai dari status asli yang memang ada di sistem
- **Page size selector** dengan default `50`
- **Result summary** seperti `1,248 accounts`

Semua state berikut harus disimpan di query string:

- `q`
- `status`
- `page`
- `pageSize`

Jika user refresh atau membuka link yang sama, state harus dipulihkan dari URL.

#### Table Layout

Tabel utama menampilkan kolom:

- checkbox selection
- provider
- account display (email jika ada, fallback ke account name)
- owner
- status
- status/error message ringkas
- per-row actions

Tabel tetap memakai badge status semantik seperti saat ini:

- active
- error
- disabled
- status sistem lain yang mungkin muncul dari backend

Status yang tidak dikenal tidak boleh hilang; harus tetap ditampilkan dengan label yang aman agar operator tetap bisa melihat nilai asli sistem.

#### Row Actions

Per-row actions v1:

- Enable / Disable
- Disconnect
- Claim (hanya jika sesuai permission dan flow sekarang)

Halaman baru tetap mempertahankan parity dengan aksi existing, hanya dipindah ke layout yang lebih cocok untuk list besar.

#### Bulk Actions

Bulk actions v1 yang wajib tersedia:

- Bulk enable
- Bulk disable
- Bulk disconnect

Perilaku bulk selection:

- Berlaku hanya untuk item yang dipilih secara eksplisit pada hasil yang sedang terlihat
- Tidak ada mode “select all across all filtered results” pada iterasi ini
- Bulk action bar hanya muncul saat ada item terpilih
- Confirm dialog wajib menampilkan ringkasan jumlah item dan aksi yang akan dijalankan

#### Pagination

Gunakan **numbered pagination** dengan default `50` item per halaman.

Kebutuhan pagination:

- tombol next / previous
- nomor halaman
- total halaman
- sinkron dengan query string
- bila filter/search membuat halaman saat ini tidak valid, UI otomatis fallback ke halaman valid terdekat

## Backend and API Design

### List Endpoint Contract

Endpoint OAuth accounts yang saat ini dipakai untuk fetch semua akun harus diubah menjadi endpoint listing yang mendukung query parameter:

- `q?: string`
- `status?: string`
- `page?: number`
- `pageSize?: number`
- `preview?: boolean` atau mekanisme khusus preview untuk mengambil maksimal 10 item di halaman `Providers`

Response shape yang diusulkan:

```ts
{
  success: true,
  data: {
    items: OAuthAccountListItem[],
    page: number,
    pageSize: number,
    total: number,
    totalPages: number,
    availableStatuses: string[]
  }
}
```

`OAuthAccountListItem` mempertahankan field yang sudah dipakai UI sekarang, termasuk:

- `id`
- `accountName`
- `accountEmail`
- `provider`
- `ownerUsername`
- `ownerUserId`
- `isOwn`
- `status`
- `statusMessage`
- `unavailable`

### Search Behavior

Search dilakukan di server, bukan di client, dan mencakup:

- `accountName`
- `accountEmail`
- `provider`
- `status`

Pencarian tidak perlu full-text search engine. Untuk iterasi ini, pencarian case-insensitive berbasis query database yang wajar sudah cukup, selama hasilnya bekerja baik untuk ratusan/ribuan row.

### Status Filter Behavior

Dropdown status mengambil opsi dari data status nyata yang tersedia di sistem, bukan daftar statis yang di-hardcode di frontend. Backend mengembalikan `availableStatuses` untuk filter dropdown supaya UI tetap selaras dengan kondisi nyata data.

### Preview Contract for Providers Page

Preview di halaman `Providers` harus mengambil **maksimal 10 item** dan total count terkait. Preview tidak boleh memuat seluruh dataset lalu memotong di client.

Shape response bisa memakai endpoint yang sama dengan parameter preview, atau endpoint helper terpisah, selama:

- network payload tetap kecil
- data yang dibutuhkan preview tetap konsisten dengan halaman utama
- tidak menciptakan dua sumber kebenaran untuk format akun OAuth

## Scalability Requirements

### Query Model

Listing akun OAuth harus berubah ke **server-side filtering + pagination** penuh. Ini adalah syarat minimum agar UI baru benar-benar menyelesaikan masalah skala.

### Database Support

Tambahkan atau evaluasi index yang mendukung query umum listing, terutama berdasarkan:

- ownership / user scoping
- provider
- status
- pencarian field identitas akun

Spesifikasi index exact boleh ditentukan saat implementation plan, tetapi goal-nya jelas: query listing/filter untuk halaman Connected Accounts tidak melakukan full scan yang tidak perlu saat dataset tumbuh.

### Mutation Refresh Strategy

Setelah row action atau bulk action selesai:

- UI me-refresh list aktif menggunakan filter/page yang sama
- selection dibersihkan atau disesuaikan dengan hasil terbaru
- preview di halaman `Providers` tetap konsisten setelah mutasi yang relevan

## Permissions and Safety

### Row and Bulk Permissions

- User biasa hanya boleh menjalankan aksi pada akun yang memang mereka miliki / boleh kelola sesuai aturan sekarang
- Admin boleh menjalankan aksi pada akun yang saat ini sudah bisa mereka kelola
- Jika selection bulk mencakup item yang tidak eligible, item tersebut tidak ikut diproses dan alasannya harus jelas di hasil akhir

### Bulk Execution Result Model

Bulk actions tidak harus all-or-nothing. Model yang diinginkan adalah **partial success**.

Response bulk minimal harus bisa menyatakan:

- berapa item sukses
- berapa item gagal
- daftar item gagal dengan alasan singkat

UI menampilkan:

- summary toast
- ringkasan hasil di dialog/panel bila ada kegagalan

### Confirmations

Bulk enable, bulk disable, dan bulk disconnect semuanya wajib lewat confirm dialog sebelum mutasi dijalankan.

## Error Handling

- Jika query list gagal, halaman Connected Accounts menampilkan state error yang jelas tanpa menghapus filter URL.
- Jika bulk action gagal sebagian, user tetap melihat hasil partial success, bukan hanya error generik.
- Jika page menjadi kosong setelah filter atau mutasi, halaman otomatis pindah ke page valid terdekat.
- Status/error message pada akun tetap terlihat di row agar troubleshooting cepat.

## Files Likely Affected

### Navigation and Routing

- Modify: `dashboard/src/components/dashboard-nav.tsx`
- Create: `dashboard/src/app/dashboard/connected-accounts/page.tsx`

### Providers Page

- Modify: `dashboard/src/app/dashboard/providers/page.tsx`
- Refactor/split from: `dashboard/src/components/providers/oauth-section.tsx`
- Modify or split: `dashboard/src/components/providers/oauth-credential-list.tsx`
- Modify: `dashboard/src/components/providers/oauth-actions.tsx`

### New Connected Accounts UI Components

Expected new component area:

- `dashboard/src/components/connected-accounts/`

Likely components:

- toolbar
- table
- bulk action bar
- pagination controls
- preview card reuse or adapter for providers page

### API and Provider Layer

- Modify: `dashboard/src/app/api/providers/...` OAuth list route
- Modify: provider ops / query layer in `dashboard/src/lib/providers/`
- Modify: `dashboard/src/lib/api-endpoints.ts`
- Modify: Prisma access/query code as needed
- Modify: `dashboard/prisma/schema.prisma` if new indexes are required

## Testing Requirements

### Frontend

- URL state hydration for `q`, `status`, `page`, `pageSize`
- Connected Accounts page renders server results correctly
- Providers page preview shows maximum 10 items
- View All CTA routes to the new page
- Bulk selection and confirm flow behave correctly

### API / Backend

- list endpoint returns paginated results
- search works for account name, email, provider, and status
- status filter returns only matching rows
- preview mode returns max 10 items and correct total
- bulk action endpoints/reporting support partial success shape

### Integration Behavior

- after enable/disable/disconnect, list refresh preserves active filters and pagination
- permissions are enforced for row and bulk actions
- page fallback works when current page becomes invalid after filtering or mutation

## Open Decisions Resolved in This Spec

- New menu is **top-level Connected Accounts**
- `Providers` keeps a **preview list of maximum 10 connected accounts**
- Preview keeps current visual style as much as practical
- Full dataset moves to dedicated page
- Search scope includes account, provider, and status
- Status dropdown uses real system statuses
- Pagination uses **page numbers**
- Default page size is **50**
- URL stores filter and pagination state
- Bulk actions in v1 include **enable, disable, disconnect**
- Bulk claim is out of scope for v1

## Implementation Notes

Recommended implementation direction adalah memisahkan listing concerns dari `oauth-section.tsx` ke komponen/halaman baru, bukan terus menambah logika ke file existing yang sudah besar. Halaman `Providers` sebaiknya menjadi host untuk connect/import dan preview ringan saja, sedangkan halaman `Connected Accounts` menjadi consumer utama endpoint list baru yang scalable.

Untuk testing dan safe async state handling, implementasi final boleh menambahkan seam/helper runtime kecil di layer page client selama perilaku user-facing tetap sama. Di repo ini, coverage halaman Connected Accounts juga boleh tetap berada di **Node-only Vitest helpers** bila workspace belum menyediakan `jsdom`, `@testing-library/react`, atau `react-test-renderer`; yang penting adalah verifikasi URL-state canonicalization, refresh preservation, page fallback, dan stale-response protection tetap tercakup.
