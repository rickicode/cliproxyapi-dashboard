# Production Compose Root and Postgres Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move production to root `docker-compose.yml`, keep `docker-compose.local.yml` local-only, update `install.sh` for production-only Docker installation and DB-mode selection, and migrate production/runtime couplings off `infrastructure/docker-compose.yml`.

**Architecture:** Treat this as a production source-of-truth relocation, not a simple rename. Root `docker-compose.yml` becomes the production stack, `docker-compose.local.yml` remains the local stack, and the installer/runtime/scripts/docs are updated coherently so production can run with either Docker-managed PostgreSQL or external PostgreSQL.

**Tech Stack:** Docker Compose v2, Bash, Next.js API routes, systemd integration, PostgreSQL, YAML

---

## File Map

### Core production/local boundary

**Modify**
- `docker-compose.yml` — convert from current local-style compose to production source of truth.
- `docker-compose.local.yml` — preserve as local-only compose and keep semantics explicit.
- `install.sh` — production-only installer, Docker install flow, DB-mode prompt, root-compose systemd generation.

### Production/runtime coupling migration

**Modify**
- `rebuild.sh` — target root production compose.
- `scripts/backup.sh` — branch/guard behavior for Docker Postgres vs external Postgres.
- `scripts/restore.sh` — branch/guard behavior for Docker Postgres vs external Postgres.
- `dashboard/src/app/api/update/route.ts` — move hardcoded compose path from `infrastructure/docker-compose.yml` to root production compose.
- `dashboard/src/app/api/update/route.test.ts` — update route path expectations.
- `infrastructure/deploy.sh` — remove production working-directory assumption on `infrastructure/` compose.
- `infrastructure/webhook.yaml` — align deploy command/working directory with root production compose.

### Docs / guidance

**Modify**
- `docs/INSTALLATION.md`
- `docs/SERVICE-MANAGEMENT.md`
- `docs/TROUBLESHOOTING.md`
- `docs/RUNBOOK.md`
- `AGENTS.md`

### Optional supporting infra config review

**Inspect/modify only if path assumptions break**
- `infrastructure/config/Caddyfile`
- `infrastructure/scripts/verify-management-auth-url.sh`
- `infrastructure/docker-compose.yml` — likely leave as compatibility stub/deprecation note or remove from active production guidance only if safe.

---

### Task 1: Convert root `docker-compose.yml` into the production source of truth

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.local.yml`

- [ ] **Step 1: Write the failing compose-boundary checks**

Add/prepare a shell verification checklist in your notes for these expectations:

```bash
docker compose -f docker-compose.yml config --services
docker compose -f docker-compose.local.yml config --services
```

Expected failure/red criteria before edits:
- root `docker-compose.yml` still looks local-style rather than production-style
- local and root compose still overlap semantically instead of having a clear boundary

- [ ] **Step 2: Inspect the current production stack definition before editing**

Read and compare these files before changing anything:

```bash
python3 - <<'PY'
from pathlib import Path
for path in [
    'docker-compose.yml',
    'docker-compose.local.yml',
    'infrastructure/docker-compose.yml',
]:
    print(f'=== {path} ===')
    print(Path(path).read_text()[:4000])
PY
```

Expected: confirm production services/features that must move into root compose, especially `caddy`, `dashboard`, `cliproxyapi`, `postgres`, `docker-proxy`, and optional `perplexity`.

- [ ] **Step 3: Rewrite root `docker-compose.yml` as production compose**

Make root `docker-compose.yml` production-oriented. At minimum ensure:

```yaml
services:
  caddy:
    # production reverse proxy

  dashboard:
    # production dashboard service

  cliproxyapi:
    restart: unless-stopped

  docker-proxy:
    # constrained socket proxy

  postgres:
    # active only for Docker Postgres mode

volumes:
  postgres_data:
```

Implementation expectations:
- move/adapt production service definitions from `infrastructure/docker-compose.yml`
- fix relative paths now that compose file lives at repo root
- keep production persistence semantics explicit

- [ ] **Step 4: Keep `docker-compose.local.yml` explicitly local-only**

Ensure its header/comments make the boundary obvious, for example:

```yaml
# Local development stack only.
# Used by setup-local.sh / setup-local.ps1.
# Production uses root docker-compose.yml.
```

Do not silently turn local compose into a production fallback.

- [ ] **Step 5: Run compose validation to verify the boundary works**

Run:

```bash
docker compose -f docker-compose.yml config >/tmp/prod-compose.txt
docker compose -f docker-compose.local.yml config >/tmp/local-compose.txt
docker compose -f docker-compose.yml config --services
docker compose -f docker-compose.local.yml config --services
```

Expected:
- commands exit successfully
- root compose renders as production stack
- local compose still renders as local stack

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.local.yml
git commit -m "feat(infra): split production and local compose roles"
```

