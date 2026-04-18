# Production Compose Root + Postgres Mode Design

## Summary

This design moves the production Docker Compose source of truth from `infrastructure/docker-compose.yml` to the repository root `docker-compose.yml`, keeps `docker-compose.local.yml` dedicated to local development, and updates `install.sh` to operate as a production-only installer that installs Docker via `get.docker.com`, ensures Docker Compose is available, and asks the operator whether production should use Docker-managed PostgreSQL or an external/custom PostgreSQL instance.

The work is intentionally scoped as a production compose/layout migration plus installer/runtime clarification. It does not redesign the entire deployment model, remove all `infrastructure/` assets, or introduce a new orchestrator.

## Goals

1. Make root `docker-compose.yml` the **production** compose file.
2. Keep `docker-compose.local.yml` as the **local development** compose file used by `setup-local.sh` / `setup-local.ps1`.
3. Make `install.sh` production-only and update it to:
   - install Docker via `curl -sSL https://get.docker.com | sh`
   - ensure `docker compose` is available
   - ask the operator whether to use Docker PostgreSQL or external/custom PostgreSQL
   - generate production configuration consistent with that choice
4. Improve PostgreSQL production handling so the default Docker-managed path is less fragile operationally and destructive flows are more explicit.
5. Migrate production/runtime couplings that currently hardcode `infrastructure/docker-compose.yml` so they point to the new root production compose source of truth.

## Non-goals

1. Do not turn `setup-local.sh` into a production installer.
2. Do not remove all files from `infrastructure/`; config/supporting assets may remain there if still useful.
3. Do not build HA/failover PostgreSQL.
4. Do not implement automatic migration between Docker-managed PostgreSQL and external PostgreSQL.
5. Do not redesign the GHCR/dashboard release pipeline in this work.
6. Do not remove all host-level operational helpers if they are still part of the intended production path.

## Current State

### Compose layout today

- `infrastructure/docker-compose.yml` is the current production compose file and is referenced by install/runtime/docs/scripts.
- `docker-compose.local.yml` is the current local full-stack compose file used by local bootstrap scripts.
- root `docker-compose.yml` currently behaves like another local-style stack, not the production source of truth.

### Production-path couplings today

The following currently assume production compose lives under `infrastructure/`:

- `install.sh` systemd working directory and startup commands
- `rebuild.sh`
- `scripts/backup.sh`
- `scripts/restore.sh`
- `dashboard/src/app/api/update/route.ts`
- `dashboard/src/app/api/update/route.test.ts`
- `infrastructure/deploy.sh`
- `infrastructure/webhook.yaml`
- operational docs and repo guidance (`docs/INSTALLATION.md`, `docs/SERVICE-MANAGEMENT.md`, `docs/TROUBLESHOOTING.md`, `AGENTS.md`)

### PostgreSQL today

- Production and local compose both use Docker-managed PostgreSQL with a named volume `postgres_data`.
- This is resilient to ordinary `docker compose down`, but still destructible via `docker compose down -v`.
- There is currently no installer-level production choice between Docker PostgreSQL and an external/custom PostgreSQL server.

### Docker installation today

- `install.sh` currently uses apt-repository setup and installs `docker-ce`, `docker-compose-plugin`, and related packages.
- The requested design changes that fresh-install path to the simpler `get.docker.com` installer path, while still ensuring `docker compose` works afterward.

## Architecture and File Boundaries

### 1. Production compose boundary

#### `docker-compose.yml`
- Becomes the single production compose source of truth.
- Contains the production stack currently defined in `infrastructure/docker-compose.yml`, adapted as needed for the new root location.
- Must support both production database modes:
  - Docker-managed PostgreSQL
  - external/custom PostgreSQL

#### `docker-compose.local.yml`
- Remains local-development-only.
- Continues to be the compose file used by `setup-local.sh` and `setup-local.ps1`.
- Must not become a fallback production file.

### 2. Installer boundary

#### `install.sh`
- Is production-only.
- Installs Docker via `curl -sSL https://get.docker.com | sh`.
- Verifies/ensures `docker compose` availability.
- Prompts the operator for the production PostgreSQL mode.
- Generates production env/config accordingly.
- Starts production from root `docker-compose.yml`, not `infrastructure/docker-compose.yml`.
- Updates generated systemd/runtime paths to the new root compose location.

### 3. Runtime coupling migration

The following must be updated to the new production compose location assumption:

- `dashboard/src/app/api/update/route.ts`
- `dashboard/src/app/api/update/route.test.ts`
- `rebuild.sh`
- `scripts/backup.sh`
- `scripts/restore.sh`
- `infrastructure/deploy.sh`
- `infrastructure/webhook.yaml`
- production-focused docs and repository guidance

### 4. Supporting infrastructure directory

The `infrastructure/` directory may continue to hold supporting production assets such as:

- config templates
- Caddy config
- deploy/webhook support files

But it is no longer the place where operators or runtime code should assume the production compose file lives.

## PostgreSQL Production Modes

### Mode A — Docker-managed PostgreSQL

If the operator chooses Docker PostgreSQL:

- production compose runs the `postgres` service
- service-to-database wiring uses internal compose networking
- data persists in a dedicated production volume
- ordinary `docker compose down` must remain non-destructive
- destructive actions must remain explicit and clearly documented

