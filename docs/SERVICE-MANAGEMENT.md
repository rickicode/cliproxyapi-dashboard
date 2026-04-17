# Service Management

← [Back to README](../README.md)

## Systemd Commands

```bash
# Start the stack
sudo systemctl start cliproxyapi-stack

# Stop the stack
sudo systemctl stop cliproxyapi-stack

# Restart the stack
sudo systemctl restart cliproxyapi-stack

# View status
sudo systemctl status cliproxyapi-stack

# Enable auto-start on boot
sudo systemctl enable cliproxyapi-stack

# Disable auto-start
sudo systemctl disable cliproxyapi-stack
```

## Recommended Update Workflow

Use `rebuild.sh` from the repository root for normal updates. This is the documented update path because it keeps the image pull/build behavior aligned with this repository:

```bash
# Rebuild dashboard only; preserves CLIProxyAPI continuity
./rebuild.sh --dashboard-only

# Recommended routine update path; avoids full stack tear-down
./rebuild.sh

# Stop/remove everything, then start fresh; interrupts CLIProxyAPI and all services
./rebuild.sh --full-recreate
```

- `./rebuild.sh --dashboard-only` rebuilds the `dashboard` image from the current local checkout, recreates only that container, and waits for Compose readiness before reporting success. Use this when you only need a new dashboard build and want `cliproxyapi` to continue serving requests.
- `./rebuild.sh` is the recommended routine update path. It pulls newer images only for non-buildable services, rebuilds the `dashboard` image from the current local checkout, then runs `docker compose up -d --wait` without a preceding `docker compose down`. That preserves unaffected containers and avoids a stack-wide outage, although any service with a changed image may still be recreated individually.
- `./rebuild.sh --full-recreate` is the explicit destructive path. It still keeps the same pull/build scope as the default mode, but it follows that with `docker compose down` and a clean `docker compose up -d --wait`.

If you want newer dashboard code, update the repository checkout first (for example with `git pull`). `rebuild.sh` does not download dashboard source from GHCR; it rebuilds from whatever source is already present locally.

`rebuild.sh` only rebuilds the local `dashboard` source tree. Optional buildable services such as `perplexity-sidecar` are not rebuilt automatically by any mode of this script.

## Low-Level Docker Compose Commands

Use the commands below from the repository root for start/stop/log inspection or for manual troubleshooting. They are lower-level alternatives, not the recommended day-to-day update workflow. The root `docker-compose.yml` is the production source of truth; `docker-compose.local.yml` remains local-only. Unless you have already exported the same values in your shell, include `--env-file infrastructure/.env -f docker-compose.yml` for direct production Compose commands.

```bash
# Start services
docker compose --env-file infrastructure/.env -f docker-compose.yml up -d

# Stop services
docker compose --env-file infrastructure/.env -f docker-compose.yml down

# Restart services
docker compose --env-file infrastructure/.env -f docker-compose.yml restart

# View running containers
docker compose --env-file infrastructure/.env -f docker-compose.yml ps

# View logs (all services)
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f

# View logs (specific service)
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f caddy
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f cliproxyapi
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f dashboard
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f postgres
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f perplexity-sidecar

# Execute command in container
docker compose --env-file infrastructure/.env -f docker-compose.yml exec cliproxyapi sh
docker compose --env-file infrastructure/.env -f docker-compose.yml exec dashboard sh
docker compose --env-file infrastructure/.env -f docker-compose.yml exec postgres psql -U cliproxyapi -d cliproxyapi

# Manually pull remote images for non-build troubleshooting
docker compose --env-file infrastructure/.env -f docker-compose.yml pull

# Recreate services manually after a targeted compose change
docker compose --env-file infrastructure/.env -f docker-compose.yml up -d
```

If you use `docker compose down` directly, treat it as a continuity-breaking operation because it stops `cliproxyapi`, `postgres`, and the rest of the stack together.

If the host was installed in **external/custom PostgreSQL** mode, the bundled `postgres` service should remain inert. Use these Compose commands for the rest of the production stack, but perform database backups/restores through your external PostgreSQL tooling rather than through bundled helpers.

![Docker Commands](code-snippets/docker-commands.png)
