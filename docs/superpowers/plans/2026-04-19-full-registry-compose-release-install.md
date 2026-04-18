# Full Registry Compose, Release, and Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert production deployment to full-registry mode for `dashboard` and `perplexity-sidecar`, publish both images from one shared release tag, and keep `install.sh` aligned with registry-backed production compose.

**Architecture:** Split responsibilities cleanly: `docker-compose.yml` becomes production registry source of truth, `.github/workflows/release-build.yml` publishes both internal images from one `dashboard-v*` tag, and `install.sh` remains a compose/env installer with no source-build dependency. Keep local/dev compose unchanged.

**Tech Stack:** Docker Compose, GitHub Actions, GHCR, Bash installer, Docker multi-arch builds

---

## File Structure

- Modify: `docker-compose.yml`
  - Replace `build:` for `dashboard` and `perplexity-sidecar` with registry `image:` references.
  - Add tag env contract for both internal services.
- Modify: `.github/workflows/release-build.yml`
  - Expand from dashboard-only publishing to service-aware matrix build/publish for `dashboard` and `perplexity-sidecar`.
  - Keep manual rebuild safe: no `latest` or `version.json` update on manual rebuilds.
- Modify: `install.sh`
  - Align comments/help/env writing with registry-backed production behavior.
  - Optionally write image tag env vars only if needed; avoid broad installer redesign.
- Test/verify with command checks, workflow YAML parsing, compose rendering, and Docker build smoke tests.

## Delivery Order

1. Convert production compose to registry-only for internal services.
2. Expand release-build workflow to publish both images safely.
3. Align installer/env contract with registry-backed production compose.
4. Run end-to-end verification across compose, workflow semantics, and Docker builds.

---

### Task 1: Convert production compose to registry-backed images

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Write a failing compose regression check**

Run this from repo root:

```bash
python - <<'PY'
from pathlib import Path
text = Path('docker-compose.yml').read_text()
checks = {
    'dashboard_build_present': 'dashboard:\n    build:' in text,
    'perplexity_build_present': 'perplexity-sidecar:\n    build:' in text,
}
for key, value in checks.items():
    print(f'{key}={value}')
if not all(checks.values()):
    raise SystemExit('Expected both local build blocks to exist before Task 1')
PY
```

Expected: shows both `dashboard_build_present=True` and `perplexity_build_present=True`.

- [ ] **Step 2: Replace local builds with registry images**

Update `docker-compose.yml` like this:

```yaml
  perplexity-sidecar:
    profiles: ["perplexity"]
    image: ghcr.io/${GITHUB_REPO:-itsmylife44/cliproxyapi-dashboard}/perplexity-sidecar:${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}
    container_name: cliproxyapi-perplexity-sidecar
```

And:

```yaml
  dashboard:
    image: ghcr.io/${GITHUB_REPO:-itsmylife44/cliproxyapi-dashboard}/dashboard:${DASHBOARD_IMAGE_TAG:-latest}
    container_name: cliproxyapi-dashboard
```

Do not change healthchecks, environment, volumes, networks, profiles, or dependencies.

- [ ] **Step 3: Verify compose renders with registry-backed internal services**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('docker-compose.yml').read_text()
checks = {
    'dashboard_build_removed': 'dashboard:\n    build:' not in text,
    'perplexity_build_removed': 'perplexity-sidecar:\n    build:' not in text,
    'dashboard_image_present': '/dashboard:${DASHBOARD_IMAGE_TAG:-latest}' in text,
    'sidecar_image_present': '/perplexity-sidecar:${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}' in text,
}
for key, value in checks.items():
    print(f'{key}={value}')
if not all(checks.values()):
    raise SystemExit('Compose registry conversion incomplete')
PY

docker compose --env-file infrastructure/.env -f docker-compose.yml config >/tmp/full-registry-compose.rendered.yml
```

Expected:
- all Python checks print `True`
- `docker compose config` exits 0.

- [ ] **Step 4: Commit Task 1**

```bash
git add docker-compose.yml
git commit -m "fix(deploy): use registry images in production compose"
```

---

### Task 2: Publish dashboard and sidecar from one release tag

**Files:**
- Modify: `.github/workflows/release-build.yml`

- [ ] **Step 1: Write failing workflow-structure checks**

Run from repo root:

```bash
python - <<'PY'
import yaml
from pathlib import Path
data = yaml.load(Path('.github/workflows/release-build.yml').read_text(), Loader=yaml.BaseLoader)
text = Path('.github/workflows/release-build.yml').read_text()
print('has_dashboard_image=', '/dashboard' in text)
print('has_sidecar_image=', '/perplexity-sidecar' in text)
print('has_service_matrix=', 'service:' in text)
print('has_sidecar_context=', './perplexity-sidecar' in text)
if '/perplexity-sidecar' in text:
    raise SystemExit('Task 2 already implemented')
