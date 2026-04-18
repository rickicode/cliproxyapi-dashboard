# Dashboard Port 8318 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the dashboard from port `3000` to port `8318` across runtime, compose, reverse proxy, installer automation, fallbacks, and docs.

**Architecture:** This is a repo-wide configuration migration, not a feature change. The dashboard process, container networking, service-to-service URLs, health checks, and generated operator instructions must all converge on the same port so no caller or probe still targets `3000`.

**Tech Stack:** Next.js 16, React 19, TypeScript, Docker, Docker Compose, Caddy, Bash installer scripts

---

## File map

### Runtime
- Modify: `dashboard/Dockerfile`
- Modify: `dashboard/src/instrumentation-node.ts`
- Modify: `dashboard/src/app/api/quota/check-alerts/route.ts`

### Compose / infrastructure
- Modify: `docker-compose.yml`
- Modify: `docker-compose.local.yml`
- Modify: `infrastructure/docker-compose.yml`
- Modify: `infrastructure/config/Caddyfile`

### Installer / docs
- Modify: `install.sh`
- Modify: `docs/CODEMAPS/architecture.md`

### Verification
- Run from repo root: `docker compose config`
- Run from repo root: `docker compose -f docker-compose.local.yml config`
- Run from `infrastructure/`: `docker compose config`
- Run from `dashboard/`: `npm run typecheck`
- Run from `dashboard/`: `npm run build`
- Run from repo root: targeted searches confirming no runtime-significant dashboard `3000` references remain

---

### Task 1: Migrate dashboard runtime defaults to 8318

**Files:**
- Modify: `dashboard/Dockerfile`
- Modify: `dashboard/src/instrumentation-node.ts`
- Modify: `dashboard/src/app/api/quota/check-alerts/route.ts`

- [ ] **Step 1: Write the failing checks as shell assertions**

Run from repo root:

```bash
grep -n 'ENV PORT=3000\|EXPOSE 3000\|localhost:3000/api/health' dashboard/Dockerfile
grep -n 'process.env.PORT ?? "3000"' dashboard/src/instrumentation-node.ts
grep -n 'process.env.PORT ?? "3000"' dashboard/src/app/api/quota/check-alerts/route.ts
```

Expected: matches are found in all three files.

- [ ] **Step 2: Update `dashboard/Dockerfile` to use 8318**

Replace the runtime section with:

```Dockerfile
ARG DASHBOARD_VERSION=dev
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8318
ENV COMPOSE_DIR=/opt/cliproxyapi/infrastructure
ENV DASHBOARD_VERSION=${DASHBOARD_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1

...

USER nextjs

EXPOSE 8318
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=40s \
  CMD node -e "fetch('http://localhost:8318/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./entrypoint.sh"]
```

- [ ] **Step 3: Update `dashboard/src/instrumentation-node.ts` fallback port**

Change the fallback block to:

```ts
const port = process.env.PORT ?? "8318";
const baseUrl = process.env.NEXTAUTH_URL ?? process.env.DASHBOARD_URL ?? `http://localhost:${port}`;
```

- [ ] **Step 4: Update `dashboard/src/app/api/quota/check-alerts/route.ts` fallback port**

Change the fallback block to:

```ts
// Use server-side env var for base URL instead of trusting request headers
const port = process.env.PORT ?? "8318";
const baseUrl = process.env.NEXTAUTH_URL ?? process.env.DASHBOARD_URL ?? `http://localhost:${port}`;
```

- [ ] **Step 5: Re-run the shell assertions**

Run:

```bash
grep -n 'ENV PORT=8318\|EXPOSE 8318\|localhost:8318/api/health' dashboard/Dockerfile
grep -n 'process.env.PORT ?? "8318"' dashboard/src/instrumentation-node.ts
grep -n 'process.env.PORT ?? "8318"' dashboard/src/app/api/quota/check-alerts/route.ts
```

Expected: only `8318` matches are found.

- [ ] **Step 6: Commit**

```bash
git add dashboard/Dockerfile dashboard/src/instrumentation-node.ts dashboard/src/app/api/quota/check-alerts/route.ts
git commit -m "refactor: move dashboard runtime port to 8318"
```

---

### Task 2: Migrate compose files and Caddy to 8318

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.local.yml`
- Modify: `infrastructure/docker-compose.yml`
- Modify: `infrastructure/config/Caddyfile`

- [ ] **Step 1: Write the failing checks for compose and proxy references**

Run from repo root:

```bash
grep -n 'dashboard:3000\|127.0.0.1:3000:3000\|localhost:3000/api/health\|DASHBOARD_URL: http://localhost:3000' docker-compose.yml
grep -n 'dashboard:3000\|127.0.0.1:8318:3000\|localhost:3000/api/health' docker-compose.local.yml
grep -n 'dashboard:3000\|localhost:3000/api/health' infrastructure/docker-compose.yml
grep -n 'reverse_proxy dashboard:3000' infrastructure/config/Caddyfile
```

Expected: old `3000` references are found.

- [ ] **Step 2: Update root `docker-compose.yml`**

Change the dashboard/perplexity wiring to:

