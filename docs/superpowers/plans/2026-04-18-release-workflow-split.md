# Release Workflow Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the current release automation into a release-orchestration workflow and a tag-driven build/publish workflow, while fixing the Docker builder image so `prisma:generate` works during `npm run build`.

**Architecture:** Keep release creation and image publishing as separate concerns. Workflow A handles `release-please` and explains whether a real tag/release was produced; Workflow B assumes a real tag already exists and only resolves tag/version, builds multi-arch images, pushes GHCR digests/manifests, and updates `version.json`. Docker build reliability is restored by copying `dashboard/scripts/` into the builder stage so the Prisma wrapper script is available during `prebuild`.

**Tech Stack:** GitHub Actions, release-please, Docker Buildx, GHCR, Node.js, Prisma, jq, bash

---

## File Structure

- Modify: `.github/workflows/release.yml`
  - Reduce this workflow to release orchestration only.
  - Remove image build/publish jobs and any build-only conditions.
- Create: `.github/workflows/release-build.yml`
  - Hold the tag-driven build/publish path.
  - Support both tag-push execution and manual rebuild of an existing tag.
- Modify: `dashboard/Dockerfile`
  - Copy `scripts/` into the builder stage before `npm run build`.
- Test/Verify: workflow syntax and Docker build behavior via command-line validation.

---

### Task 1: Reduce `release.yml` to orchestration only

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Save the current workflow behavior as the failing baseline**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('.github/workflows/release.yml').read_text()
for token in ['tag-contributors:', 'build:', 'merge:', 'update-version-json:']:
    print(token, token in text)
PY
```

Expected: all four lines print `True`, proving the workflow still mixes orchestration and build responsibilities.

- [ ] **Step 2: Replace the workflow body with orchestration-only content**

Update `.github/workflows/release.yml` so it contains only the manual release-please path and explicit logging. Use this structure:

```yaml
name: Release Orchestration

on:
  workflow_dispatch:
    inputs:
      action:
        description: "What to do"
        required: true
        type: choice
        options:
          - create-release
        default: create-release

