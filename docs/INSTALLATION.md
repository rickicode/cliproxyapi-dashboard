# Installation Guide

← [Back to README](../README.md)

## Prerequisites

Before installing, ensure you have:

> **Local use (macOS/Windows/Linux)**: Only Docker Desktop is required. See [Local Setup](#local-setup-macos--windows--linux).

**For server deployment:**

- **Operating System**: Ubuntu 20.04+ or Debian 11+ are the installer's supported Linux targets. Other Linux distributions may work for manual setups, but `install.sh` does not treat them as supported paths.
- **Root Access**: Required for Docker and firewall configuration
- **Domain Name**: A registered domain with DNS control
- **Server**: VPS or dedicated server with public IP address
- **Ports Available**: 80, 443, 8085, 1455, 54545, 51121, 11451

### Preflight Checklist

Complete **before** running the installer:

- [ ] **DNS Records Configured**: Set A records for `dashboard.yourdomain.com` and `api.yourdomain.com` pointing to your server IP
- [ ] **DNS Propagated**: Verify records with `dig dashboard.yourdomain.com` (allow 5-15 minutes)
- [ ] **Ports Available**: Confirm no services using ports 80, 443, 8085, 1455, 54545, 51121, 11451
- [ ] **Root Access**: SSH access with `sudo` or root privileges
- [ ] **First Admin Window**: Plan to create your admin account immediately after installation completes

### DNS Configuration

Configure DNS A records for your domain **before installation**:

```
dashboard.example.com  →  YOUR_SERVER_IP
api.example.com        →  YOUR_SERVER_IP
```

![DNS Configuration](code-snippets/dns-config.png)

Replace `example.com` with your actual domain and `YOUR_SERVER_IP` with your server's public IP address.

> **Critical**: DNS records must be live before first start. Caddy requests Let's Encrypt certificates immediately, which requires valid DNS.

> **Security Note**: Until you create the first admin account, the dashboard setup page is accessible to anyone who can reach your domain. Restrict access using firewall rules if needed, or complete setup immediately after installation.

## Quick Start (Docker Compose)

The fastest way to get started is using the automated installer:

```bash
git clone https://github.com/itsmylife44/cliproxyapi-dashboard.git
cd cliproxyapi-dashboard
sudo ./install.sh
```

![Quick Start](code-snippets/quick-start.png)

The installer will:
1. Prompt for domain and subdomain configuration
2. Prompt whether production data should live in the bundled Docker-managed PostgreSQL service or in an external/custom PostgreSQL instance (the bundled `postgres` container still remains present as an inert dependency placeholder in external DB mode)
3. Install Docker and Docker Compose (if not already installed)
4. Configure UFW firewall with required ports
5. Generate secure secrets (JWT_SECRET, MANAGEMENT_API_KEY, and `POSTGRES_PASSWORD` when using the bundled PostgreSQL service)
6. Create the production environment file at `infrastructure/.env` with all required configuration
7. Prepare the repository-root Docker Compose stack contract from your local checkout (configuration, env file, and startup wiring)
8. Create and enable a systemd service for startup on boot
9. Optionally set up automated daily or weekly backups when using the bundled PostgreSQL service
10. Remove only the legacy installer-managed `/api/usage/collect` cron entry/comment because periodic usage collection is now handled internally by the dashboard app

After installation, use the recommended update path that matches your maintenance window:

- `./rebuild.sh --dashboard-only` rebuilds the `dashboard` image from your current local checkout and recreates only the `dashboard` container. It preserves `cliproxyapi` continuity.
- `./rebuild.sh` is the recommended routine update path. It pulls newer images only for non-buildable services, rebuilds the `dashboard` image from your current local checkout, then runs `docker compose up -d --wait` without a full stack tear-down. Unchanged services stay up, but any service with a changed image can still be recreated individually.
- `./rebuild.sh --full-recreate` is the disruptive option. It pulls newer images only for non-buildable services, rebuilds the `dashboard` image from your current local checkout, then runs `docker compose down` followed by `docker compose up -d --wait`, interrupting `cliproxyapi` and the rest of the stack.

`rebuild.sh` only rebuilds the local `dashboard` source tree. It does not automatically rebuild other optional buildable services such as `perplexity-sidecar`; rebuild those manually if you maintain local changes there.

### Post-Installation

After installation completes, start the service manually:

```bash
sudo systemctl start cliproxyapi-stack
sudo systemctl status cliproxyapi-stack
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f
```

For later updates, prefer `./rebuild.sh` for continuity-preserving maintenance and reserve `./rebuild.sh --full-recreate` for cases where you explicitly want a full stack restart. If you expect a newer dashboard release, update this repository first (for example with `git pull`) because `rebuild.sh` rebuilds the dashboard image from the local source tree; it does not fetch dashboard source from GHCR. The same script does not rebuild optional buildable services such as `perplexity-sidecar`.

Access the dashboard at:
- **Dashboard**: `https://dashboard.yourdomain.com`
- **API**: `https://api.yourdomain.com`

> **Usage collection**: You do not need to configure an OS cron job for periodic usage collection. The dashboard app owns this scheduling internally and continues collecting usage data without an installer-managed cron dependency. If you run your own external automation against `POST /api/usage/collect`, that remains supported and the installer cleanup does not remove it.

### Initial Setup Flow

1. **First Visit**: Navigate to `https://dashboard.yourdomain.com`
2. **Automatic Redirect**: You'll be redirected to `/setup` (the setup wizard)
3. **Create Admin Account**: Enter your desired username and password
4. **Setup Disabled**: After creating the first user, the setup page becomes inaccessible
5. **Login**: Use your new credentials to access the dashboard

**Important Notes**:
- There are no default credentials
- The setup page is publicly accessible until the first admin account is created
- After first user creation, setup is permanently disabled
- Use the **Configuration** page to set up API keys and AI providers — no manual file editing required

## Local Setup (macOS / Windows / Linux)

Run the full stack locally using Docker Desktop — no server, domain, or TLS required.

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### macOS / Linux

```bash
git clone https://github.com/itsmylife44/cliproxyapi-dashboard.git
cd cliproxyapi-dashboard
./setup-local.sh
./setup-local.sh --down    # Stop
./setup-local.sh --reset   # Reset (removes all data)
```

![Local Setup macOS](code-snippets/local-setup-mac.png)

### Windows (PowerShell)

```powershell
git clone https://github.com/itsmylife44/cliproxyapi-dashboard.git
cd cliproxyapi-dashboard
.\setup-local.ps1
.\setup-local.ps1 -Down    # Stop
.\setup-local.ps1 -Reset   # Reset (removes all data)
```

![Local Setup Windows](code-snippets/local-setup-windows.png)

Dashboard runs on `localhost:8318`, CLIProxyAPIPlus proxy on `localhost:11451`.

## Manual Installation

If you prefer manual setup or need customization:

### 1. Install Docker

**Ubuntu:**
```bash
# Update packages
sudo apt-get update

# Install prerequisites
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Enable and start Docker
sudo systemctl enable docker
sudo systemctl start docker
```

**Debian:**
```bash
# Update packages
sudo apt-get update

# Install prerequisites
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository (note: debian instead of ubuntu)
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Enable and start Docker
sudo systemctl enable docker
sudo systemctl start docker
```

> **Note**: The automated installer (`install.sh`) no longer manages distro-specific Docker APT repository paths itself. It installs or repairs Docker/Compose through `https://get.docker.com`, which handles the supported Ubuntu/Debian package setup for the installer.

### 2. Configure Firewall

```bash
sudo apt-get install -y ufw

# Allow SSH (prevent lockout)
sudo ufw limit 22/tcp

# Allow HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp  # HTTP/3

# Allow OAuth callback ports
sudo ufw allow 8085/tcp
sudo ufw allow 1455/tcp
sudo ufw allow 54545/tcp
sudo ufw allow 51121/tcp
sudo ufw allow 11451/tcp

# Enable firewall
sudo ufw enable
```

### 3. Generate Secrets

```bash
# Generate secure secrets
JWT_SECRET=$(openssl rand -base64 32)
MANAGEMENT_API_KEY=$(openssl rand -hex 32)

# Display secrets (save these values)
echo "JWT_SECRET=$JWT_SECRET"
echo "MANAGEMENT_API_KEY=$MANAGEMENT_API_KEY"
```

If you are using the bundled Docker-managed PostgreSQL service, also generate and save:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 32)
echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
```

### 4. Create Environment File

Choose the example that matches your database mode.

#### Docker-managed PostgreSQL example

```bash
cat > infrastructure/.env << EOF
DOMAIN=example.com
DASHBOARD_SUBDOMAIN=dashboard
API_SUBDOMAIN=api
DB_MODE=docker
DATABASE_URL=postgresql://cliproxyapi:${POSTGRES_PASSWORD}@postgres:5432/cliproxyapi
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
MANAGEMENT_API_KEY=${MANAGEMENT_API_KEY}
COLLECTOR_API_KEY=$(openssl rand -hex 32)
PROVIDER_ENCRYPTION_KEY=$(openssl rand -hex 32)
CLIPROXYAPI_MANAGEMENT_URL=http://cliproxyapi:8317/v0/management
INSTALL_DIR=$(pwd)
TZ=UTC
LOG_LEVEL=info
DASHBOARD_URL=https://dashboard.example.com
API_URL=https://api.example.com
EOF