```yaml
  perplexity-sidecar:
    environment:
      PERPLEXITY_COOKIES: ${PERPLEXITY_COOKIES:-}
      PERPLEXITY_SIDECAR_SECRET: ${PERPLEXITY_SIDECAR_SECRET:-}
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      DASHBOARD_URL: http://dashboard:8318
      PORT: "8766"
      PERPLEXITY_SIDECAR_AUTO_UPDATE: ${PERPLEXITY_SIDECAR_AUTO_UPDATE:-true}
      UPDATE_CHECK_INTERVAL: ${UPDATE_CHECK_INTERVAL:-3600}

  dashboard:
    ports:
      - "127.0.0.1:8318:8318"
    environment:
      DATABASE_URL: postgresql://cliproxyapi:${POSTGRES_PASSWORD}@postgres:5432/cliproxyapi
      CLIPROXYAPI_MANAGEMENT_URL: http://cliproxyapi:8317/v0/management
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
      DOCKER_HOST: tcp://docker-proxy:2375
      DASHBOARD_URL: http://localhost:8318
      API_URL: http://localhost:8317
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8318/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
```

- [ ] **Step 3: Update `docker-compose.local.yml`**

Change the dashboard/perplexity wiring to:

```yaml
  perplexity-sidecar:
    environment:
      PERPLEXITY_COOKIES: ${PERPLEXITY_COOKIES:-}
      PERPLEXITY_SIDECAR_SECRET: ${PERPLEXITY_SIDECAR_SECRET:-}
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      DASHBOARD_URL: http://dashboard:8318
      PORT: "8766"
      PERPLEXITY_SIDECAR_AUTO_UPDATE: ${PERPLEXITY_SIDECAR_AUTO_UPDATE:-true}
      UPDATE_CHECK_INTERVAL: ${UPDATE_CHECK_INTERVAL:-3600}

  dashboard:
    ports:
      - "127.0.0.1:8318:8318"
    environment:
      DATABASE_URL: postgresql://cliproxyapi:${POSTGRES_PASSWORD}@postgres:5432/cliproxyapi
      CLIPROXYAPI_MANAGEMENT_URL: http://cliproxyapi:8317/v0/management
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
      DOCKER_HOST: tcp://docker-proxy:2375
      DASHBOARD_URL: http://localhost:8318
      API_URL: http://localhost:8317
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8318/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
```

- [ ] **Step 4: Update `infrastructure/docker-compose.yml`**

Change the dashboard/perplexity wiring to:

```yaml
  perplexity-sidecar:
    environment:
      PERPLEXITY_COOKIES: ${PERPLEXITY_COOKIES:-}
      PERPLEXITY_SIDECAR_SECRET: ${PERPLEXITY_SIDECAR_SECRET:-}
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      DASHBOARD_URL: http://dashboard:8318
      PORT: "8766"
      PERPLEXITY_SIDECAR_AUTO_UPDATE: ${PERPLEXITY_SIDECAR_AUTO_UPDATE:-true}
      UPDATE_CHECK_INTERVAL: ${UPDATE_CHECK_INTERVAL:-3600}
      TZ: ${TZ}

  dashboard:
    environment:
      DATABASE_URL: postgresql://cliproxyapi:${POSTGRES_PASSWORD}@postgres:5432/cliproxyapi
      CLIPROXYAPI_MANAGEMENT_URL: http://cliproxyapi:8317/v0/management
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      COLLECTOR_API_KEY: ${COLLECTOR_API_KEY:-}
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
      API_URL: ${API_URL}
      DASHBOARD_URL: ${DASHBOARD_URL}
      DOCKER_HOST: tcp://docker-proxy:2375
      GITHUB_REPO: ${GITHUB_REPO:-itsmylife44/cliproxyapi-dashboard}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8318/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
```

Only the `DASHBOARD_URL` value for the sidecar and the dashboard healthcheck change here.

- [ ] **Step 5: Update `infrastructure/config/Caddyfile`**

Replace the dashboard proxy block with:

```caddy
reverse_proxy dashboard:8318 {
	header_up X-Real-IP {remote_host}
	header_up X-Forwarded-For {remote_host}
	header_up X-Forwarded-Proto {scheme}

	health_uri /api/health
	health_interval 30s
	health_timeout 10s
}
```

- [ ] **Step 6: Validate rendered compose configs**

Run:

```bash
docker compose config >/tmp/cliproxyapi-root-compose.out
docker compose -f docker-compose.local.yml config >/tmp/cliproxyapi-local-compose.out
(cd infrastructure && docker compose config) >/tmp/cliproxyapi-infra-compose.out
grep -n '8318' /tmp/cliproxyapi-root-compose.out /tmp/cliproxyapi-local-compose.out /tmp/cliproxyapi-infra-compose.out
```