### Task 2: Add production DB-mode selection to `install.sh`

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Write the failing installer verification checklist**

Define the target verification commands up front:

```bash
bash -n install.sh
grep -n "get.docker.com\|docker compose\|DATABASE_URL\|postgres" install.sh
```

Expected red criteria before edits:
- installer still uses apt-repo Docker install path only
- installer does not ask for DB mode
- generated startup still assumes `infrastructure/` compose path

- [ ] **Step 2: Replace fresh Docker install flow with `get.docker.com` path**

Implement a production installer flow shaped like:

```bash
if ! command -v docker >/dev/null 2>&1; then
  curl -sSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  # fail fast or install compose support explicitly
  exit 1
fi
```

Keep existing safety checks where appropriate, but make this the primary fresh-install path.

- [ ] **Step 3: Add PostgreSQL mode prompt and config generation**

Implement explicit installer branching such as:

```bash
echo "Choose production database mode:"
echo "1) Docker Postgres"
echo "2) External/custom Postgres"
read -r DB_MODE_CHOICE

case "$DB_MODE_CHOICE" in
  1)
    DB_MODE="docker"
    # generate docker-postgres env values
    ;;
  2)
    DB_MODE="external"
    # prompt for DATABASE_URL or connection parts
    ;;
  *)
    echo "Invalid database mode"
    exit 1
    ;;
esac
```

Requirements:
- Docker mode generates safe local DB secrets/env
- external mode requires complete DB configuration before continuing

- [ ] **Step 4: Update systemd generation to use root production compose**

The generated unit should now point at the repo/install root rather than `infrastructure/`, for example:

```ini
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose up -d --wait
ExecStop=/usr/bin/docker compose down
```

Adjust external-proxy/profile-aware logic only as needed to keep behavior coherent.

- [ ] **Step 5: Run installer syntax verification**

Run:

```bash
bash -n install.sh
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add install.sh
git commit -m "feat(installer): add production database mode selection"
```

### Task 3: Migrate runtime and operational path couplings to root production compose

**Files:**
- Modify: `rebuild.sh`
- Modify: `scripts/backup.sh`
- Modify: `scripts/restore.sh`
- Modify: `dashboard/src/app/api/update/route.ts`
- Modify: `dashboard/src/app/api/update/route.test.ts`
- Modify: `infrastructure/deploy.sh`
- Modify: `infrastructure/webhook.yaml`

- [ ] **Step 1: Write/update failing tests for the hardcoded production compose path**

Update the existing route test to fail on the old path and expect the new one:

```ts
expect(execFileMock).toHaveBeenCalledWith(
  "docker",
  ["compose", "-f", "/opt/cliproxyapi/docker-compose.yml", "up", "-d", "--no-deps", "--force-recreate", "cliproxyapi"],
  expect.any(Function),
);
```

- [ ] **Step 2: Run the route test to verify it fails on old assumptions**

Run:

```bash
cd dashboard && npm test -- src/app/api/update/route.test.ts
```

Expected: FAIL until the route path is updated.

- [ ] **Step 3: Update runtime/script path assumptions**

Make the following classes of change:

```bash
# examples of target direction, not literal replacement command
/opt/cliproxyapi/infrastructure/docker-compose.yml
-> /opt/cliproxyapi/docker-compose.yml

cd infrastructure
-> cd <repo-root>
```

Specific expectations:
- `dashboard/src/app/api/update/route.ts` uses root production compose path
- `rebuild.sh` runs from repo root production compose
- backup/restore scripts stop assuming production compose lives in `infrastructure/`
- `infrastructure/deploy.sh` / `infrastructure/webhook.yaml` align with root production compose usage

- [ ] **Step 4: Add honest DB-mode behavior to backup/restore scripts**

At minimum, ensure Docker-Postgres vs external-Postgres is explicit:

```bash
if [ "${DB_MODE:-docker}" = "external" ]; then
  echo "External PostgreSQL mode: database backup/restore must be handled externally."
  exit 1
fi
```