PY
```

Expected: sidecar-related checks fail/missing before implementation.

- [ ] **Step 2: Expand workflow to service-aware matrix publishing**

Refactor `.github/workflows/release-build.yml` so build matrix includes both service and platform. Use this shape:

```yaml
env:
  DASHBOARD_IMAGE: ghcr.io/${{ github.repository }}/dashboard
  PERPLEXITY_SIDECAR_IMAGE: ghcr.io/${{ github.repository }}/perplexity-sidecar

jobs:
  build:
    strategy:
      fail-fast: true
      matrix:
        include:
          - service: dashboard
            image: ghcr.io/${{ github.repository }}/dashboard
            context: ./dashboard
            file: ./dashboard/Dockerfile
            build_args: |
              DASHBOARD_VERSION=${{ steps.version.outputs.tag_name }}
            platform: linux/amd64
            runner: self-hosted
            suffix: dashboard-amd64
          - service: dashboard
            image: ghcr.io/${{ github.repository }}/dashboard
            context: ./dashboard
            file: ./dashboard/Dockerfile
            build_args: |
              DASHBOARD_VERSION=${{ steps.version.outputs.tag_name }}
            platform: linux/arm64
            runner: ubuntu-24.04-arm
            suffix: dashboard-arm64
          - service: perplexity-sidecar
            image: ghcr.io/${{ github.repository }}/perplexity-sidecar
            context: ./perplexity-sidecar
            file: ./perplexity-sidecar/Dockerfile
            build_args: ""
            platform: linux/amd64
            runner: self-hosted
            suffix: perplexity-sidecar-amd64
          - service: perplexity-sidecar
            image: ghcr.io/${{ github.repository }}/perplexity-sidecar
            context: ./perplexity-sidecar
            file: ./perplexity-sidecar/Dockerfile
            build_args: ""
            platform: linux/arm64
            runner: ubuntu-24.04-arm
            suffix: perplexity-sidecar-arm64
```

Then make `docker/build-push-action` use matrix values:

```yaml
with:
  context: ${{ matrix.context }}
  file: ${{ matrix.file }}
  platforms: ${{ matrix.platform }}
  build-args: ${{ matrix.build_args }}
  outputs: type=image,name=${{ matrix.image }},push-by-digest=true,name-canonical=true,push=true
```

In `merge`, group digests by service and publish manifests separately. For each service:

```bash
TAGS="-t ${IMAGE}:${VERSION} -t ${IMAGE}:sha-${TAG_SHA}"
if [ "${{ github.event_name }}" = "push" ]; then
  TAGS="$TAGS -t ${IMAGE}:latest"
fi
docker buildx imagetools create $TAGS $SOURCES
```

Keep `update-version-json` push-only.

- [ ] **Step 3: Verify workflow semantics after the refactor**

Run:

```bash
python - <<'PY'
import yaml
from pathlib import Path
text = Path('.github/workflows/release-build.yml').read_text()
yaml.load(text, Loader=yaml.BaseLoader)
checks = {
    'has_dashboard_image': '/dashboard' in text,
    'has_sidecar_image': '/perplexity-sidecar' in text,
    'has_sidecar_context': './perplexity-sidecar' in text,
    'has_service_matrix': 'service:' in text,
    'manual_has_tag_name': 'tag_name:' in text,
    'push_only_version_json': "needs.merge.result == 'success' && github.event_name == 'push'" in text,
}
for key, value in checks.items():
    print(f'{key}={value}')
if not all(checks.values()):
    raise SystemExit('Workflow split verification failed')
PY
```

Expected: all checks print `True`.

- [ ] **Step 4: Commit Task 2**

```bash
git add .github/workflows/release-build.yml
git commit -m "fix(ci): publish dashboard and sidecar images"
```

---

### Task 3: Align installer/env contract with registry-backed production

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Write a failing installer-alignment check**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('install.sh').read_text()
checks = {
    'mentions_dashboard_tag_env': 'DASHBOARD_IMAGE_TAG' in text,
    'mentions_sidecar_tag_env': 'PERPLEXITY_SIDECAR_IMAGE_TAG' in text,
}
for key, value in checks.items():
    print(f'{key}={value}')
if any(checks.values()):
    raise SystemExit('Installer already aligned; Task 3 assumptions stale')
PY
```

Expected: both checks print `False` before implementation.

- [ ] **Step 2: Add minimal registry-tag env alignment**

Keep installer behavior simple. Add env-file output for explicit image-tag overrides only when writing `.env`, near other compose/runtime variables:

```bash
write_env_assignment "$ENV_FILE" "DASHBOARD_IMAGE_TAG" "${DASHBOARD_IMAGE_TAG:-latest}"
write_env_assignment "$ENV_FILE" "PERPLEXITY_SIDECAR_IMAGE_TAG" "${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}"
```

If script does not already expose these shell vars, define them conservatively before env writing:

```bash
DASHBOARD_IMAGE_TAG="${DASHBOARD_IMAGE_TAG:-latest}"
PERPLEXITY_SIDECAR_IMAGE_TAG="${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}"
```