Expected: all three configs render successfully and contain dashboard `8318` references.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml docker-compose.local.yml infrastructure/docker-compose.yml infrastructure/config/Caddyfile
git commit -m "refactor: align dashboard networking on port 8318"
```

---

### Task 3: Migrate installer, cron target, and architecture docs

**Files:**
- Modify: `install.sh`
- Modify: `docs/CODEMAPS/architecture.md`

- [ ] **Step 1: Write the failing checks for installer/doc references**

Run from repo root:

```bash
grep -n '127.0.0.1:3000\|localhost:3000\|cliproxyapi-dashboard:3000' install.sh
grep -n 'dashboard:3000' docs/CODEMAPS/architecture.md
```

Expected: old references are found.

- [ ] **Step 2: Update `install.sh` collector and external proxy defaults**

Apply these replacements:

```bash
COLLECTOR_URL="http://127.0.0.1:8318"

# Create docker-compose.override.yml to expose dashboard on localhost:8318
log_info "Creating docker-compose.override.yml to expose dashboard on 127.0.0.1:8318..."

cat > "$OVERRIDE_FILE" << 'COMPOSE_OVERRIDE'
services:
  dashboard:
    ports:
      - "127.0.0.1:8318:8318"
COMPOSE_OVERRIDE

log_info "Dashboard will be accessible at http://127.0.0.1:8318 for your reverse proxy"
```

- [ ] **Step 3: Update generated Caddy snippets and final operator instructions in `install.sh`**

Replace the dashboard-specific outputs with:

```bash
# BEGIN CLIPROXYAPI-AUTO (Host Caddy - localhost upstream)
${DASHBOARD_SUBDOMAIN}.${DOMAIN} {
    reverse_proxy localhost:8318
}

# BEGIN CLIPROXYAPI-AUTO (Docker Caddy - container upstream)
${DASHBOARD_SUBDOMAIN}.${DOMAIN} {
    reverse_proxy cliproxyapi-dashboard:8318
}

echo "     - Dashboard routes to: localhost:8318"
```

- [ ] **Step 4: Update `docs/CODEMAPS/architecture.md`**

Change the system diagram line to:

```md
Browser ──► Next.js App Router (dashboard:8318)
```

- [ ] **Step 5: Re-run the checks**

Run:

```bash
grep -n '127.0.0.1:8318\|localhost:8318\|cliproxyapi-dashboard:8318' install.sh
grep -n 'dashboard:8318' docs/CODEMAPS/architecture.md
```

Expected: only `8318` matches are found for these dashboard references.

- [ ] **Step 6: Commit**

```bash
git add install.sh docs/CODEMAPS/architecture.md
git commit -m "docs: update installer and architecture for dashboard port 8318"
```

---

### Task 4: Verify end-to-end consistency

**Files:**
- Verify all modified files from Tasks 1-3

- [ ] **Step 1: Run TypeScript verification**

Run from `dashboard/`:

```bash
npm run typecheck
```

Expected: exits successfully.

- [ ] **Step 2: Run production build verification**

Run from `dashboard/`:

```bash
npm run build
```

Expected: build completes successfully.

- [ ] **Step 3: Run targeted repo searches for runtime-significant `3000` leftovers**

Run from repo root:

```bash
rg -n 'dashboard:3000|localhost:3000/api/health|127\.0\.0\.1:3000:3000|cliproxyapi-dashboard:3000|ENV PORT=3000|EXPOSE 3000|process\.env\.PORT \?\? "3000"' .
```

Expected: no matches in source-controlled runtime files. Historical design/plan documents may still match and can be ignored if they are not current runtime instructions.

- [ ] **Step 4: Verify compose runtime wiring on localhost 8318**

Run from repo root:

```bash
docker compose up -d --build dashboard
curl -f http://localhost:8318/api/health
docker compose ps dashboard
docker compose logs dashboard --tail=50
```

Expected:
- `curl` returns success
- dashboard container is `running` or `healthy`
- logs do not show startup failures caused by port mismatch

- [ ] **Step 5: Verify local compose file also renders cleanly**

Run:

```bash
docker compose -f docker-compose.local.yml up -d dashboard
docker compose -f docker-compose.local.yml ps dashboard
```

Expected: service definition is valid and dashboard can start with `8318` wiring.

- [ ] **Step 6: Commit verification-safe final changes if any files moved during fixes**

If verification required no extra edits, skip commit. If a final fix was needed, use:

```bash
git add dashboard/Dockerfile dashboard/src/instrumentation-node.ts dashboard/src/app/api/quota/check-alerts/route.ts docker-compose.yml docker-compose.local.yml infrastructure/docker-compose.yml infrastructure/config/Caddyfile install.sh docs/CODEMAPS/architecture.md
git commit -m "chore: verify dashboard port 8318 migration"
```

---

## Spec coverage check

- Runtime port migration: covered by Task 1.
- Compose and service-to-service URLs: covered by Task 2.
- Reverse proxy and health checks: covered by Task 2.
- Installer, cron target, and operator output: covered by Task 3.
- Runtime fallback URLs: covered by Task 1.
- Documentation drift: covered by Task 3.
- Verification and acceptance checks: covered by Task 4.

## Notes for implementers

- Treat all dashboard-specific `3000` references as suspicious until proven non-runtime.
- Ignore unrelated values like timeouts set to `3000`; only migrate dashboard port references.
- If an additional runtime-significant `3000` dashboard reference is found during implementation, update the plan execution to include it in the same change set before claiming completion.
