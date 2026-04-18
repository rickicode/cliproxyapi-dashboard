# Dashboard Port 8318 Migration Design

## Summary

Migrate the dashboard from port `3000` to port `8318` everywhere it operates: host access, internal container runtime, service-to-service routing, health checks, installer defaults, cron targets, fallback URL construction, and operational documentation. After this change, `8318` becomes the only dashboard port used by default.

## Goal

Remove `3000` as the dashboard port and make `8318` the canonical dashboard port across the repository and runtime environment.

## Non-Goals

- Changing non-dashboard service ports
- Refactoring unrelated infrastructure behavior
- Introducing backward-compatibility aliases for `3000`

## Current State

The repository is partially migrated already:

- local/dev UX, docs, and some scripts already point to `8318`
- several important runtime and deployment paths still assume `3000`
- internal dashboard runtime still listens on `3000`
- some service-to-service calls still use `dashboard:3000`
- some host-facing installer flows still expose `localhost:3000`

This mixed state causes inconsistent behavior and makes the dashboard port depend on which path is used.

## Desired End State

After migration:

- Next.js dashboard runtime listens on `8318`
- Docker image exposes `8318`
- Docker Compose mappings expose `8318`
- internal service references use `dashboard:8318`
- reverse proxies target `dashboard:8318` or `localhost:8318` as appropriate
- health checks use `8318`
- installer-generated config and cron jobs target `8318`
- runtime URL fallbacks no longer assume `3000`
- docs and operational output consistently refer to `8318`

## Approach Options

### Option A — Host-only migration
Keep internal container port at `3000` and only expose `8318` to users.

**Rejected** because the requested behavior is a full migration and this would preserve `3000` internally.

### Option B — Full port migration
Move both host-facing and internal dashboard runtime references from `3000` to `8318`.

**Selected** because it matches the requested outcome and eliminates split-port ambiguity.

### Option C — Dual-port compatibility period
Keep `3000` working temporarily while introducing `8318`.

**Rejected** because it increases complexity and preserves the ambiguity the migration is meant to remove.

## Design

### 1. Application runtime

Update the dashboard application runtime so its canonical listen port is `8318`.

Targets include:

- `dashboard/Dockerfile`
- any app runtime defaults that currently fall back to `3000`

Expected result:

- `PORT=8318`
- `EXPOSE 8318`
- in-container health probes target `http://localhost:8318`

### 2. Compose and service networking

Update all Compose definitions so dashboard networking consistently uses `8318`.

Targets include:

- root `docker-compose.yml`
- `docker-compose.local.yml`
- `infrastructure/docker-compose.yml`

Expected result:

- host mappings use `8318:8318` where the dashboard is published directly
- service-to-service dashboard references become `dashboard:8318`
- env values such as `DASHBOARD_URL` use port `8318` when they refer to the dashboard service or host URL

### 3. Reverse proxy and health checks

Update every dashboard-specific proxy target and health check to the new internal port.

Targets include:

- `infrastructure/config/Caddyfile`
- Compose health checks
- any local or installer-generated proxy snippets

Expected result:

- internal reverse proxy targets move from `dashboard:3000` to `dashboard:8318`
- host-local reverse proxy targets move from `localhost:3000` to `localhost:8318`
- health checks use `8318`

### 4. Installer and cron behavior

Update installation and operational automation so the installed system targets the dashboard on `8318`.

Targets include:

- `install.sh`
- generated override fragments
- usage collector target URL
- printed operator instructions

Expected result:

- external-proxy/local loopback references use `8318`
- collector calls target the dashboard on `8318`
- installation output no longer mentions dashboard `3000`

### 5. Runtime fallback URLs

Update server-side fallback URL construction that still derives dashboard URLs from port `3000`.

Known targets include:

- `dashboard/src/instrumentation-node.ts`
- `dashboard/src/app/api/quota/check-alerts/route.ts`

Expected result:

- fallback port assumptions move to `8318`
- `DASHBOARD_URL` and related URL assembly remain internally consistent

### 6. Documentation

Update docs that still describe `3000` as the dashboard port.

Targets include any remaining architecture, installation, or operator-facing references that are still dashboard-specific and runtime-relevant.

Expected result:

- documentation consistently states the dashboard runs on `8318`

## File Categories

### Must change

- `dashboard/Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `infrastructure/docker-compose.yml`
- `infrastructure/config/Caddyfile`
- `install.sh`
- `dashboard/src/instrumentation-node.ts`
- `dashboard/src/app/api/quota/check-alerts/route.ts`
- runtime-relevant docs that still mention dashboard `3000`

### Change only if still present after implementation scan

- any remaining env templates or helper scripts with dashboard-specific `3000` defaults
- any service-specific references to `localhost:3000` or `dashboard:3000` that are actually about the dashboard

### Must not be changed

- non-dashboard ports
- unrelated timeout values or numeric literals containing `3000`
- documentation references that are purely historical unless they are misleading in current usage instructions

## Risks and Mitigations

### Risk: service-to-service breakage
If one internal caller still targets `dashboard:3000`, internal features can fail.

**Mitigation:** do a repo-wide targeted search for dashboard-specific `3000` references and update all runtime-relevant ones in the same change.

### Risk: health checks fail after migration
If the app listens on `8318` but health checks stay on `3000`, containers may flap or remain unhealthy.

**Mitigation:** treat health checks as first-class migration targets and verify them after changes.

### Risk: installer produces broken config
If installer templates or generated overrides still use `3000`, new installs will remain inconsistent.

**Mitigation:** update all installer-generated snippets and operator output in the same patch set.

### Risk: collector and self-fetch paths fail
If usage collector or quota alert paths still call `localhost:3000`, background operations may silently fail.

**Mitigation:** explicitly verify these call sites during implementation and test by inspection plus runtime verification.

## Verification Plan

Before claiming completion, verify:

1. repo search shows no runtime-relevant dashboard references still targeting `3000`
2. dashboard container/runtime listens on `8318`
3. direct dashboard access works on `http://localhost:8318`
4. Compose health checks point to `8318`
5. reverse proxy targets point to `8318`
6. usage collector and quota self-fetch code paths no longer derive dashboard URLs from `3000`
7. docs and installer output reflect `8318`

## Testing Strategy

- static verification by targeted search for dashboard-specific `3000` references
- TypeScript diagnostics on changed code files
- if feasible, start or inspect local stack and confirm dashboard exposure on `8318`
- verify healthcheck/proxy targets by reading resulting configuration

## Acceptance Criteria

The migration is complete when all of the following are true:

- dashboard runtime port is `8318`
- internal references use `8318`
- host-facing defaults use `8318`
- installer-generated behavior uses `8318`
- health checks and reverse proxies use `8318`
- there are no remaining runtime-significant dashboard references to `3000`
- the dashboard remains reachable and operational on `8318`

## Notes

- This design intentionally treats the migration as a repo-wide dashboard port change, not a narrow compose tweak.
- Git commit is intentionally excluded from this step because no explicit commit request has been made.
