# Install.sh Docker-Managed Cloudflare Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cloudflare Tunnel from host-installed `cloudflared` into the production Docker Compose stack while keeping the runtime-bundle installer flow, token-only tunnel mode, Dashboard+API exposure, and host ports `8317/8318` available.

**Architecture:** The production runtime remains rooted at `/opt/cliproxyapi` and continues to use one source-of-truth `docker-compose.yml`. Domain mode still uses the `caddy` profile, local mode uses no edge service, and Cloudflare mode switches to a new `cloudflare` Compose profile that starts a `cloudflared` container configured from installer-generated env values instead of a host package/systemd service.

**Tech Stack:** Bash installer, Docker Compose v2, Cloudflare Tunnel (`cloudflared` container), Next.js/React docs, Vitest verification.

---

## File Map

- Modify: `install.sh`
  - Remove host-level `cloudflared` install/service logic.
  - Generate Cloudflare Compose env/profile values.
  - Update validation, final output, and installer entrypoint messaging.
- Modify: `docker-compose.yml`
  - Add `cloudflared` service under `profiles: ["cloudflare"]`.
  - Keep domain/local behavior unchanged.
- Modify: `README.md`
  - Make curl-pipe installer path the primary documented entrypoint.
  - Update Cloudflare wording to Compose-managed tunnel.
- Modify: `docs/INSTALLATION.md`
  - Replace host-service Cloudflare setup with Compose-managed flow.
- Modify: `docs/CONFIGURATION.md`
  - Document Cloudflare env and `COMPOSE_PROFILES=cloudflare`.
- Modify: `docs/SERVICE-MANAGEMENT.md`
  - Replace `systemctl cloudflared` instructions with Compose commands.
- Modify: `docs/RUNBOOK.md`
  - Update troubleshooting and operator actions for Compose-managed tunnel.
- Modify if needed: `docs/TROUBLESHOOTING.md`
  - Remove any stale host-level Cloudflare instructions.
- Re-verify: `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts`
  - This file is already modified in the branch and must still pass after the installer/compose changes.

## Implementation Notes

- Do not reintroduce host-level `cloudflared` install logic.
- Keep Cloudflare mode token-only; do not add full tunnel YAML generation unless strictly required by the official container invocation.
- Keep host ports `8317/8318` open in Cloudflare mode.
- Keep domain mode using bundled Caddy and local mode without Caddy/Cloudflare.
- Do not create commits unless explicitly requested by the user.

### Task 1: Add Compose-native `cloudflared` service

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Write the failing config check expectation in notes**

Record the expected Cloudflare-mode shape before editing:

```yaml
cloudflared:
  profiles: ["cloudflare"]
  image: <official-cloudflared-image>
  environment:
    TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?Set CLOUDFLARE_TUNNEL_TOKEN for Cloudflare mode}
```

Expected initial state: `docker-compose.yml` does not contain a `cloudflared` service, so this design requirement is unmet.

- [ ] **Step 2: Verify current compose lacks Cloudflare service**

Run:

```bash
grep -n "cloudflared:" docker-compose.yml
```

Expected: no matches.

- [ ] **Step 3: Add the minimal `cloudflared` service**

Implement a Compose service with these characteristics:

```yaml
  cloudflared:
    profiles: ["cloudflare"]
    image: cloudflare/cloudflared:latest
    container_name: cliproxyapi-cloudflared
    restart: unless-stopped
    cpus: 0.5
    mem_limit: 128m
    mem_reservation: 32m
    networks:
      - frontend
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?Set CLOUDFLARE_TUNNEL_TOKEN for Cloudflare mode}
    command:
      - tunnel
      - --no-autoupdate
      - run
    depends_on:
      cliproxyapi:
        condition: service_healthy
      dashboard:
        condition: service_healthy
```

Keep these constraints:

- no host port publishing for `cloudflared`
- same `frontend` network as `dashboard` and `cliproxyapi`
- do not alter `caddy` profile behavior
- do not remove host port bindings from `dashboard` or `cliproxyapi`

- [ ] **Step 4: Add concise compose comments for mode behavior**

Add/update comments near the service/profile section to make the mode contract explicit:

