# Full Registry Compose, Release, and Install Design

## Summary

Move the production deployment path to a full-registry model for project-owned services so `docker-compose.yml` no longer performs local builds for `dashboard` or `perplexity-sidecar`. Release automation will publish both images from a single shared release tag, and `install.sh` will rely on the registry-backed Compose file instead of local image builds.

## Goals

- Remove production/local-install dependence on Compose `build:` for `dashboard`.
- Remove production/local-install dependence on Compose `build:` for `perplexity-sidecar`.
- Keep one shared release tag format (`dashboard-vX.Y.Z`) that publishes versioned and `latest` tags for both images.
- Ensure `install.sh` can install/update by writing config/env and running Docker Compose only.
- Preserve manual rebuild support without letting older tags overwrite `latest`.
- Keep local developer workflows isolated from production requirements unless explicitly changed later.

## Non-Goals

- Do not convert third-party services (`postgres`, `caddy`, `docker-socket-proxy`, `eceasy/cli-proxy-api-plus`) into project-owned images.
- Do not redesign the existing release-tag naming convention away from `dashboard-v*` in this iteration.
- Do not force `docker-compose.local.yml` or other local/dev-only Compose files to become registry-only.
- Do not add a second independent version stream for `perplexity-sidecar`.

## Current State

### Production Compose still builds locally

`docker-compose.yml` currently contains:

- `perplexity-sidecar.build: ./perplexity-sidecar`
- `dashboard.build.context: ./dashboard`

That means a production install/update path still requires local source build context even though release automation already publishes dashboard images to GHCR.

### Release automation only publishes dashboard

Current split release workflow state:

- `.github/workflows/release.yml` = orchestration only.
- `.github/workflows/release-build.yml` = tag-driven build/publish workflow.

But `release-build.yml` currently builds and publishes only the `dashboard` image. `perplexity-sidecar` has no matching registry publication path yet.

### Installer assumes Compose is deployable as-is

`install.sh` is designed around provisioning Docker, env/config, and then running Compose for the production stack. If Compose still contains local builds for internal services, the install path is more fragile than necessary and is not truly registry-backed.

## Chosen Direction

Use **one shared release tag** (`dashboard-vX.Y.Z`) for all project-owned runtime images in the stack.

A single official release tag will publish:

- `ghcr.io/<owner>/<repo>/dashboard:<version>`
- `ghcr.io/<owner>/<repo>/dashboard:latest`
- `ghcr.io/<owner>/<repo>/perplexity-sidecar:<version>`
- `ghcr.io/<owner>/<repo>/perplexity-sidecar:latest`

This keeps production deployment simple:

- one version concept for the stack’s internal images
- one release workflow trigger
- one Compose source of truth
- one installer path that only needs compose/env/config, not build context.

## Rejected Alternatives

### 1. Dashboard-only registry

Rejected because it leaves `perplexity-sidecar` as a special-case local build and does not satisfy the user’s stated requirement that there should be no local build in the deployment path.

### 2. Separate tags per component

Rejected because it complicates release coordination, Compose pinning, installer behavior, and operator understanding. It also creates avoidable mismatch risk between dashboard and sidecar versions.

### 3. Brand-new global stack tag prefix

Rejected because it would add migration cost and rework around an existing release model that already revolves around `dashboard-v*`. The existing tag format can serve as the shared release trigger without widening scope further.

## Architecture

### 1. Production Compose becomes registry-backed for project-owned services

`docker-compose.yml` will be updated so these services use `image:` instead of `build:`:

- `dashboard`
- `perplexity-sidecar`

Recommended image variables:

- `DASHBOARD_IMAGE_TAG=${DASHBOARD_IMAGE_TAG:-latest}`
- `PERPLEXITY_SIDECAR_IMAGE_TAG=${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}`

Recommended image names:

- `ghcr.io/${GITHUB_REPO:-itsmylife44/cliproxyapi-dashboard}/dashboard:${DASHBOARD_IMAGE_TAG:-latest}`
- `ghcr.io/${GITHUB_REPO:-itsmylife44/cliproxyapi-dashboard}/perplexity-sidecar:${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}`

This preserves:

- `latest` as the default production channel
- explicit pinning for rollbacks or deterministic installs
- compatibility with an installer that writes env values without editing Compose structure.

### 2. Release build workflow publishes two internal images

`.github/workflows/release-build.yml` will evolve from a dashboard-only workflow into a shared internal-image publisher.

It will still trigger on:

- `push` tags `dashboard-v*`
- `workflow_dispatch` with explicit `tag_name`

But the build/publish logic will now handle two image families:

- `dashboard`
- `perplexity-sidecar`

For each service, the workflow must publish:

- version tag (`:<version>`)
- immutable sha tag (if already used operationally)
- `latest` only on real tag-push release events, not manual rebuilds.

Manual rebuild rules remain conservative:

- rebuilding an older tag may republish that version tag
- rebuilding an older tag must not move `latest`
- rebuilding an older tag must not rewrite `version.json` on `main`.

### 3. Installer uses registry-backed Compose only

`install.sh` should treat the production Compose file as directly deployable.

Its responsibilities remain:

- install Docker / Compose
- provision secrets and environment
- write config files
- run `docker compose up -d --wait`

It should not require source builds for project-owned services in the normal install path.

If version pinning is exposed, the installer can optionally write:

- `DASHBOARD_IMAGE_TAG`
- `PERPLEXITY_SIDECAR_IMAGE_TAG`

Otherwise, production will default cleanly to `latest` for both.

## File-Level Design

### `docker-compose.yml`

Modify:

- `services.perplexity-sidecar`
  - replace `build: ./perplexity-sidecar` with `image: .../perplexity-sidecar:${PERPLEXITY_SIDECAR_IMAGE_TAG:-latest}`
- `services.dashboard`
  - replace `build.context: ./dashboard` with `image: .../dashboard:${DASHBOARD_IMAGE_TAG:-latest}`

Keep all existing:

- environment
- healthchecks
- volumes
- networks
- profiles
- dependencies

No unrelated service changes.

### `.github/workflows/release-build.yml`

Expand to support both service images.

Preferred shape:

- build matrix includes service + platform, e.g.
  - `dashboard` / `linux/amd64`
  - `dashboard` / `linux/arm64`
  - `perplexity-sidecar` / `linux/amd64`
  - `perplexity-sidecar` / `linux/arm64`
- image naming is service-specific
- Docker build context/file vary by service:
  - dashboard:
    - context `./dashboard`
    - file `./dashboard/Dockerfile`
    - build arg `DASHBOARD_VERSION=<tag>`
  - perplexity-sidecar:
    - context `./perplexity-sidecar`
    - file `./perplexity-sidecar/Dockerfile` or default Dockerfile path if present

Manifest merge step should also be service-aware, creating a manifest per service rather than a single one.

`update-version-json` should remain tied to the stack release and only run on real push tag events.

### `install.sh`

Review and update only where necessary so the installer matches the registry-backed production compose model.

Expected changes are small and likely limited to:

- comments/help text that still imply local builds
- any env generation paths that should optionally set image-tag variables

If no runtime build logic exists in `install.sh`, keep code changes minimal and focus on aligning documentation/comments and env contract.

### `docker-compose.local.yml`

No change in this scope.

Reason:

- local/dev workflows often intentionally use `build:`
- the user’s requirement is about `install.sh` and production deployment simplicity
- changing local/dev deployment would widen scope unnecessarily.

## Tagging Semantics

Single release tag source of truth:

- input: `dashboard-v1.2.3`
- derived version: `1.2.3`

Published image tags:

- Dashboard:
  - `ghcr.io/<repo>/dashboard:1.2.3`
  - `ghcr.io/<repo>/dashboard:latest`
- Perplexity sidecar:
  - `ghcr.io/<repo>/perplexity-sidecar:1.2.3`
  - `ghcr.io/<repo>/perplexity-sidecar:latest`

Manual rebuilds by `tag_name`:

- republish versioned tags only
- do not move `latest`
- do not update `version.json`.

## Error Handling and Safety Rules

- If one service/platform build fails, the workflow should fail and not publish partial `latest` manifests for that service.
- Merge/publish steps must use `needs.build.result == 'success'` semantics per service path.
- If `perplexity-sidecar` profile is unused in production, the image can still be published; Compose profile controls runtime activation, not whether the artifact exists.
- Production compose should not depend on a checked-out source tree to deploy these two services.

## Verification Plan

Implementation must verify all of the following:

1. **Compose production source-of-truth is registry-backed**
   - `docker-compose.yml` no longer contains local `build:` for `dashboard` or `perplexity-sidecar`
   - `docker compose config` succeeds with the updated env contract.

2. **Release workflow still parses and trigger split remains correct**
   - `.github/workflows/release.yml` remains orchestration-only
   - `.github/workflows/release-build.yml` remains tag/manual build workflow
   - new workflow references both image names.

3. **Docker build inputs remain valid**
   - dashboard build still succeeds
   - perplexity-sidecar image build path is valid under the workflow.

4. **Installer matches the new production model**
   - no production-path assumptions remain that require local builds for these internal services.

## Open Decisions Resolved

- **Registry scope:** full registry for project-owned internal services, not all third-party images.
- **Tag model:** one shared release tag (`dashboard-v*`) for both dashboard and perplexity-sidecar.
- **Production compose:** registry-only for these internal services.
- **Installer behavior:** registry-backed deployment path, no normal-case local builds.
- **Local/dev compose:** out of scope; keep existing build-based local workflow.

## Recommended Next Step

Write an implementation plan that covers:

1. compose conversion to image references
2. release-build workflow expansion to two services
3. installer/env alignment
4. verification and regression checks.