This is the default/easiest production path for self-hosted setups.

#### Safety expectations

- volume-backed persistence remains the default
- `down -v` is explicitly documented as destructive
- install/rebuild/docs should avoid normalizing destructive reset flows for production
- backup/restore scripts remain meaningful for this mode

### Mode B — External/custom PostgreSQL

If the operator chooses external/custom PostgreSQL:

- production compose does **not** require the `postgres` service to run
- installer collects the required external database connection settings
- production env is generated to point application services at that external DB
- docs/scripts must not imply that this stack manages lifecycle or backup of the external database

#### External DB input model

The implementation may use either:

- a prompted `DATABASE_URL`, or
- prompted host/port/database/user/password that are assembled into `DATABASE_URL`

Either approach is acceptable as long as:

- the install flow is clear
- validation is explicit
- the resulting production env is deterministic

## Install and Runtime Flow

### Production install flow target

1. Install Docker with `get.docker.com`
2. Confirm `docker` and `docker compose` are usable
3. Prompt for PostgreSQL mode:
   - Docker PostgreSQL
   - external/custom PostgreSQL
4. Generate production env/config from that choice
5. Start the production stack from root `docker-compose.yml`
6. Configure boot-time startup against the root production compose path

### Runtime behavior target

- Production maintenance/update flows must assume root `docker-compose.yml`
- Local flows must assume `docker-compose.local.yml`
- Runtime code must no longer hardcode `/opt/cliproxyapi/infrastructure/docker-compose.yml`
- Backup/restore/rebuild/deploy tooling must be honest about whether they are operating on:
  - Docker-managed PostgreSQL
  - only application containers while DB is external

## Migration Strategy

This should be treated as a **production source-of-truth relocation**, not just a file rename.

### Production compose migration

- move/adapt the effective production stack definition into root `docker-compose.yml`
- preserve the local role of `docker-compose.local.yml`
- update scripts/runtime/tests/docs that still point to `infrastructure/docker-compose.yml`

### Existing production installs

For existing installs using Docker PostgreSQL:

- migration should preserve the Docker-managed PostgreSQL default behavior unless the operator explicitly chooses otherwise
- no forced DB-mode migration should occur automatically

For future/new installs:

- installer asks which DB mode to use
- generated env/config matches the chosen mode from the beginning

## Error Handling and Guardrails

### Installer errors

- If Docker install via `get.docker.com` fails: stop immediately with a clear message.
- If `docker compose` is unavailable after install: fail fast.
- If external PostgreSQL mode is selected but required connection data is incomplete: do not continue.
- If Docker PostgreSQL mode is selected: generate secrets/env values explicitly and visibly enough for operator recovery.

### Operational guardrails

- Production guidance must stop normalizing `down -v` as an ordinary maintenance action.
- For external PostgreSQL mode, backup/restore scripts and docs must not pretend they can manage DB backups the same way as Docker-managed mode.
- Rebuild/update/install flows must not silently keep referring to `infrastructure/docker-compose.yml`.

## Verification Criteria

The work should only be considered complete if the following are true:

### Compose and installer
- root `docker-compose.yml` validates as the production compose file
- `docker-compose.local.yml` still validates for local development
- `install.sh` syntax is valid
- `install.sh` and generated startup paths refer to root production compose, not `infrastructure/docker-compose.yml`

### Local vs production boundary
- `setup-local.sh` and `setup-local.ps1` still use `docker-compose.local.yml`
- no production script depends on `docker-compose.local.yml`
- documentation clearly distinguishes local vs production compose usage

### PostgreSQL modes
- Docker PostgreSQL mode runs with persistent storage and explicit destructive warnings
- external PostgreSQL mode works without requiring the local `postgres` service
- Docker-mode backup/restore remains supported
- external-mode docs/scripts clearly state DB backup is external responsibility

### Coupling migration
- production/runtime hardcoded path assumptions are updated in:
  - update route
  - route tests
  - rebuild script
  - backup/restore scripts
  - deploy/webhook tooling
  - production docs / repo guidance

## Testing Strategy

The implementation plan should include verification for:

- compose config validation for:
  - root production compose
  - `docker-compose.local.yml`
- `install.sh` syntax and path generation behavior
- route/runtime tests affected by production compose path migration
- script readback/behavior verification for rebuild/backup/restore/deploy paths
- doc consistency checks across production/local instructions

## Risks and Trade-offs

1. **Path migration risk**
   - Many files currently assume `infrastructure/docker-compose.yml`.
   - Missing even one of them can create broken production/runtime behavior.

2. **Operational confusion risk during transition**
   - Root `docker-compose.yml` already exists and is currently local-style.
   - The migration must be coordinated so operators do not end up using stale semantics.

3. **External PostgreSQL support complexity**
   - Supporting both modes increases installer/script/doc branching.
   - This is acceptable because the user explicitly requested both.

4. **Backup/restore asymmetry**
   - Docker-managed PostgreSQL and external PostgreSQL cannot honestly share the same backup story.
   - The design chooses explicit divergence rather than pretending they are equivalent.

## Final Scope Statement

This work is a coordinated production compose migration and installer/runtime clarification. It gives production a root `docker-compose.yml`, preserves `docker-compose.local.yml` for local dev, makes `install.sh` production-only with explicit PostgreSQL mode selection, and updates production/runtime couplings accordingly.