```yaml
  # Cloudflare Tunnel — only starts when COMPOSE_PROFILES includes "cloudflare"
  # It tunnels to internal Compose service names while dashboard/API remain host-exposed.
```

- [ ] **Step 5: Run compose config to verify structure**

Run:

```bash
env \
  MANAGEMENT_API_KEY=dummy \
  COLLECTOR_API_KEY=dummy \
  JWT_SECRET=dummy \
  DATABASE_URL=postgresql://user:pass@localhost:5432/db \
  PROVIDER_ENCRYPTION_KEY=dummy \
  CLOUDFLARE_TUNNEL_TOKEN=dummy-token \
  COMPOSE_PROFILES=cloudflare \
  docker compose -f docker-compose.yml config >/tmp/cloudflare-compose.yaml
python3 -c "from pathlib import Path; p=Path('/tmp/cloudflare-compose.yaml'); print('ok' if p.exists() and p.stat().st_size > 0 else 'empty')"
```

Expected: `ok`.

### Task 2: Remove host-level Cloudflare install/service logic from installer

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Write the failing behavioral checklist**

The installer must no longer contain these active host-level paths:

```bash
install_cloudflared_package
install_cloudflared_service
apt-get install -y cloudflared
systemctl enable cloudflared.service
systemctl restart cloudflared.service
```

Expected initial state: these strings/functions are present in `install.sh`.

- [ ] **Step 2: Verify the stale host-level logic exists before removing it**

Run:

```bash
grep -nE "install_cloudflared_package|install_cloudflared_service|cloudflared\.service|apt-get install -y cloudflared" install.sh
```

Expected: multiple matches.

- [ ] **Step 3: Remove host-level Cloudflare helpers and call sites**

Delete or rewrite the sections that currently do this work:

```bash
install_cloudflared_package() { ... }
install_cloudflared_service() { ... }
```

Also remove their invocation points, including any preflight or post-stack systemd hooks.

- [ ] **Step 4: Keep Cloudflare mode prompt and write env-only contract**

Ensure the Cloudflare access-mode path still does this:

```bash
if [ "$ACCESS_MODE" = "cloudflare" ]; then
  read -r -p "Enter Cloudflare Tunnel token: " CLOUDFLARE_TUNNEL_TOKEN
fi
```

And in `.env` generation, ensure this remains/writes cleanly:

```bash
write_env_assignment "$ENV_FILE" "CLOUDFLARE_TUNNEL_TOKEN" "$CLOUDFLARE_TUNNEL_TOKEN"
write_env_assignment "$ENV_FILE" "COMPOSE_PROFILES" "cloudflare"
```

Cloudflare mode must not set `COMPOSE_PROFILES=caddy`.

- [ ] **Step 5: Update Cloudflare-mode validation and final summary**

Replace host-service validation wording with Compose-oriented wording such as:

```bash
log_info "Cloudflare Tunnel runs as a Docker Compose service in cloudflare mode"
```

And update final output to mention:

- tunnel is Compose-managed
- hostnames are still configured in Cloudflare dashboard
- local URLs remain available via `http://LOCAL_IP:8318` and `http://LOCAL_IP:8317`

- [ ] **Step 6: Strengthen `.env` reuse reconciliation**

When keeping an existing `.env`, reconcile at minimum these keys so profile drift does not survive mode changes:

```bash
ACCESS_MODE
COMPOSE_PROFILES
CLIPROXYAPI_BIND_ADDRESS
DASHBOARD_BIND_ADDRESS
CLOUDFLARE_TUNNEL_TOKEN
```

Do not only reconcile `DB_MODE`.

- [ ] **Step 7: Run installer syntax verification**

Run:

```bash
bash -n install.sh
```

Expected: no output.

### Task 3: Update installer entrypoint documentation and Cloudflare runtime docs

**Files:**
- Modify: `README.md`
- Modify: `docs/INSTALLATION.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/SERVICE-MANAGEMENT.md`
- Modify: `docs/RUNBOOK.md`
- Modify if needed: `docs/TROUBLESHOOTING.md`

- [ ] **Step 1: Write the failing documentation checklist**

Docs currently describe Cloudflare mode as host-installed/service-managed and do not yet make the curl-pipe installer path the primary default.

Must change to:

```md
curl -fsSL <installer-url> | sudo bash
```

