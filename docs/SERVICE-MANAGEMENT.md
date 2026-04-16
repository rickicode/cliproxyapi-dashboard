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

Use the commands below for start/stop/log inspection or for manual troubleshooting. They are lower-level alternatives, not the recommended day-to-day update workflow.

```bash
cd infrastructure

# Start services
docker compose up -d

# Stop services
docker compose down

# Restart services
docker compose restart

# View running containers
docker compose ps

# View logs (all services)
docker compose logs -f

# View logs (specific service)
docker compose logs -f caddy
docker compose logs -f cliproxyapi
docker compose logs -f dashboard
docker compose logs -f postgres
docker compose logs -f perplexity-sidecar

# Execute command in container
docker compose exec cliproxyapi sh
docker compose exec dashboard sh
docker compose exec postgres psql -U cliproxyapi -d cliproxyapi

# Manually pull remote images for non-build troubleshooting
docker compose pull

# Recreate services manually after a targeted compose change
docker compose up -d
```

If you use `docker compose down` directly, treat it as a continuity-breaking operation because it stops `cliproxyapi`, `postgres`, and the rest of the stack together.

![Docker Commands](code-snippets/docker-commands.png)