# Secure the environment file
chmod 600 infrastructure/.env
```

![Environment Setup](code-snippets/env-setup.png)

Replace `example.com` with your actual domain.

#### External/custom PostgreSQL example

```bash
EXTERNAL_DATABASE_URL='postgresql://dbuser:dbpass@db.example.net:5432/cliproxyapi'

cat > infrastructure/.env << EOF
DOMAIN=example.com
DASHBOARD_SUBDOMAIN=dashboard
API_SUBDOMAIN=api
DB_MODE=external
DATABASE_URL=${EXTERNAL_DATABASE_URL}
JWT_SECRET=${JWT_SECRET}
MANAGEMENT_API_KEY=${MANAGEMENT_API_KEY}
COLLECTOR_API_KEY=$(openssl rand -hex 32)
PROVIDER_ENCRYPTION_KEY=$(openssl rand -hex 32)
CLIPROXYAPI_MANAGEMENT_URL=http://cliproxyapi:8317/v0/management
INSTALL_DIR=$(pwd)
TZ=UTC
LOG_LEVEL=info
DASHBOARD_URL=https://dashboard.example.com
API_URL=https://api.example.com
EOF

chmod 600 infrastructure/.env
```

> **Critical**: The `infrastructure/.env` file is generated by `install.sh` and must include the variables required for your chosen database mode. An empty or missing `.env` file will cause the stack to fail on startup. Do not commit this file to version control.

> **Compose boundary**: Production Docker Compose operations now use the repository root `docker-compose.yml` as the source of truth. `docker-compose.local.yml` remains local-development-only. Any installer-managed `docker-compose.override.yml` is written at the repository root beside `docker-compose.yml` so root/systemd invocations load it automatically.

> **Root override note**: In external proxy mode and webhook mode, the installer writes runtime overrides to the repository-root `docker-compose.override.yml` only when it can create that file itself. If a root override already exists, the installer leaves it unchanged and prints the exact `dashboard` snippet you must merge manually (for example `ports` for external proxy mode or `extra_hosts` for webhook mode).

### 4a. Choose a Database Mode

Production installs support two database modes:

- **Docker-managed PostgreSQL**: the default bundled `postgres` service inside the production Compose stack. This is the simplest option and keeps installer-managed backup/restore helpers available.
- **External/custom PostgreSQL**: use your own managed database service or an existing PostgreSQL server. In this mode, the bundled `postgres` service still starts as an inert placeholder because the production Compose runtime keeps the dashboard's `depends_on` contract intact, and installer-managed backup/restore helpers are not supported.

When using an external/custom database:

- Set `DATABASE_URL` to your external PostgreSQL connection string.
- Expect the bundled `postgres` container to remain present but inert; do not expect it to hold production data.
- Manage backups, restore, HA, and credential rotation through your external database platform or your own operational tooling.

### 5. Configure CLIProxyAPIPlus

API keys and AI providers can be configured through the Dashboard UI after first login. Alternatively, you can edit `infrastructure/config/config.yaml` directly.

Periodic usage collection does not require the old installer-managed cron setup. The dashboard app now runs the collector on its own, while `POST /api/usage/collect` remains available for manual or external integrations when needed. The installer only cleans up the legacy installer-managed cron entry/comment and leaves custom external automations intact.

If you need to onboard many Codex accounts at once, the Dashboard `Providers` page supports bulk JSON import for Codex OAuth credentials. The input format is a JSON array where each item contains an `email` plus the credential payload fields such as `access_token` and `refresh_token`. See [CONFIGURATION.md](./CONFIGURATION.md#codex-bulk-import) for the exact format.

### 6. Create Systemd Service

The installer writes this unit dynamically so the explicit service list matches your selected reverse-proxy/profile modes while preserving the current production Compose dependency contract:

- integrated Caddy vs external reverse proxy
- optional `perplexity-sidecar` profile enablement

The manual example below reflects the default integrated-Caddy path. The `postgres` service remains in the explicit startup list even for external/custom PostgreSQL installs so the bundled container stays available as the inert dependency placeholder expected by the current runtime model.

```bash
sudo tee /etc/systemd/system/cliproxyapi-stack.service > /dev/null << 'EOF'
[Unit]
Description=CLIProxyAPI Stack (Docker Compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/opt/cliproxyapi
ExecStart=/usr/bin/docker compose --env-file /opt/cliproxyapi/infrastructure/.env -f /opt/cliproxyapi/docker-compose.yml up -d --wait postgres caddy docker-proxy cliproxyapi dashboard
ExecStop=/usr/bin/docker compose --env-file /opt/cliproxyapi/infrastructure/.env -f /opt/cliproxyapi/docker-compose.yml down
TimeoutStartSec=300
TimeoutStopSec=120
Restart=on-failure
RestartSec=10s
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

# Update the install path in the unit file to match your checkout location
INSTALL_DIR="$(pwd)"
sudo sed -i "s|/opt/cliproxyapi|${INSTALL_DIR}|g" \
  /etc/systemd/system/cliproxyapi-stack.service

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable cliproxyapi-stack
```

This matches the installer's production contract: the stack is started from the repository root, reads variables from `infrastructure/.env`, and automatically picks up any root-level `docker-compose.override.yml` written by the installer.

If you use an external/custom PostgreSQL server, keep `postgres` in `ExecStart`; it remains an inert placeholder container and should not hold production data. If you use an external reverse proxy, remove `caddy`. If you enable the Perplexity sidecar profile, add `perplexity-sidecar` to the explicit `ExecStart` service list because profiled services are not auto-started when Compose is invoked with explicit service names.

### 7. Start the Stack

```bash
sudo systemctl start cliproxyapi-stack
```

Or manually from the repository root, using the service list that matches your reverse-proxy mode:

**Integrated Caddy**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml up -d --wait postgres caddy docker-proxy cliproxyapi dashboard
```

**External reverse proxy**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml up -d --wait postgres docker-proxy cliproxyapi dashboard
```

In external/custom PostgreSQL mode, keep `postgres` in those commands as well. The bundled container remains present only as an inert placeholder because the current production runtime still starts it alongside `dashboard`.

Add `perplexity-sidecar` to the explicit service list when you intentionally enable that profile. This keeps the manual command aligned with the installer's mode-aware systemd unit generation.

For ongoing maintenance from the repository root, prefer the `rebuild.sh` flows above instead of ad-hoc compose update commands:

```bash
./rebuild.sh                  # In-place refresh, avoids full stack tear-down
./rebuild.sh --dashboard-only # Rebuild dashboard only, leaves cliproxyapi untouched
./rebuild.sh --full-recreate  # Full stop/remove/start cycle for the entire stack
```

Use `--full-recreate` only when you are prepared for a complete service interruption.

If you intentionally need low-level/manual Compose operations, use them for troubleshooting or specialized cases rather than as the normal update path. In particular, `rebuild.sh` is the documented update workflow because it keeps the pull scope aligned with the repository's local-build behavior.

When you do use direct production Compose commands from the repository root, include the production env-file contract explicitly unless you have already exported the same variables in your shell:

```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml ps
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f
docker compose --env-file infrastructure/.env -f docker-compose.yml down
```

If you instead operate from `infrastructure/`, the legacy wrapper there forwards to the repository-root production Compose file while keeping `infrastructure/.env` as the active env file.