and Cloudflare wording must consistently describe Compose-managed `cloudflared`.

- [ ] **Step 2: Verify stale Cloudflare doc references before editing**

Run:

```bash
grep -nE "systemctl status cloudflared|cloudflared\.service|apt-get install cloudflared" README.md docs/INSTALLATION.md docs/CONFIGURATION.md docs/SERVICE-MANAGEMENT.md docs/RUNBOOK.md docs/TROUBLESHOOTING.md
```

Expected: matches in one or more files.

- [ ] **Step 3: Make the curl-pipe path the primary install invocation**

In `README.md` and `docs/INSTALLATION.md`, update the primary example to:

```bash
curl -fsSL <installer-url> | sudo bash
```

Also include a short note that the installer still fetches the runtime bundle into `/opt/cliproxyapi`.

- [ ] **Step 4: Rewrite Cloudflare mode docs around Compose**

Update the docs so Cloudflare mode consistently says:

```md
Cloudflare Tunnel runs as a Docker Compose service (`cloudflared`) in the production stack.
```

And service-management examples become:

```bash
cd /opt/cliproxyapi
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs cloudflared
docker compose --env-file .env -f docker-compose.yml restart cloudflared
```

- [ ] **Step 5: Keep host-port behavior explicit in Cloudflare mode docs**

Ensure the updated docs state both of these are true:

- Cloudflare hostnames terminate through the `cloudflared` Compose service
- local host/IP access via `8318` and `8317` remains available

- [ ] **Step 6: Re-run stale-doc grep after edits**

Run:

```bash
grep -nE "systemctl status cloudflared|cloudflared\.service|apt-get install cloudflared" README.md docs/INSTALLATION.md docs/CONFIGURATION.md docs/SERVICE-MANAGEMENT.md docs/RUNBOOK.md docs/TROUBLESHOOTING.md
```

Expected: no matches in the updated runtime-facing docs.

### Task 4: Re-verify dashboard tests and installer/compose contract together

**Files:**
- Re-verify: `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts`
- Re-verify: `install.sh`
- Re-verify: `docker-compose.yml`

- [ ] **Step 1: Re-run the targeted oauth-listing test**

Run:

```bash
npm test --prefix dashboard -- src/lib/providers/__tests__/oauth-listing.test.ts
```

Expected: PASS, 8/8 tests.

- [ ] **Step 2: Re-run the full dashboard test suite**

Run:

```bash
npm test --prefix dashboard
```

Expected: full suite passes.

- [ ] **Step 3: Re-run shell and compose verification as final evidence**

Run:

```bash
bash -n install.sh && \
env \
  MANAGEMENT_API_KEY=dummy \
  COLLECTOR_API_KEY=dummy \
  JWT_SECRET=dummy \
  DATABASE_URL=postgresql://user:pass@localhost:5432/db \
  PROVIDER_ENCRYPTION_KEY=dummy \
  CLOUDFLARE_TUNNEL_TOKEN=dummy-token \
  COMPOSE_PROFILES=cloudflare \
  docker compose -f docker-compose.yml config >/tmp/cloudflare-compose-final.yaml && \
python3 -c "from pathlib import Path; p=Path('/tmp/cloudflare-compose-final.yaml'); print('ok' if p.exists() and p.stat().st_size > 0 else 'empty')"
```

Expected: `ok`.

- [ ] **Step 4: Inspect final git status**

Run:

```bash
git status --short
```

Expected: only the intended installer/compose/docs/test files appear modified.

## Self-Review Checklist

- Spec coverage:
  - Docker-only Cloudflare runtime path: Task 1 + Task 2
  - Token-only remote-managed mode: Task 1 + Task 2
  - Dashboard+API exposure through tunnel: Task 1
  - Host ports remain open: Task 1 + Task 3
  - Curl-first installer docs: Task 3
  - Verification evidence: Task 4
- Placeholder scan:
  - No `TODO`, `TBD`, or deferred “implement later” steps remain.
- Type/contract consistency:
  - Uses `COMPOSE_PROFILES=cloudflare` consistently.
  - Uses `CLOUDFLARE_TUNNEL_TOKEN` consistently.
  - Keeps access modes as `domain|cloudflare|local` consistently.
