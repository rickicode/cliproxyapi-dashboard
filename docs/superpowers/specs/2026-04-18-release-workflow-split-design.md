# Release Workflow Split Design

## Summary

Pisahkan otomasi release saat ini menjadi dua workflow GitHub Actions yang punya tanggung jawab jelas: workflow pertama hanya mengurus release orchestration (`release-please` dan pembuatan tag/release), sedangkan workflow kedua hanya mengurus build/publish image setelah tag release nyata sudah ada. Sekaligus perbaiki Docker build dashboard dengan memastikan `dashboard/scripts/prisma-generate.mjs` ikut tercopy ke builder image.

## Goals

- Menghilangkan kondisi membingungkan saat `release-please` sukses tetapi job downstream di-skip karena `release_created=false`.
- Membuat build/publish GHCR berjalan otomatis setelah tag release `dashboard-v*` benar-benar dibuat.
- Mempertahankan kemampuan manual untuk membangun tag yang sudah ada.
- Memperbaiki kegagalan Docker build akibat `npm run build` memanggil `node ./scripts/prisma-generate.mjs` yang belum tersedia di image builder.
- Menyederhanakan debugging release pipeline dengan memisahkan fase “create release” dan fase “build from tag”.

## Non-Goals

- Tidak mengubah strategi tagging versi dashboard (`dashboard-v*`).
- Tidak mengganti `release-please` dengan tool lain.
- Tidak mengubah logika multi-arch publish ke registry selain yang diperlukan untuk memindahkan job ke workflow terpisah.
- Tidak mendesain ulang semua workflow GitHub Actions lain di repository.

## Current State

### Workflow saat ini

File aktif ada di `.github/workflows/release.yml` dan mencampur dua concern sekaligus:

1. **release orchestration**
   - `workflow_dispatch` dengan `action=create-release`
   - menjalankan `googleapis/release-please-action@v4`
   - mengekspor `release_created`, `tag_name`, `version`

2. **build/publish**
   - build image multi-arch
   - push per-platform digest ke GHCR
   - merge manifest multi-arch
   - update `version.json`

Akibatnya, workflow harus memakai `if:` yang kompleks dan bercampur antara tiga mode eksekusi:

- `workflow_dispatch` + `create-release`
- `workflow_dispatch` + `build-existing-tag`
- `push` pada `refs/tags/dashboard-v*`

### Masalah operasional utama

1. **Skipped downstream jobs**
   - Saat `release-please` hanya membuka atau mengupdate PR release, `release_created=false`.
   - Dalam kondisi ini, `build`, `merge`, `tag-contributors`, dan `update-version-json` bisa terlihat “stuck” atau ter-skip, padahal sebenarnya condition gate-nya tidak terpenuhi.

2. **Ambiguitas alur rilis**
   - User mengharapkan `create-release` untuk “langsung jalan terus” sampai build image.
   - Workflow saat ini secara implisit butuh tag/release nyata agar build path benar-benar valid.

3. **Docker build gagal**
   - `dashboard/package.json` mendefinisikan:
     - `prisma:generate = node ./scripts/prisma-generate.mjs`
     - `prebuild = npm run prisma:generate`
   - `dashboard/Dockerfile` builder stage belum menyalin `scripts/`.
   - Hasilnya, `npm run build` di Docker gagal dengan `Cannot find module '/app/scripts/prisma-generate.mjs'`.

## Proposed Design

### Workflow A: Release Orchestration

Buat workflow baru, misalnya `.github/workflows/release-orchestration.yml`.

**Trigger**
- `workflow_dispatch`

**Inputs**
- `action`:
  - `create-release`
  - optional: `build-existing-tag` tidak lagi berada di workflow ini

**Responsibility**
- Menjalankan `release-please`.
- Mengekspor status release secara eksplisit di log.
- Jika `release_created=false`, workflow selesai dengan sukses dan menjelaskan bahwa PR release sudah dibuka/diupdate dan build akan terjadi hanya setelah tag nyata dibuat.
- Jika `release_created=true`, workflow tidak melakukan build langsung; workflow build akan dipicu oleh tag push atau release publish path yang memang menghasilkan tag nyata.

**Why**
- Workflow ini menjadi “control plane” saja.
- Tidak perlu lagi `needs: release-please` untuk job build, merge, dan publish.
- Error surface jadi kecil: kalau ada masalah di release-please, itu jelas terisolasi di workflow ini.

### Workflow B: Build and Publish From Tag

Gunakan workflow kedua, misalnya `.github/workflows/release-build.yml`.

**Trigger utama**
- `push` pada tag `dashboard-v*`

**Trigger manual opsional**
- `workflow_dispatch` dengan input:
  - `tag_name`
  - dipakai untuk rebuild tag lama kalau perlu

**Responsibility**
- checkout pada tag yang relevan
- resolve version/tag name
- build multi-arch per platform
- push digest ke GHCR
- merge manifest multi-arch
- publish channel tags seperti `latest` dan `sha-*` bila policy release mengizinkan
- update `version.json`
- optional contributor tagging / release note post-processing yang memang membutuhkan tag nyata