Also update nearby comments/help text so production path is clearly registry-backed, not source-build-backed.

- [ ] **Step 3: Verify installer alignment stays narrow**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('install.sh').read_text()
checks = {
    'dashboard_tag_env_present': 'DASHBOARD_IMAGE_TAG' in text,
    'sidecar_tag_env_present': 'PERPLEXITY_SIDECAR_IMAGE_TAG' in text,
    'compose_up_still_present': 'docker compose --env-file' in text and 'up -d --wait' in text,
}
for key, value in checks.items():
    print(f'{key}={value}')
if not all(checks.values()):
    raise SystemExit('Installer alignment incomplete')
PY
```

Expected: all checks print `True`.

- [ ] **Step 4: Commit Task 3**

```bash
git add install.sh
git commit -m "fix(installer): align env with registry compose"
```

---

### Task 4: Run end-to-end release/deploy verification

**Files:**
- Verify only:
  - `docker-compose.yml`
  - `.github/workflows/release.yml`
  - `.github/workflows/release-build.yml`
  - `dashboard/Dockerfile`
  - `install.sh`

- [ ] **Step 1: Verify workflow YAML and split semantics**

Run:

```bash
python - <<'PY'
import yaml
from pathlib import Path
for name in ['.github/workflows/release.yml', '.github/workflows/release-build.yml']:
    yaml.load(Path(name).read_text(), Loader=yaml.BaseLoader)
    print(f'{name}: parse ok')

release = yaml.load(Path('.github/workflows/release.yml').read_text(), Loader=yaml.BaseLoader)
build = yaml.load(Path('.github/workflows/release-build.yml').read_text(), Loader=yaml.BaseLoader)
print('release_on=', release.get('on'))
print('build_on=', build.get('on'))
PY
```

Expected: both parse ok; `release.yml` remains orchestration-only; `release-build.yml` owns tag/manual build triggers.

- [ ] **Step 2: Verify production compose renders without local internal builds**

Run:

```bash
python - <<'PY'
from pathlib import Path
text = Path('docker-compose.yml').read_text()
checks = {
    'dashboard_build_removed': 'dashboard:\n    build:' not in text,
    'perplexity_build_removed': 'perplexity-sidecar:\n    build:' not in text,
    'dashboard_image_present': '/dashboard:${DASHBOARD_IMAGE_TAG:-latest}' in text,
    'sidecar_image_present': '/perplexity-sidecar:${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}' in text,
}
for key, value in checks.items():
    print(f'{key}={value}')
if not all(checks.values()):
    raise SystemExit('Compose registry conversion incomplete')
PY

docker compose --env-file infrastructure/.env -f docker-compose.yml config >/tmp/full-registry-compose.rendered.yml
```

Expected: all checks `True`; compose config exits 0.

- [ ] **Step 3: Smoke-test both Docker build contexts**

Run:

```bash
docker build -f dashboard/Dockerfile dashboard --build-arg DASHBOARD_VERSION=dashboard-v0.0.0-test -t cliproxyapi-dashboard:test
docker build -f perplexity-sidecar/Dockerfile perplexity-sidecar -t cliproxyapi-perplexity-sidecar:test
```

Expected: both builds exit 0.

- [ ] **Step 4: Commit final verification-only follow-up if needed**

If verification required no code changes, skip commit.
If you made tiny follow-up fixes during verification:

```bash
git add docker-compose.yml .github/workflows/release-build.yml install.sh dashboard/Dockerfile
git commit -m "fix(deploy): finish registry-only release path"
```

---

## Final Verification Checklist

- [ ] Parse workflows:

```bash
python - <<'PY'
import yaml
from pathlib import Path
for name in ['.github/workflows/release.yml', '.github/workflows/release-build.yml']:
    yaml.load(Path(name).read_text(), Loader=yaml.BaseLoader)
    print(f'{name}: parse ok')
PY
```

- [ ] Render production compose:

```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml config >/tmp/full-registry-compose.rendered.yml
```

- [ ] Smoke-test dashboard build:

```bash
docker build -f dashboard/Dockerfile dashboard --build-arg DASHBOARD_VERSION=dashboard-v0.0.0-test -t cliproxyapi-dashboard:test
```

- [ ] Smoke-test sidecar build:

```bash
docker build -f perplexity-sidecar/Dockerfile perplexity-sidecar -t cliproxyapi-perplexity-sidecar:test
```

## Self-Review Notes

- **Spec coverage:** plan covers compose conversion, workflow expansion for two images, installer/env alignment, and verification.
- **Placeholder scan:** no TBD/TODO placeholders left; each task has concrete files, commands, and expected outputs.
- **Type consistency:** shared env names used consistently: `DASHBOARD_IMAGE_TAG`, `PERPLEXITY_SIDECAR_IMAGE_TAG`, shared release tag `dashboard-v*`.
