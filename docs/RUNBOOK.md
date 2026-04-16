# Runbook

## Health Check

```
GET /api/health
```

Returns 200 if the dashboard is running. Does not check database connectivity.

## Deployment

### Docker (Production)

```bash
# Build and deploy via dashboard UI
# Navigate to Settings → Deploy section
# Or via API:
POST /api/admin/deploy
```

### Rebuild / Update Paths

Use the update path that matches the desired blast radius. For normal maintenance, `./rebuild.sh` is the recommended update path and the raw Compose commands are lower-level/manual alternatives.

```bash
# Preserve CLIProxyAPI continuity; only dashboard is recreated
./rebuild.sh --dashboard-only

# Continuity-preserving default; no full stack tear-down
./rebuild.sh

# Disruptive full restart of the compose stack
./rebuild.sh --full-recreate
```

- `--dashboard-only`: safest option when only the dashboard image changed; it rebuilds the dashboard image from the current local checkout, recreates only that container, and waits for Compose readiness before reporting success.
- default `./rebuild.sh`: recommended routine update path; it pulls newer images only for non-buildable services, rebuilds the dashboard image from the current local checkout, and applies updates with `docker compose up -d --wait`, so unaffected services keep running.
- `--full-recreate`: uses the same pull/build scope as the default path, but intentionally follows it with `docker compose down` and a clean `docker compose up -d --wait`.

If you need a newer dashboard release, update the repository contents first (for example with `git pull`). `rebuild.sh` rebuilds from local source; it does not pull dashboard source from GHCR. It also does not automatically rebuild optional buildable services such as `perplexity-sidecar`.

### Local Development

```powershell
cd dashboard
.\dev-local.ps1          # Start everything
.\dev-local.ps1 -Down    # Stop containers
.\dev-local.ps1 -Reset   # Delete all data and restart
```

## Database

### Run Migrations

```bash
cd dashboard
npx prisma migrate deploy
```

### Reset Database (development only)

```bash
.\dev-local.ps1 -Reset
```

### Connect to Database

```bash
# Dev: localhost:5433
docker exec -it cliproxyapi-dev-postgres psql -U cliproxyapi -d cliproxyapi
```

## Common Issues

### Dashboard won't start
1. Check Docker is running: `docker info`
2. Check containers: `docker ps`
3. Check logs: `docker logs cliproxyapi-dev-postgres`
4. Verify `.env.local` exists with correct `DATABASE_URL`

### Database connection errors
1. Verify PostgreSQL container is running: `docker ps | grep postgres`
2. Check port 5433 is available
3. Run `npx prisma migrate deploy` if schema is out of date

### CLIProxyAPI unreachable
1. Check API container: `docker logs cliproxyapi-dev-api`
2. Verify port 28317 is accessible: `curl http://localhost:28317/`
3. Wait for healthcheck (up to 60s on first start)

### Build errors after branch switch
```bash
cd dashboard
npx prisma generate    # Regenerate Prisma client
npm install            # Reinstall dependencies
```

## Updates

### Update Proxy
```
Settings → CLIProxyAPI Updates → Update
# Or: POST /api/update
```

If the proxy update is handled outside the dashboard UI, prefer `./rebuild.sh` over raw Compose update commands so the stack is refreshed without an unnecessary full shutdown. Remember that the default path only pulls non-buildable service images and rebuilds the dashboard from local source. It does not automatically rebuild optional buildable services such as `perplexity-sidecar`. Use `./rebuild.sh --full-recreate` only when a clean recreate is specifically required.

### Update Dashboard
```
Settings → Dashboard Updates → Update
# Or: POST /api/update/dashboard
```

## Monitoring

- **Service status**: Dashboard → Monitoring page
- **Logs**: Dashboard → Monitoring → Live Logs
- **Usage**: Dashboard → Usage page
- **Quota**: Dashboard → Quota page