**Why**
- Semua job di workflow ini punya satu asumsi kuat: tag release sudah ada.
- Tidak ada lagi kondisi bercabang yang mencoba menangani “PR release sudah ada tapi tag belum ada”.

### Docker Build Fix

Di `dashboard/Dockerfile` builder stage, tambahkan:

```dockerfile
COPY scripts ./scripts
```

Ini harus ditempatkan sebelum `RUN NODE_OPTIONS=--max-old-space-size=512 npm run build`, supaya `prebuild -> prisma:generate` bisa menemukan `scripts/prisma-generate.mjs`.

### Release Semantics After Change

Setelah desain ini diterapkan:

1. User menjalankan **release-orchestration** secara manual.
2. `release-please`:
   - kalau hanya update PR release → workflow selesai, tidak ada build, dan itu normal
   - kalau benar-benar membuat release/tag → tag push terjadi
3. Tag `dashboard-v*` memicu **release-build**.
4. Workflow build mendorong image ke GHCR dan memperbarui metadata release terkait.

Ini membuat perilaku “create release lalu build jalan otomatis berdasarkan tag yang dibuat” menjadi eksplisit dan deterministik.

## Detailed File Changes

### 1. `.github/workflows/release.yml`

Refactor file ini menjadi salah satu dari dua pendekatan berikut:

- **Preferred:** rename/replace menjadi workflow orchestration saja
- atau pertahankan file ini sebagai orchestration dan buat file baru untuk build

Isi final workflow orchestration seharusnya hanya mencakup:
- `workflow_dispatch`
- `release-please`
- output resolution / logging
- optional lightweight post-release metadata steps yang tidak bergantung pada build image

Job yang harus dipindahkan keluar dari workflow ini:
- `build`
- `merge`
- `update-version-json`
- `tag-contributors` jika benar-benar memerlukan tag release yang sudah published

### 2. `.github/workflows/release-build.yml` (new)

Workflow baru ini harus memuat logic yang sekarang tersebar di job:
- `build`
- `merge`
- `update-version-json`
- possibly `tag-contributors`

Expected invariants:
- tidak ada dependency pada `needs.release-please.outputs.*`
- source of truth untuk tag/version berasal dari:
  - `github.ref_name` untuk `push`
  - `workflow_dispatch.inputs.tag_name` untuk rebuild manual

### 3. `dashboard/Dockerfile`

Tambahkan copy step untuk `scripts/` di builder stage.

### 4. `dashboard/package.json`

Tidak perlu diubah untuk desain ini; script wrapper `prisma:generate` tetap valid dan justru menjadi alasan kenapa Dockerfile harus ikut menyalin `scripts/`.

## Error Handling

### Release orchestration
- Jika `release_created=false`, workflow harus exit sukses dengan message jelas, bukan terlihat “stuck”.
- Jika `release-please` gagal, workflow fail cepat dan tidak memicu ekspektasi build.

### Build workflow
- Jika runner tidak tersedia, stuck state sekarang akan lebih jujur: itu murni problem runner build, bukan ambigu antara release PR vs tag state.
- Jika Docker build gagal, error akan fokus pada build context/image issue.

### version.json update
- Hanya dijalankan di workflow build ketika tag valid sudah ada dan image workflow sudah masuk jalur publish.

## Alternatives Considered

### A. Pertahankan satu workflow, rapikan `if:` conditions

**Rejected** karena masih mencampur dua fase berbeda dan tetap sulit dipahami user/operator saat `release_created=false`.

### B. Jalankan build langsung dari workflow `create-release`

**Rejected** karena membuat release-please PR/update path terlalu coupled dengan build lifecycle, padahal release-please bisa sukses tanpa membuat tag final.

### C. Split dua workflow

**Chosen** karena paling jelas secara operasional dan paling mudah di-debug.

## Testing Strategy

### Static validation
- Validate both workflow files parse correctly.
- Check trigger matrix and `if:` expressions are internally consistent.

### Release orchestration scenarios
- Manual dispatch `create-release` when release-please only updates PR:
  - expected: orchestration workflow succeeds, no build attempted there
- Manual dispatch `create-release` when release/tag is created:
  - expected: tag exists, build workflow triggered by tag push

### Build scenarios
- Tag push `dashboard-vX.Y.Z`:
  - expected: build workflow resolves tag/version correctly, builds, pushes to GHCR, merges manifest
- Manual rebuild of existing tag:
  - expected: same build path works from explicit `tag_name`

### Docker validation
- Build dashboard image locally or in CI with the updated Dockerfile.
- Confirm `npm run build` no longer fails with missing `/app/scripts/prisma-generate.mjs`.

## Scope Boundary

This design intentionally does **not** solve:
- Node 20 deprecation in `googleapis/release-please-action@v4` beyond preserving awareness of the warning. That can be a follow-up workflow dependency upgrade task.
- Self-hosted / ARM runner availability issues beyond making them easier to diagnose within the dedicated build workflow.
- Broader release-note or contributor automation redesign unrelated to the split.

## Recommended Next Step

Write an implementation plan that:
1. defines the exact split between orchestration and build workflows,
2. preserves existing release tag naming,
3. patches `dashboard/Dockerfile` to copy `scripts/`,
4. includes verification commands for workflow syntax and Docker build behavior.