permissions:
  contents: write
  pull-requests: write

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.resolve.outputs.release_created }}
      tag_name: ${{ steps.resolve.outputs.tag_name }}
      version: ${{ steps.resolve.outputs.version }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Resolve release outputs
        id: resolve
        env:
          RP_RELEASE_CREATED: ${{ steps.release.outputs['dashboard--release_created'] || steps.release.outputs.release_created }}
          RP_TAG_NAME: ${{ steps.release.outputs['dashboard--tag_name'] || steps.release.outputs.tag_name }}
          RP_VERSION: ${{ steps.release.outputs['dashboard--version'] || steps.release.outputs.version }}
        run: |
          echo "release_created=${RP_RELEASE_CREATED}" >> "$GITHUB_OUTPUT"
          echo "tag_name=${RP_TAG_NAME}" >> "$GITHUB_OUTPUT"
          echo "version=${RP_VERSION}" >> "$GITHUB_OUTPUT"

      - name: Explain result
        env:
          RELEASE_CREATED: ${{ steps.resolve.outputs.release_created }}
          TAG_NAME: ${{ steps.resolve.outputs.tag_name }}
          VERSION: ${{ steps.resolve.outputs.version }}
        run: |
          if [ "${RELEASE_CREATED}" = "true" ]; then
            echo "✅ Release created: ${TAG_NAME} (${VERSION})"
            echo "📦 Tag push will trigger the release-build workflow automatically."
          else
            echo "ℹ️ No release tag was created. Release Please opened or updated a PR only."
            echo "ℹ️ Build/publish will happen only after a real dashboard-v* tag exists."
          fi
```

- [ ] **Step 3: Verify the workflow no longer contains build jobs**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('.github/workflows/release.yml').read_text()
for token in ['tag-contributors:', 'build:', 'merge:', 'update-version-json:']:
    print(token, token in text)
PY
```

Expected: all four lines print `False`.

- [ ] **Step 4: Validate workflow YAML parses cleanly**

Run:

```bash
python - <<'PY'
import yaml
from pathlib import Path
yaml.safe_load(Path('.github/workflows/release.yml').read_text())
print('release.yml ok')
PY
```

Expected: prints `release.yml ok`.

- [ ] **Step 5: Commit the orchestration split**

```bash
git add .github/workflows/release.yml
git commit -m "ci: split release orchestration from builds"
```

---

### Task 2: Create the tag-driven build/publish workflow

**Files:**
- Create: `.github/workflows/release-build.yml`

- [ ] **Step 1: Write the new workflow file**

Create `.github/workflows/release-build.yml` with this content:

```yaml
name: Release Build

on:
  push:
    tags:
      - "dashboard-v*"
  workflow_dispatch:
    inputs:
      tag_name:
        description: "Existing tag to build (e.g. dashboard-v0.1.50)"
        required: true

permissions:
  contents: write
  packages: write

env:
  IMAGE: ghcr.io/${{ github.repository }}/dashboard

jobs:
  build:
    strategy:
      fail-fast: true
      matrix:
        include:
          - platform: linux/amd64
            runner: self-hosted
            suffix: amd64
          - platform: linux/arm64
            runner: ubuntu-24.04-arm
            suffix: arm64
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: >-
            ${
              { github.event_name == 'push' && github.ref || format('refs/tags/{0}', github.event.inputs.tag_name) }
            }

      - name: Resolve version
        id: version
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            TAG="${{ github.ref_name }}"
          else
            TAG="${{ github.event.inputs.tag_name }}"
          fi
          VERSION=$(echo "$TAG" | sed 's/^.*v//')
          echo "tag_name=${TAG}" >> "$GITHUB_OUTPUT"
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"

      - name: Log in to GHCR
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v4

      - name: Build and push by digest
        id: build
        uses: docker/build-push-action@v7
        with:
          context: ./dashboard
          file: ./dashboard/Dockerfile
          platforms: ${{ matrix.platform }}
          build-args: |
            DASHBOARD_VERSION=${{ steps.version.outputs.tag_name }}
          outputs: type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true

      - name: Export digest
        run: |
          rm -rf /tmp/digests
          mkdir -p /tmp/digests
          digest="${{ steps.build.outputs.digest }}"
          touch "/tmp/digests/${digest#sha256:}"

      - name: Upload digest
        uses: actions/upload-artifact@v7
        with:
          name: digest-${{ matrix.suffix }}
          path: /tmp/digests/*
          if-no-files-found: error
          retention-days: 1

  merge:
    runs-on: ubuntu-latest
    needs: build
    if: ${{ needs.build.result == 'success' }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: >-
            ${
              { github.event_name == 'push' && github.ref || format('refs/tags/{0}', github.event.inputs.tag_name) }
            }

      - name: Resolve version
        id: version
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            TAG="${{ github.ref_name }}"
          else
            TAG="${{ github.event.inputs.tag_name }}"
          fi
          VERSION=$(echo "$TAG" | sed 's/^.*v//')
          echo "tag_name=${TAG}" >> "$GITHUB_OUTPUT"
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"
          echo "tag_sha=$(git rev-parse --short=7 HEAD)" >> "$GITHUB_OUTPUT"

      - name: Download digests
        uses: actions/download-artifact@v8
        with:
          path: /tmp/digests
          pattern: digest-*
          merge-multiple: true

      - name: Log in to GHCR
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Create and push manifest
        working-directory: /tmp/digests
        run: |
          TAGS="-t ${{ env.IMAGE }}:${{ steps.version.outputs.version }} -t ${{ env.IMAGE }}:latest -t ${{ env.IMAGE }}:sha-${{ steps.version.outputs.tag_sha }}"
          SOURCES=""
          for digest in *; do
            SOURCES="$SOURCES ${{ env.IMAGE }}@sha256:$digest"
          done
          docker buildx imagetools create $TAGS $SOURCES

  update-version-json:
    runs-on: ubuntu-latest
    needs: merge
    if: ${{ needs.merge.result == 'success' }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: main

      - name: Resolve version
        id: version
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            TAG="${{ github.ref_name }}"
          else
            TAG="${{ github.event.inputs.tag_name }}"
          fi
          VERSION=$(echo "$TAG" | sed 's/^.*v//')
          echo "tag_name=${TAG}" >> "$GITHUB_OUTPUT"
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"

      - name: Update version.json
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG_NAME: ${{ steps.version.outputs.tag_name }}
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          RELEASE_URL="https://github.com/${{ github.repository }}/releases/tag/${TAG_NAME}"
          RELEASE_NOTES=$(gh release view "${TAG_NAME}" --json body -q .body 2>/dev/null | head -c 2000 || echo "")
          jq -n \
            --arg version "${VERSION}" \
            --arg tag "${TAG_NAME}" \
            --arg url "${RELEASE_URL}" \
            --arg notes "${RELEASE_NOTES}" \
            '{version: $version, tag: $tag, releaseUrl: $url, releaseNotes: $notes}' \
            > version.json

      - name: Commit version.json
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add version.json
          git diff --staged --quiet && echo "No changes to commit" && exit 0
          git commit -m "chore: update version.json for ${{ steps.version.outputs.version }}"
          git push
```

- [ ] **Step 2: Verify the new workflow fails no syntax checks**

Run:

```bash
python - <<'PY'
import yaml
from pathlib import Path
yaml.safe_load(Path('.github/workflows/release-build.yml').read_text())
print('release-build.yml ok')
PY
```

Expected: prints `release-build.yml ok`.

- [ ] **Step 3: Verify the trigger split is explicit in both workflows**

Run:

```bash
python - <<'PY'
from pathlib import Path
release = Path('.github/workflows/release.yml').read_text()
build = Path('.github/workflows/release-build.yml').read_text()
print('release_has_tag_push', 'tags:' in release)
print('build_has_tag_push', 'dashboard-v*' in build)
print('build_has_manual_rebuild', 'tag_name:' in build)
PY
```

Expected:
- `release_has_tag_push False`
- `build_has_tag_push True`
- `build_has_manual_rebuild True`

- [ ] **Step 4: Commit the new build workflow**

```bash
git add .github/workflows/release-build.yml
git commit -m "ci: add tag-driven release build workflow"
```

---

### Task 3: Fix Docker builder context for Prisma generate

**Files:**
- Modify: `dashboard/Dockerfile`

- [ ] **Step 1: Write the failing Docker expectation down**

Use the current failure symptom as the baseline:

```text
Error: Cannot find module '/app/scripts/prisma-generate.mjs'
```

The builder must contain `scripts/prisma-generate.mjs` before `npm run build` executes.

- [ ] **Step 2: Add the missing builder copy step**

Update `dashboard/Dockerfile` like this:

```dockerfile
COPY package.json package-lock.json ./
COPY next.config.ts tsconfig.json prisma.config.ts postcss.config.mjs ./
COPY public ./public
COPY src ./src
COPY messages ./messages
COPY prisma ./prisma
COPY scripts ./scripts

ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
```

Place `COPY scripts ./scripts` in the builder stage before `RUN NODE_OPTIONS=--max-old-space-size=512 npm run build`.

- [ ] **Step 3: Verify the Dockerfile now includes scripts**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('dashboard/Dockerfile').read_text()
print('COPY scripts ./scripts' in text)
PY
```

Expected: prints `True`.

- [ ] **Step 4: Run a local Docker build verification**

Run:

```bash
docker build -f dashboard/Dockerfile dashboard --build-arg DASHBOARD_VERSION=dashboard-v0.0.0-test -t cliproxyapi-dashboard:test
```

Expected: the build reaches and passes the `npm run build` stage without the missing-module error for `/app/scripts/prisma-generate.mjs`.

- [ ] **Step 5: Commit the Docker fix**

```bash
git add dashboard/Dockerfile
git commit -m "fix(dashboard): include prisma generate script in docker build"
```

---

### Task 4: Validate end-to-end release assumptions

**Files:**
- Modify: `.github/workflows/release.yml` (if small follow-up comments are needed)
- Modify: `.github/workflows/release-build.yml` (if small follow-up comments are needed)

- [ ] **Step 1: Validate the workflows one more time together**

Run:

```bash
python - <<'PY'
import yaml
from pathlib import Path
for file in ['.github/workflows/release.yml', '.github/workflows/release-build.yml']:
    yaml.safe_load(Path(file).read_text())
    print(file, 'ok')
PY
```

Expected:
- `.github/workflows/release.yml ok`
- `.github/workflows/release-build.yml ok`

- [ ] **Step 2: Verify the release workflow no longer references build-only outputs**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('.github/workflows/release.yml').read_text()
for token in ['needs: [release-please, build]', 'update-version-json:', 'docker/build-push-action']:
    print(token, token in text)
PY
```

Expected: all three lines print `False`.

- [ ] **Step 3: Verify the build workflow derives tag/version without `needs.release-please`**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('.github/workflows/release-build.yml').read_text()
print('needs.release-please' in text)
print('github.ref_name' in text)
print('github.event.inputs.tag_name' in text)
PY
```

Expected:
- `False`
- `True`
- `True`

- [ ] **Step 4: Commit any final workflow comment cleanup if needed**

If Steps 1-3 require no additional edits, skip this commit. If you add clarifying comments only, use:

```bash
git add .github/workflows/release.yml .github/workflows/release-build.yml
git commit -m "docs(ci): clarify split release workflow behavior"
```

---

## Final Verification Checklist

- [ ] Validate both workflow files parse:

```bash
python - <<'PY'
import yaml
from pathlib import Path
for file in ['.github/workflows/release.yml', '.github/workflows/release-build.yml']:
    yaml.safe_load(Path(file).read_text())
    print(file, 'ok')
PY
```

Expected: both files print `ok`.

- [ ] Verify Docker builder includes the Prisma wrapper script:

```bash
python - <<'PY'
from pathlib import Path
text = Path('dashboard/Dockerfile').read_text()
print('COPY scripts ./scripts' in text)
PY
```

Expected: prints `True`.

- [ ] Run the Docker build smoke test:

```bash
docker build -f dashboard/Dockerfile dashboard --build-arg DASHBOARD_VERSION=dashboard-v0.0.0-test -t cliproxyapi-dashboard:test
```

Expected: build succeeds; no `/app/scripts/prisma-generate.mjs` missing-module error.

- [ ] Review final git diff for only intended files:

```bash
git diff -- .github/workflows/release.yml .github/workflows/release-build.yml dashboard/Dockerfile
```

Expected: diff limited to workflow split and Docker builder copy fix.

## Self-Review Notes

- **Spec coverage:** Plan covers workflow split, tag-driven build semantics, manual rebuild support, and Docker builder fix for `scripts/prisma-generate.mjs`.
- **Placeholder scan:** No `TODO`/`TBD` placeholders remain; commands and file paths are explicit.
- **Type consistency:** The plan consistently uses `release.yml` as orchestration-only and `release-build.yml` as tag-driven build workflow.
