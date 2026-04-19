# Installation Guide

← [Back to README](../README.md)

## Prerequisites

Before installing, ensure you have:

> **Local use (macOS/Windows/Linux)**: Only Docker Desktop is required. See [Local Setup](#local-setup-macos--windows--linux).

**For server deployment:**

- **Operating System**: Ubuntu 20.04+ or Debian 11+ are the installer's supported Linux targets. Other Linux distributions may work for manual setups, but `install.sh` does not treat them as supported paths.
- **Root Access**: Required for Docker and firewall configuration
- **Server**: VPS, dedicated server, or reachable LAN host
- **Ports Available**:
  - Domain mode: 80, 443, 8085, 1455, 54545, 51121, 11451
  - No-domain modes: 8317, 8318, 8085, 1455, 54545, 51121, 11451

### Preflight Checklist

Complete **before** running the installer:

- [ ] **Root Access**: SSH access with `sudo` or root privileges
- [ ] **Ports Available**: Confirm no conflicting services on the ports required by your chosen access mode
- [ ] **First Admin Window**: Plan to create your admin account immediately after installation completes
- [ ] **If using domain mode**: DNS records for dashboard/api hostnames already point at this server
- [ ] **If using Cloudflare Tunnel mode**: Have your Cloudflare Tunnel token ready

### DNS Configuration (domain mode only)

Configure DNS A records for your domain **before installation**:

```
dashboard.example.com  →  YOUR_SERVER_IP
api.example.com        →  YOUR_SERVER_IP
```

![DNS Configuration](code-snippets/dns-config.png)

Replace `example.com` with your actual domain and `YOUR_SERVER_IP` with your server's public IP address.

> **Critical**: DNS records must be live before first start in domain mode. Caddy requests Let's Encrypt certificates immediately, which requires valid DNS.

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
1. Prompt for access mode: domain + bundled Caddy, Cloudflare Tunnel, or local IP only
2. Prompt whether production data should live in the bundled Docker-managed PostgreSQL service or in an external/custom PostgreSQL instance (the bundled `postgres` container still remains present as an inert dependency placeholder in external DB mode)
3. Install Docker and Docker Compose (if not already installed)
4. Configure UFW firewall with the ports required by the selected access mode
5. Generate secure secrets (JWT_SECRET, MANAGEMENT_API_KEY, and `POSTGRES_PASSWORD` when using the bundled PostgreSQL service)
6. Fetch the runtime bundle files into `/opt/cliproxyapi` from GitHub raw URLs
7. Create the production environment file at `/opt/cliproxyapi/.env` and install metadata at `/opt/cliproxyapi/metadata/install-info.env`
8. Create and enable a systemd service for startup on boot
9. Install and configure `cloudflared` when Cloudflare Tunnel mode is selected
9. Optionally set up automated daily or weekly backups when using the bundled PostgreSQL service
10. Remove only the legacy installer-managed `/api/usage/collect` cron entry/comment because periodic usage collection is now handled internally by the dashboard app

### Post-Installation

After installation completes, start the service manually:

```bash
sudo systemctl start cliproxyapi-stack
sudo systemctl status cliproxyapi-stack
cd /opt/cliproxyapi
docker compose --env-file .env -f docker-compose.yml logs -f
```

Access after install depends on your selected mode:

- **Domain mode**: `https://dashboard.yourdomain.com` and `https://api.yourdomain.com`
- **Cloudflare Tunnel mode**: use the Cloudflare hostnames you configure, pointing them at `http://SERVER_IP:8318` and `http://SERVER_IP:8317`
- **Local IP mode**: `http://SERVER_IP:8318` and `http://SERVER_IP:8317`

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

For installer-managed deployments, `install.sh` generates `/opt/cliproxyapi/.env` for you. You normally do not create it by hand.

Common values written there include:

- `ACCESS_MODE`
- `LOCAL_IP`
- `DOMAIN`, `DASHBOARD_SUBDOMAIN`, `API_SUBDOMAIN` (domain mode only)
- `DATABASE_URL`
- `POSTGRES_PASSWORD` (bundled Docker Postgres mode only)
- `JWT_SECRET`
- `MANAGEMENT_API_KEY`
- `DASHBOARD_URL`
- `API_URL`
- `CLIPROXYAPI_BIND_ADDRESS`
- `DASHBOARD_BIND_ADDRESS`
- `COMPOSE_PROFILES`
- `CLOUDFLARE_TUNNEL_TOKEN` (Cloudflare mode only)

```bash
sudo ls -l /opt/cliproxyapi/.env
sudo sed -n '1,40p' /opt/cliproxyapi/.env
```

> **Critical**: `/opt/cliproxyapi/.env` is the active production env file for installer-managed runtime-bundle installs. Keep it secret, keep it readable only by privileged users, and do not commit it to version control.

### 4a. Choose a Database Mode

Production installs support two database modes:

- **Docker-managed PostgreSQL**: the default bundled `postgres` service inside the production Compose stack. This is the simplest option and keeps installer-managed backup/restore helpers available.
- **External/custom PostgreSQL**: use your own managed database service or an existing PostgreSQL server. In this mode, the bundled `postgres` service still starts as an inert placeholder because the production Compose runtime keeps the dashboard's `depends_on` contract intact, and installer-managed backup/restore helpers are not supported.

When using an external/custom database:

- Set `DATABASE_URL` to your external PostgreSQL connection string.
- Expect the bundled `postgres` container to remain present but inert; do not expect it to hold production data.
- Manage backups, restore, HA, and credential rotation through your external database platform or your own operational tooling.

### 5. Configure CLIProxyAPIPlus

API keys and AI providers can be configured through the Dashboard UI after first login. Alternatively, you can edit `/opt/cliproxyapi/config/config.yaml` directly.

Periodic usage collection does not require the old installer-managed cron setup. The dashboard app now runs the collector on its own, while `POST /api/usage/collect` remains available for manual or external integrations when needed. The installer only cleans up the legacy installer-managed cron entry/comment and leaves custom external automations intact.

If you need to onboard many Codex accounts at once, the Dashboard `Providers` page supports bulk JSON import for Codex OAuth credentials. The input format is a JSON array where each item contains an `email` plus the credential payload fields such as `access_token` and `refresh_token`. See [CONFIGURATION.md](./CONFIGURATION.md#codex-bulk-import) for the exact format.

### 6. Create Systemd Service

The installer writes this unit dynamically so it starts the runtime bundle from `/opt/cliproxyapi` and enables the correct profile set for your selected access mode.

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
ExecStart=/usr/bin/docker compose --env-file /opt/cliproxyapi/.env -f /opt/cliproxyapi/docker-compose.yml up -d --wait postgres docker-proxy cliproxyapi dashboard
ExecStop=/usr/bin/docker compose --env-file /opt/cliproxyapi/.env -f /opt/cliproxyapi/docker-compose.yml down
TimeoutStartSec=300
TimeoutStopSec=120
Restart=on-failure
RestartSec=10s
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable cliproxyapi-stack
```

In domain mode, the installer adds the bundled Caddy profile. In local-IP and Cloudflare modes, the dashboard and API are exposed directly on `8318` and `8317` without Caddy.

### 7. Start the Stack

```bash
sudo systemctl start cliproxyapi-stack
```

Or manually from the runtime bundle root:

```bash
cd /opt/cliproxyapi
docker compose --env-file .env -f docker-compose.yml up -d --wait
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs -f
docker compose --env-file .env -f docker-compose.yml down
```

In external/custom PostgreSQL mode, the bundled `postgres` container remains an inert placeholder and should not hold production data.