Do not pretend these scripts can manage external DB state the same way.

- [ ] **Step 5: Run script and route verification**

Run:

```bash
cd dashboard && npm test -- src/app/api/update/route.test.ts
cd .. && bash -n rebuild.sh && bash -n scripts/backup.sh && bash -n scripts/restore.sh && bash -n infrastructure/deploy.sh
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add rebuild.sh scripts/backup.sh scripts/restore.sh dashboard/src/app/api/update/route.ts dashboard/src/app/api/update/route.test.ts infrastructure/deploy.sh infrastructure/webhook.yaml
git commit -m "refactor(infra): move production compose runtime to repo root"
```

### Task 4: Update production/local operational docs and repo guidance

**Files:**
- Modify: `docs/INSTALLATION.md`
- Modify: `docs/SERVICE-MANAGEMENT.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write a failing docs-consistency checklist**

Search for stale production guidance first:

```bash
rg "infrastructure/docker-compose\.yml|cd infrastructure|docker-compose.local\.yml" docs AGENTS.md install.sh rebuild.sh scripts dashboard/src/app/api/update/route.ts
```

Expected red criteria:
- production docs still point operators to `infrastructure/docker-compose.yml`
- docs fail to distinguish local vs production compose clearly

- [ ] **Step 2: Update installation and service-management docs**

Make the docs explicitly state:

```md
- Production uses root `docker-compose.yml`
- Local development uses `docker-compose.local.yml`
- `install.sh` is production-only
- Production can use Docker PostgreSQL or external PostgreSQL
```

Also document that `rebuild.sh` rebuilds the local dashboard checkout and does not automatically rebuild optional buildable services unless you explicitly add that behavior later.

- [ ] **Step 3: Update troubleshooting and runbook docs**

Ensure they distinguish:
- Docker-Postgres vs external-Postgres operational expectations
- production vs local compose usage
- destructive vs non-destructive operations

- [ ] **Step 4: Update `AGENTS.md` repo guidance**

Make architecture/source-of-truth guidance consistent with the new boundary.

- [ ] **Step 5: Run stale-reference verification**

Run:

```bash
rg "infrastructure/docker-compose\.yml|cd infrastructure" docs AGENTS.md install.sh rebuild.sh scripts dashboard/src/app/api/update/route.ts dashboard/src/app/api/update/route.test.ts
```

Expected:
- only intentional/deprecation references remain, if any

- [ ] **Step 6: Commit**

```bash
git add docs/INSTALLATION.md docs/SERVICE-MANAGEMENT.md docs/TROUBLESHOOTING.md docs/RUNBOOK.md AGENTS.md
git commit -m "docs(infra): document production compose and postgres modes"
```

### Task 5: Final production/local boundary verification

**Files:**
- Verify all files changed in Tasks 1–4

- [ ] **Step 1: Run full boundary verification commands**

Run:

```bash
docker compose -f docker-compose.yml config
docker compose -f docker-compose.local.yml config
```

Expected: PASS

- [ ] **Step 2: Run script syntax checks**

Run:

```bash
bash -n install.sh
bash -n rebuild.sh
bash -n scripts/backup.sh
bash -n scripts/restore.sh
bash -n infrastructure/deploy.sh
```

Expected: PASS

- [ ] **Step 3: Run route tests and typecheck**

Run:

```bash
cd dashboard && npm test -- src/app/api/update/route.test.ts && npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Re-check spec coverage**

Checklist:
- production source of truth is root `docker-compose.yml`
- `docker-compose.local.yml` remains local-only
- `install.sh` is production-only and uses `get.docker.com`
- installer prompts for Docker Postgres vs external Postgres
- production/runtime couplings no longer assume `infrastructure/docker-compose.yml`
- Docker-Postgres and external-Postgres modes are both documented honestly
- backup/restore behavior does not misrepresent external DB support

- [ ] **Step 5: Commit any final verification-only adjustments if needed**

```bash
git add docker-compose.yml docker-compose.local.yml install.sh rebuild.sh scripts/backup.sh scripts/restore.sh dashboard/src/app/api/update/route.ts dashboard/src/app/api/update/route.test.ts infrastructure/deploy.sh infrastructure/webhook.yaml docs/INSTALLATION.md docs/SERVICE-MANAGEMENT.md docs/TROUBLESHOOTING.md docs/RUNBOOK.md AGENTS.md
git commit -m "test(infra): finalize production compose migration verification"
```
