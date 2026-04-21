#!/bin/bash
#
# CLIProxyAPI Stack Installation Script
# Installs Docker, Docker Compose, configures UFW, generates secrets, and sets up a boot-time
# systemd wrapper for `docker compose up -d --wait`.
#
# Lifecycle intent:
# - Compose files keep individual containers on `restart: unless-stopped` for daemon/host recovery.
# - This installer adds a systemd unit so the intended compose project is brought up automatically on boot.
# - If an operator stops a container/service intentionally, `unless-stopped` preserves that choice until the
#   stack is started again via systemd or `docker compose up`.
#
# Usage: sudo ./install.sh
#

set -euo pipefail

if [ ! -t 0 ]; then
    echo "[ERROR] This installer requires an interactive terminal."
    echo "[ERROR] Run it directly in an SSH shell or terminal session."
    echo "[ERROR] For full manual/server instructions, see docs/INSTALLATION.md"
    exit 1
fi

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

detect_local_ip() {
    local detected_ip=""

    if command -v ip &> /dev/null; then
        detected_ip=$(ip route get 1.1.1.1 2>/dev/null | python3 -c 'import sys,re; data=sys.stdin.read(); m=re.search(r"\bsrc\s+(\S+)", data); print(m.group(1) if m else "")')
    fi

    if [ -z "$detected_ip" ] && command -v hostname &> /dev/null; then
        detected_ip=$(hostname -I 2>/dev/null | python3 -c 'import sys; data=sys.stdin.read().split(); print(data[0] if data else "")')
    fi

    if [ -z "$detected_ip" ]; then
        detected_ip="127.0.0.1"
    fi

    printf '%s\n' "$detected_ip"
}

resolve_github_fetch_ref() {
    local manual_ref=""

    if [ -n "${CLIPROXYAPI_INSTALLER_REF:-}" ]; then
        printf '%s\n' "$CLIPROXYAPI_INSTALLER_REF"
        return 0
    fi

    if command -v git &> /dev/null && git -C "$INSTALLER_SOURCE_DIR" rev-parse HEAD >/dev/null 2>&1; then
        git -C "$INSTALLER_SOURCE_DIR" rev-parse HEAD
        return 0
    fi

    log_warning "Installer is not running from a git checkout"
    log_warning "Runtime bundle fetches need an explicit Git tag or commit SHA"

    while true; do
        read -r -p "Enter installer ref (tag or commit SHA): " manual_ref
        if [ -z "$manual_ref" ]; then
            log_error "Installer ref cannot be empty"
            continue
        fi

        printf '%s\n' "$manual_ref"
        return 0
    done
}

resolve_github_repository() {
    local remote_url=""
    local trimmed=""
    local normalized=""
    local manual_repo=""

    if [ -n "${CLIPROXYAPI_INSTALLER_REPOSITORY:-}" ]; then
        printf '%s\n' "$CLIPROXYAPI_INSTALLER_REPOSITORY"
        return 0
    fi

    if command -v git &> /dev/null; then
        remote_url=$(git -C "$INSTALLER_SOURCE_DIR" remote get-url origin 2>/dev/null || true)
        if [ -n "$remote_url" ]; then
            trimmed=${remote_url%.git}

            if [[ "$trimmed" =~ ^git@github\.com:(.+/.+)$ ]]; then
                normalized=${BASH_REMATCH[1]}
            elif [[ "$trimmed" =~ ^https?://github\.com/(.+/.+)$ ]]; then
                normalized=${BASH_REMATCH[1]}
            fi

            if [ -n "$normalized" ]; then
                printf '%s\n' "$normalized"
                return 0
            fi

            log_warning "Origin remote is not a supported GitHub URL: $remote_url"
        fi
    fi

    log_warning "Unable to derive GitHub repository from installer checkout"
    log_warning "Runtime bundle fetches need an explicit GitHub repository in owner/name form"

    while true; do
        read -r -p "Enter installer GitHub repository (owner/name): " manual_repo
        if [ -z "$manual_repo" ]; then
            log_error "GitHub repository cannot be empty"
            continue
        fi

        if [[ ! "$manual_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
            log_error "GitHub repository must use owner/name format"
            continue
        fi

        printf '%s\n' "$manual_repo"
        return 0
    done
}

ensure_runtime_directories() {
    mkdir -p "$RUNTIME_ROOT" "$RUNTIME_CONFIG_DIR" "$RUNTIME_INFRA_DIR/config" "$RUNTIME_METADATA_DIR" "$RUNTIME_SCRIPTS_DIR" "$RUNTIME_BACKUPS_DIR"
}

fetch_github_raw_file() {
    local relative_path=$1
    local destination_path=$2
    local url="${GITHUB_RAW_BASE_URL}/${relative_path}"

    mkdir -p "$(dirname "$destination_path")"

    if ! curl -fsSL "$url" -o "$destination_path"; then
        log_error "Failed to fetch required runtime file: $relative_path"
        log_error "URL: $url"
        exit 1
    fi

    if [ ! -s "$destination_path" ]; then
        log_error "Fetched runtime file is empty: $relative_path"
        exit 1
    fi
}

fetch_runtime_bundle() {
    log_info "Fetching runtime bundle into $RUNTIME_ROOT"

    fetch_github_raw_file "docker-compose.yml" "$RUNTIME_COMPOSE_FILE"
    fetch_github_raw_file "infrastructure/config/config.yaml" "$RUNTIME_CONFIG_FILE"
    fetch_github_raw_file "scripts/backup.sh" "$RUNTIME_SCRIPTS_DIR/backup.sh"
    fetch_github_raw_file "scripts/restore.sh" "$RUNTIME_SCRIPTS_DIR/restore.sh"
    fetch_github_raw_file "scripts/rotate-backups.sh" "$RUNTIME_SCRIPTS_DIR/rotate-backups.sh"

    if [ "$ACCESS_MODE" = "domain" ]; then
        fetch_github_raw_file "infrastructure/config/Caddyfile" "$RUNTIME_CADDY_FILE"
    fi

    chmod +x "$RUNTIME_SCRIPTS_DIR/backup.sh" "$RUNTIME_SCRIPTS_DIR/restore.sh" "$RUNTIME_SCRIPTS_DIR/rotate-backups.sh"
}

validate_runtime_compose_template() {
    if ! env \
        MANAGEMENT_API_KEY=dummy \
        COLLECTOR_API_KEY=dummy \
        JWT_SECRET=dummy \
        DATABASE_URL=postgresql://user:pass@localhost:5432/db \
        PROVIDER_ENCRYPTION_KEY=dummy \
        docker compose -f "$RUNTIME_COMPOSE_FILE" config >/dev/null 2>&1; then
        log_error "Fetched runtime compose file is not parseable"
        exit 1
    fi
}

validate_runtime_compose_with_env() {
    if ! docker compose --env-file "$ENV_FILE" -f "$RUNTIME_COMPOSE_FILE" config >/dev/null 2>&1; then
        log_error "Runtime compose file failed validation with generated environment"
        exit 1
    fi
}

write_install_metadata() {
    cat > "$INSTALL_INFO_FILE" <<EOF
INSTALLER_SOURCE_DIR=$INSTALLER_SOURCE_DIR
RUNTIME_ROOT=$RUNTIME_ROOT
ACCESS_MODE=$ACCESS_MODE
LOCAL_IP=$LOCAL_IP
DOMAIN=${DOMAIN:-}
DASHBOARD_SUBDOMAIN=${DASHBOARD_SUBDOMAIN:-}
API_SUBDOMAIN=${API_SUBDOMAIN:-}
DASHBOARD_URL=$DASHBOARD_URL
API_URL=$API_URL
DB_MODE=$DB_MODE
PERPLEXITY_ENABLED=$PERPLEXITY_ENABLED
OAUTH_ENABLED=$OAUTH_ENABLED
GITHUB_RAW_BASE_URL=$GITHUB_RAW_BASE_URL
GITHUB_FETCH_REF=$GITHUB_REF
INSTALL_TIMESTAMP=$(date -Iseconds)
EOF
    chmod 600 "$INSTALL_INFO_FILE"
}

log_override_manual_merge_warning() {
    local override_file=$1
    local reason=$2
    local snippet=$3

    log_warning "$override_file already exists; the installer will not rewrite or merge it automatically."
    log_warning "$reason"
    log_warning "Review the existing root override and add the following under 'services: dashboard:' if needed:"
    while IFS= read -r snippet_line; do
        [ -n "$snippet_line" ] && log_warning "    $snippet_line"
    done <<< "$snippet"
}

root_override_has_dashboard_host_gateway() {
    local override_file=$1

    python3 - "$override_file" <<'PY'
import re
import sys

path = sys.argv[1]

try:
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
except OSError:
    sys.exit(1)

stack = []
list_path = None
target_value = 'host.docker.internal:host-gateway'

for raw_line in lines:
    line = raw_line.rstrip("\n")
    stripped = line.strip()

    if not stripped or stripped.startswith("#"):
        continue

    indent = len(line) - len(line.lstrip(" "))

    while stack and indent <= stack[-1][0]:
        stack.pop()

    if list_path is not None:
        if indent > list_path[0]:
            item_match = re.match(r'^\s*-\s*["\']?([^"\'#]+)["\']?\s*(?:#.*)?$', line)
            if item_match and [segment for _, segment in stack] == list_path[1]:
                if item_match.group(1).strip() == target_value:
                    sys.exit(0)
            continue
        list_path = None

    key_match = re.match(r'^\s*([A-Za-z0-9_.-]+):\s*(.*?)\s*(?:#.*)?$', line)
    if not key_match:
        continue

    key = key_match.group(1)
    value = key_match.group(2)
    stack.append((indent, key))
    current_path = [segment for _, segment in stack]

    if current_path == ["services", "dashboard", "extra_hosts"]:
        if value.startswith("[") and value.endswith("]"):
            items = [item.strip().strip('"\'') for item in value[1:-1].split(",") if item.strip()]
            if target_value in items:
                sys.exit(0)
        list_path = (indent, current_path)

sys.exit(1)
PY
}

# Preflight conflict detection functions
check_port_conflict() {
    local port=$1
    
    # Try ss (preferred, available on most Linux systems)
    if command -v ss &> /dev/null; then
        if ss -tlnp 2>/dev/null | grep -q ":$port "; then
            echo "$port"
            return 0
        fi
    # Fallback to lsof
    elif command -v lsof &> /dev/null; then
        if lsof -i ":$port" 2>/dev/null | grep -q LISTEN; then
            echo "$port"
            return 0
        fi
    # Final fallback: try netstat
    elif command -v netstat &> /dev/null; then
        if netstat -tln 2>/dev/null | grep -q ":$port "; then
            echo "$port"
            return 0
        fi
    fi
    
    return 1
}

check_container_conflicts() {
    local container_names=("cliproxyapi-caddy" "cliproxyapi" "cliproxyapi-dashboard" "cliproxyapi-docker-proxy" "cliproxyapi-postgres")
    local conflicts=()
    
    # Only check if Docker is running
    if ! command -v docker &> /dev/null; then
        return 0
    fi
    
    if ! docker ps &> /dev/null 2>&1; then
        return 0
    fi
    
    for container in "${container_names[@]}"; do
        if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
            conflicts+=("$container")
        fi
    done
    
    if [ ${#conflicts[@]} -gt 0 ]; then
        printf '%s\n' "${conflicts[@]}"
    fi
}

check_postgres_url_reachability() {
    local database_url=$1
    local scheme_and_rest=${database_url%%://*}
    if [[ "$scheme_and_rest" != "postgres" && "$scheme_and_rest" != "postgresql" ]]; then
        log_error "Invalid PostgreSQL URL scheme"
        return 1
    fi

    local url_without_scheme=${database_url#*://}
    local authority=${url_without_scheme%%/*}
    authority=${authority%%\?*}
    authority=${authority%%#*}
    authority=${authority##*@}

    if [ -z "$authority" ]; then
        log_error "DATABASE_URL must include a hostname"
        return 1
    fi

    local host=""
    local port="5432"

    if [[ "$authority" == \[*\]* ]]; then
        host=${authority#\[}
        host=${host%%\]*}

        local remainder=${authority#*\]}
        if [[ "$remainder" == :* ]]; then
            port=${remainder#:}
        fi
    else
        if [[ "$authority" == *:* ]]; then
            host=${authority%:*}
            port=${authority##*:}
        else
            host=$authority
        fi
    fi

    host=${host%%\?*}
    host=${host%%#*}
    port=${port%%\?*}
    port=${port%%#*}

    if [ -z "$host" ]; then
        log_error "DATABASE_URL must include a hostname"
        return 1
    fi

    if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        log_error "DATABASE_URL must include a valid PostgreSQL port"
        return 1
    fi

    local resolved_host
    if ! resolved_host=$(getent ahosts "$host" 2>/dev/null | while read -r address _; do
        if [ -n "$address" ]; then
            printf '%s\n' "$address"
            break
        fi
    done); then
        resolved_host=""
    fi

    if [ -z "$resolved_host" ]; then
        log_error "Cannot resolve PostgreSQL hostname '$host'"
        return 1
    fi

    if ! timeout 5 bash -c '</dev/tcp/"$1"/"$2"' _ "$host" "$port" 2>/dev/null; then
        log_error "Cannot reach PostgreSQL server at $host:$port"
        return 1
    fi

    local validation_output="${host}:${port}"

    log_success "External database host reachable at $validation_output"
    log_info "Reachability preflight checks host/port connectivity only; credentials, TLS, and schema compatibility are validated later by the application/runtime."
    return 0
}

escape_compose_env_value() {
    local value=$1

    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//$/\\$}
    value=${value//$'\n'/\\n}
    value=${value//$'\r'/\\r}

    printf '"%s"' "$value"
}

write_env_assignment() {
    local file_path=$1
    local key=$2
    local value=$3

    printf '%s=%s\n' "$key" "$(escape_compose_env_value "$value")" >> "$file_path"
}

read_env_value() {
    local file_path=$1
    local key=$2

    python3 - "$file_path" "$key" <<'PY'
import shlex
import sys

file_path, key = sys.argv[1], sys.argv[2]

try:
    with open(file_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            current_key, raw_value = line.split("=", 1)
            if current_key != key:
                continue
            parsed = shlex.split(raw_value, posix=True)
            if not parsed:
                print("")
            else:
                print(parsed[0])
            break
except FileNotFoundError:
    pass
PY
}

validate_kept_env_db_mode() {
    local env_file=$1
    local db_mode=$2

    case "$db_mode" in
        external)
            local existing_database_url
            existing_database_url=$(read_env_value "$env_file" "DATABASE_URL")

            if [ -z "$existing_database_url" ]; then
                log_error "Existing .env uses DB_MODE=external but DATABASE_URL is empty or missing. Refusing to continue with a kept .env because installer-managed outputs would not match a usable external database configuration. Set DATABASE_URL in $env_file or rerun and overwrite the .env file."
                exit 1
            fi
            ;;
        docker)
            local existing_postgres_password
            local existing_database_url
            local expected_database_url

            existing_postgres_password=$(read_env_value "$env_file" "POSTGRES_PASSWORD")
            existing_database_url=$(read_env_value "$env_file" "DATABASE_URL")

            if [ -z "$existing_postgres_password" ]; then
                log_error "Existing .env uses DB_MODE=docker but POSTGRES_PASSWORD is empty or missing. Refusing to continue with a kept .env because installer-managed startup and runtime output expect the compose-managed postgres service credentials to remain defined. Set POSTGRES_PASSWORD in $env_file or rerun and overwrite the .env file."
                exit 1
            fi

            expected_database_url="postgresql://cliproxyapi:${existing_postgres_password}@postgres:5432/cliproxyapi"
            if [ "$existing_database_url" != "$expected_database_url" ]; then
                log_error "Existing .env uses DB_MODE=docker but DATABASE_URL does not match the compose-managed postgres configuration expected by the installer. Expected DATABASE_URL to be '$expected_database_url'. Update $env_file to keep docker-managed database settings coherent or rerun and overwrite the .env file."
                exit 1
            fi
            ;;
        *)
            log_error "Unsupported DB_MODE '$db_mode' found in existing .env"
            exit 1
            ;;
    esac
}

user_crontab_exists() {
    crontab -l >/dev/null 2>&1
}

remove_backup_cron_entry() {
    local cron_comment=$1
    shift
    local backup_script_path=$1
    local rotate_backups_script_path=$2
    local current_crontab
    local cleaned_crontab

    if ! user_crontab_exists; then
        return 1
    fi

    current_crontab=$(mktemp)
    cleaned_crontab=$(mktemp)
    trap 'rm -f "$current_crontab" "$cleaned_crontab"' RETURN

    crontab -l > "$current_crontab"

    if python3 - "$current_crontab" "$cleaned_crontab" "$cron_comment" "$backup_script_path" "$rotate_backups_script_path" <<'PY'
import sys

source_path, dest_path, cron_comment = sys.argv[1], sys.argv[2], sys.argv[3]
backup_script_path, rotate_backups_script_path = sys.argv[4], sys.argv[5]
legacy_comment = f"# {cron_comment}"

with open(source_path, "r", encoding="utf-8") as source_file:
    lines = source_file.readlines()

cleaned_lines = []
skip_next = False
removed = False

for line in lines:
    stripped = line.rstrip("\n")

    if skip_next:
        skip_next = False
        if backup_script_path in stripped and rotate_backups_script_path in stripped:
            removed = True
            continue
        cleaned_lines.append(line)
        continue

    if stripped == legacy_comment:
        skip_next = True
        continue

    cleaned_lines.append(line)

with open(dest_path, "w", encoding="utf-8") as dest_file:
    dest_file.writelines(cleaned_lines)

sys.exit(0 if removed else 1)
PY
    then

        crontab "$cleaned_crontab"
    else
        return 1
    fi
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "This script must be run as root (use sudo)"
    exit 1
fi

# Detect installer source directory (where script is located)
INSTALLER_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="/opt/cliproxyapi"
RUNTIME_CONFIG_DIR="$RUNTIME_ROOT/config"
RUNTIME_INFRA_DIR="$RUNTIME_ROOT/infrastructure"
RUNTIME_METADATA_DIR="$RUNTIME_ROOT/metadata"
RUNTIME_SCRIPTS_DIR="$RUNTIME_ROOT/scripts"
RUNTIME_BACKUPS_DIR="$RUNTIME_ROOT/backups"
RUNTIME_COMPOSE_FILE="$RUNTIME_ROOT/docker-compose.yml"
RUNTIME_CONFIG_FILE="$RUNTIME_CONFIG_DIR/config.yaml"
RUNTIME_CADDY_FILE="$RUNTIME_CONFIG_DIR/Caddyfile"
ENV_FILE="$RUNTIME_ROOT/.env"
INSTALL_INFO_FILE="$RUNTIME_METADATA_DIR/install-info.env"
GITHUB_REPOSITORY="$(resolve_github_repository)"
GITHUB_REF="$(resolve_github_fetch_ref)"
GITHUB_RAW_BASE_URL="https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_REF}"

log_info "Installer source directory: $INSTALLER_SOURCE_DIR"
log_info "Runtime root: $RUNTIME_ROOT"

# Check if running on Ubuntu/Debian
if ! command -v apt-get &> /dev/null; then
    log_error "This script only supports Ubuntu/Debian systems"
    exit 1
fi

# Detect Linux distribution for installer validation
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO_ID="${ID:-}"
else
    log_error "Cannot detect Linux distribution (/etc/os-release not found)"
    exit 1
fi

# Validate distro
case "$DISTRO_ID" in
    ubuntu)
        ;;
    debian)
        ;;
    *)
        log_error "Unsupported distribution: $DISTRO_ID (only Ubuntu and Debian supported)"
        exit 1
        ;;
esac

log_info "Detected distribution: $DISTRO_ID"

log_info "Starting CLIProxyAPI Stack installation..."
echo ""

# ============================================================================
# INTERACTIVE CONFIGURATION
# ============================================================================

log_info "=== Configuration ==="
echo ""

LOCAL_IP=$(detect_local_ip)

echo "  1) Domain + integrated Caddy"
echo "  2) No domain + Cloudflare Tunnel"
echo "  3) No domain + local IP only"
while true; do
    read -p "Select access mode [1-3]: " ACCESS_MODE_CHOICE
    case $ACCESS_MODE_CHOICE in
        1)
            ACCESS_MODE="domain"
            break
            ;;
        2)
            ACCESS_MODE="cloudflare"
            break
            ;;
        3)
            ACCESS_MODE="local"
            break
            ;;
        *)
            log_error "Invalid choice"
            ;;
    esac
done

DOMAIN=""
DASHBOARD_SUBDOMAIN=""
API_SUBDOMAIN=""
CLOUDFLARE_TUNNEL_TOKEN=""

if [ "$ACCESS_MODE" = "domain" ]; then
    while true; do
        read -p "Enter your domain (e.g., example.com): " DOMAIN
        if [ -z "$DOMAIN" ]; then
            log_error "Domain cannot be empty"
            continue
        fi
        if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
            log_error "Invalid domain format"
            continue
        fi
        break
    done

    read -p "Enter dashboard subdomain [default: dashboard]: " DASHBOARD_SUBDOMAIN
    DASHBOARD_SUBDOMAIN="${DASHBOARD_SUBDOMAIN:-dashboard}"

    read -p "Enter API subdomain [default: api]: " API_SUBDOMAIN
    API_SUBDOMAIN="${API_SUBDOMAIN:-api}"
elif [ "$ACCESS_MODE" = "cloudflare" ]; then
    while true; do
        read -r -p "Enter Cloudflare Tunnel token: " CLOUDFLARE_TUNNEL_TOKEN
        if [ -z "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
            log_error "Cloudflare Tunnel token cannot be empty"
            continue
        fi
        break
    done
fi

EXTERNAL_PROXY=0

# OAuth provider support
echo ""
read -p "Enable OAuth provider callbacks? [y/N]: " OAUTH_ENABLED
if [[ "$OAUTH_ENABLED" =~ ^[Yy]$ ]]; then
    OAUTH_ENABLED=1
else
    OAUTH_ENABLED=0
fi

# Perplexity Pro Sidecar support
echo ""
log_info "Perplexity Pro Sidecar provides an OpenAI-compatible API wrapper for Perplexity Pro subscriptions."
log_info "If enabled, it runs as a separate container alongside the stack."
read -p "Enable Perplexity Pro Sidecar? [y/N]: " PERPLEXITY_ENABLED_INPUT
if [[ "$PERPLEXITY_ENABLED_INPUT" =~ ^[Yy]$ ]]; then
    PERPLEXITY_ENABLED=1
else
    PERPLEXITY_ENABLED=0
fi

# Database mode selection
echo ""
log_info "Select production database mode:"
echo "  1) Docker-managed Postgres"
echo "  2) External/custom Postgres"
while true; do
    read -p "Enter choice [1-2]: " DB_MODE_CHOICE
    case $DB_MODE_CHOICE in
        1)
            DB_MODE="docker"
            DB_MODE_LABEL="Docker-managed Postgres"
            break
            ;;
        2)
            DB_MODE="external"
            DB_MODE_LABEL="external/custom Postgres"
            break
            ;;
        *)
            log_error "Invalid choice"
            ;;
    esac
done

if [ "$DB_MODE" = "external" ]; then
    echo ""
    log_info "Enter the full PostgreSQL connection string for the production dashboard/runtime."
    log_info "Example: postgresql://user:password@db.example.com:5432/cliproxyapi"
    while true; do
        read -r -p "External DATABASE_URL: " DATABASE_URL
        if [ -z "$DATABASE_URL" ]; then
            log_error "DATABASE_URL cannot be empty"
            continue
        fi
        if [[ ! "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
            log_error "DATABASE_URL must start with postgres:// or postgresql://"
            continue
        fi
        log_info "Running external database reachability preflight..."
        if ! check_postgres_url_reachability "$DATABASE_URL"; then
            log_error "External DATABASE_URL preflight failed. Fix the connection details or network access before continuing."
            continue
        fi
        break
    done
else
    DATABASE_URL=""
fi

# Backup interval
echo ""
log_info "Select backup interval:"
echo "  1) Daily backups (keep last 7)"
echo "  2) Weekly backups (keep last 4)"
echo "  3) No automated backups"
while true; do
    read -p "Enter choice [1-3]: " BACKUP_CHOICE
    case $BACKUP_CHOICE in
        1)
            BACKUP_INTERVAL="daily"
            BACKUP_RETENTION=7
            break
            ;;
        2)
            BACKUP_INTERVAL="weekly"
            BACKUP_RETENTION=4
            break
            ;;
        3)
            BACKUP_INTERVAL="none"
            BACKUP_RETENTION=0
            break
            ;;
        *)
            log_error "Invalid choice"
            ;;
    esac
done

if [ "$DB_MODE" = "external" ] && [ "$BACKUP_INTERVAL" != "none" ]; then
    log_warning "Installer-managed automated backups currently support only Docker-managed Postgres."
    log_warning "Disabling automated backup scheduling for external/custom Postgres mode."
    BACKUP_INTERVAL="none"
    BACKUP_RETENTION=0
fi

SKIP_ENV=0

if [ -f "$ENV_FILE" ]; then
    log_warning ".env file already exists"
    read -p "Overwrite .env file? [y/N]: " OVERWRITE_ENV
    if [[ ! "$OVERWRITE_ENV" =~ ^[Yy]$ ]]; then
        log_info "Keeping existing .env file"
        SKIP_ENV=1

        EXISTING_DB_MODE=$(read_env_value "$ENV_FILE" "DB_MODE")
        if [ -n "$EXISTING_DB_MODE" ] && [ "$EXISTING_DB_MODE" != "$DB_MODE" ]; then
            log_warning "Existing .env DB_MODE is '$EXISTING_DB_MODE'; overriding interactive selection '$DB_MODE' for installer-managed outputs"
            DB_MODE="$EXISTING_DB_MODE"
            if [ "$DB_MODE" = "docker" ]; then
                DB_MODE_LABEL="Docker-managed Postgres"
            elif [ "$DB_MODE" = "external" ]; then
                DB_MODE_LABEL="external/custom Postgres"
                BACKUP_INTERVAL="none"
                BACKUP_RETENTION=0
            else
                log_error "Unsupported DB_MODE '$DB_MODE' found in existing .env"
                exit 1
            fi
        elif [ -z "$EXISTING_DB_MODE" ]; then
            log_error "Existing .env does not define DB_MODE. Refusing to continue with a kept .env because installer-managed outputs could disagree with runtime configuration. Add DB_MODE to $ENV_FILE or rerun and overwrite the .env file."
            exit 1
        fi

        validate_kept_env_db_mode "$ENV_FILE" "$DB_MODE"
    fi
fi

if [ "$ACCESS_MODE" = "domain" ]; then
    DASHBOARD_URL="https://${DASHBOARD_SUBDOMAIN}.${DOMAIN}"
    API_URL="https://${API_SUBDOMAIN}.${DOMAIN}"
    CLIPROXYAPI_BIND_ADDRESS="127.0.0.1"
    DASHBOARD_BIND_ADDRESS="127.0.0.1"
    COMPOSE_PROFILES_VALUE="caddy"
elif [ "$ACCESS_MODE" = "cloudflare" ]; then
    DASHBOARD_URL="http://${LOCAL_IP}:8318"
    API_URL="http://${LOCAL_IP}:8317"
    CLIPROXYAPI_BIND_ADDRESS="0.0.0.0"
    DASHBOARD_BIND_ADDRESS="0.0.0.0"
    COMPOSE_PROFILES_VALUE="cloudflare"
else
    DASHBOARD_URL="http://${LOCAL_IP}:8318"
    API_URL="http://${LOCAL_IP}:8317"
    CLIPROXYAPI_BIND_ADDRESS="0.0.0.0"
    DASHBOARD_BIND_ADDRESS="0.0.0.0"
    COMPOSE_PROFILES_VALUE=""
fi

echo ""
log_info "Configuration summary:"
log_info "  Access mode: $ACCESS_MODE"
log_info "  Local IP: $LOCAL_IP"
if [ "$ACCESS_MODE" = "domain" ]; then
    log_info "  Domain: $DOMAIN"
    log_info "  Dashboard: ${DASHBOARD_SUBDOMAIN}.${DOMAIN}"
    log_info "  API: ${API_SUBDOMAIN}.${DOMAIN}"
elif [ "$ACCESS_MODE" = "cloudflare" ]; then
    log_info "  Cloudflare Tunnel: enabled"
    log_info "  Cloudflare Tunnel runtime: docker compose profile"
else
    log_info "  Cloudflare Tunnel: disabled"
fi
log_info "  OAuth callbacks: $([ $OAUTH_ENABLED -eq 1 ] && echo 'enabled' || echo 'disabled')"
log_info "  Perplexity Sidecar: $([ $PERPLEXITY_ENABLED -eq 1 ] && echo 'enabled' || echo 'disabled')"
log_info "  Database mode: $DB_MODE_LABEL"
log_info "  Backup interval: $BACKUP_INTERVAL"
echo ""

read -p "Continue with installation? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    log_warning "Installation cancelled"
    exit 0
fi

echo ""

# ============================================================================
# PREFLIGHT CONFLICT CHECKS
# ============================================================================

log_info "=== Preflight Conflict Detection ==="
echo ""

# Define required ports per access mode
REQUIRED_PORTS=()
if [ "$ACCESS_MODE" = "domain" ]; then
    REQUIRED_PORTS+=(80 443)
else
    REQUIRED_PORTS+=(8317)
    REQUIRED_PORTS+=(8318)
fi
if [ $OAUTH_ENABLED -eq 1 ]; then
    REQUIRED_PORTS+=(8085 1455 54545 51121 11451)
fi

# Check for port conflicts
if [ "$ACCESS_MODE" = "domain" ]; then
    log_info "Domain mode: checking ports 80/443 and any enabled OAuth callback ports..."
else
    log_info "No-domain mode: checking ports 8317/8318 and any enabled OAuth callback ports..."
fi
PORT_CONFLICTS=()
for port in "${REQUIRED_PORTS[@]}"; do
    if conflict_port=$(check_port_conflict "$port"); then
        PORT_CONFLICTS+=("$conflict_port")
        log_warning "Port $port is already in use"
    fi
done

# Check for container conflicts
log_info "Checking for existing container names..."
CONTAINER_CONFLICTS=($(check_container_conflicts))
if [ ${#CONTAINER_CONFLICTS[@]} -gt 0 ]; then
    log_warning "Found existing containers with names that may conflict:"
    for container in "${CONTAINER_CONFLICTS[@]}"; do
        log_warning "  - $container"
    done
fi

# If conflicts found, ask for confirmation
if [ ${#PORT_CONFLICTS[@]} -gt 0 ] || [ ${#CONTAINER_CONFLICTS[@]} -gt 0 ]; then
    echo ""
    log_warning "=== CONFLICTS DETECTED ==="
    
    if [ ${#PORT_CONFLICTS[@]} -gt 0 ]; then
        echo "The following ports are already in use (required for this stack):"
        for port in "${PORT_CONFLICTS[@]}"; do
            echo "  - Port $port"
        done
        echo ""
    fi
    
    if [ ${#CONTAINER_CONFLICTS[@]} -gt 0 ]; then
        echo "The following Docker containers already exist:"
        for container in "${CONTAINER_CONFLICTS[@]}"; do
            echo "  - $container"
        done
        echo ""
    fi
    
    log_warning "These conflicts may cause installation to fail or disrupt existing services."
    read -p "Continue anyway? [y/N]: " OVERRIDE_CONFLICTS
    if [[ ! "$OVERRIDE_CONFLICTS" =~ ^[Yy]$ ]]; then
        log_error "Installation cancelled due to conflicts"
        echo ""
        log_info "To resolve conflicts, you may need to:"
        if [ ${#PORT_CONFLICTS[@]} -gt 0 ]; then
            echo "  - Stop other services using the conflicting ports"
            echo "  - Reconfigure this installation to use different ports"
        fi
        if [ ${#CONTAINER_CONFLICTS[@]} -gt 0 ]; then
            echo "  - Remove or rename existing containers (docker rename, docker rm)"
            echo "  - Use a different installation location/prefix"
        fi
        exit 1
    fi
    
    log_warning "Proceeding despite conflicts - installation may fail"
    echo ""
fi

# ============================================================================
# DOCKER INSTALLATION
# ============================================================================

log_info "=== Docker Installation ==="
echo ""

DOCKER_PRESENT=0
COMPOSE_PRESENT=0

if command -v docker &> /dev/null; then
    DOCKER_PRESENT=1
    DOCKER_VERSION=$(docker --version)
    log_success "Docker already installed: $DOCKER_VERSION"
fi

if [ $DOCKER_PRESENT -eq 1 ] && docker compose version &> /dev/null; then
    COMPOSE_PRESENT=1
    COMPOSE_VERSION=$(docker compose version)
    log_success "Docker Compose already installed: $COMPOSE_VERSION"
fi

if [ $DOCKER_PRESENT -eq 0 ] || [ $COMPOSE_PRESENT -eq 0 ]; then
    if [ $DOCKER_PRESENT -eq 1 ]; then
        log_warning "Docker is installed but 'docker compose' is missing; repairing Docker installation via get.docker.com..."
    else
        log_info "Installing Docker via get.docker.com..."
    fi

    apt-get update
    apt-get install -y ca-certificates curl
    curl -sSL https://get.docker.com | sh

    if ! command -v docker &> /dev/null; then
        log_error "Docker installation completed but 'docker' command was not found"
        exit 1
    fi

    if ! docker compose version &> /dev/null; then
        log_error "Docker installation completed but 'docker compose' is not available"
        exit 1
    fi

    DOCKER_VERSION=$(docker --version)
    COMPOSE_VERSION=$(docker compose version)
    log_success "Docker installed successfully: $DOCKER_VERSION"
    log_success "Docker Compose available: $COMPOSE_VERSION"
else
    DOCKER_VERSION=$(docker --version)
    COMPOSE_VERSION=$(docker compose version)
fi

if ! command -v docker &> /dev/null; then
    log_error "Docker is required but was not found after installation checks"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    log_error "Docker Compose v2 is required but is not available"
    exit 1
fi

DOCKER_VERSION=$(docker --version)
COMPOSE_VERSION=$(docker compose version)
log_info "Verified Docker: $DOCKER_VERSION"
log_info "Verified Docker Compose: $COMPOSE_VERSION"

ensure_runtime_directories
fetch_runtime_bundle
validate_runtime_compose_template

echo ""

# ============================================================================
# UFW FIREWALL CONFIGURATION
# ============================================================================

log_info "=== UFW Firewall Configuration ==="
echo ""

if ! command -v ufw &> /dev/null; then
    log_info "Installing UFW..."
    apt-get install -y ufw
fi

# Check if UFW is active
UFW_STATUS=$(ufw status | head -n 1)

if [[ "$UFW_STATUS" == *"inactive"* ]]; then
    log_info "Configuring UFW rules..."
    
    # SSH first to prevent lockout
    log_info "Allowing SSH (port 22) to prevent lockout..."
    ufw limit 22/tcp comment 'SSH with rate limiting'
    
    # HTTP/HTTPS (skip if using external reverse proxy)
    if [ "$ACCESS_MODE" = "domain" ]; then
        log_info "Allowing HTTP/HTTPS (ports 80, 443)..."
        ufw allow 80/tcp comment 'HTTP'
        ufw allow 443/tcp comment 'HTTPS'
        ufw allow 443/udp comment 'HTTP/3 (QUIC)'
    else
        log_info "Allowing direct dashboard/API access (ports 8318, 8317)..."
        ufw allow 8318/tcp comment 'CLIProxyAPI Dashboard'
        ufw allow 8317/tcp comment 'CLIProxyAPI API'
    fi
    
    # OAuth callback ports (conditional)
    if [ $OAUTH_ENABLED -eq 1 ]; then
        log_info "Allowing OAuth callback ports..."
        ufw allow 8085/tcp comment 'CLIProxyAPI OAuth callback 1'
        ufw allow 1455/tcp comment 'CLIProxyAPI OAuth callback 2'
        ufw allow 54545/tcp comment 'CLIProxyAPI OAuth callback 3'
        ufw allow 51121/tcp comment 'CLIProxyAPI OAuth callback 4'
        ufw allow 11451/tcp comment 'CLIProxyAPI OAuth callback 5'
    fi
    
    # Enable UFW
    log_warning "Enabling UFW firewall..."
    echo "y" | ufw enable
    
    log_success "UFW configured and enabled"
else
    log_warning "UFW already active, checking rules..."
    
    # Add missing rules if needed
    RULES_ADDED=0
    
    # Helper function to check and add rule
    add_rule_if_missing() {
        local PORT=$1
        local PROTO=$2
        local COMMENT=$3
        
        if ! ufw status | grep -q "$PORT/$PROTO"; then
            ufw allow "$PORT/$PROTO" comment "$COMMENT"
            log_info "Added rule: $PORT/$PROTO"
            RULES_ADDED=1
        fi
    }
    
    add_rule_if_missing 22 tcp "SSH with rate limiting"
    if [ "$ACCESS_MODE" = "domain" ]; then
        add_rule_if_missing 80 tcp "HTTP"
        add_rule_if_missing 443 tcp "HTTPS"
        add_rule_if_missing 443 udp "HTTP/3 (QUIC)"
    else
        add_rule_if_missing 8318 tcp "CLIProxyAPI Dashboard"
        add_rule_if_missing 8317 tcp "CLIProxyAPI API"
    fi
    
    # OAuth callback ports (conditional)
    if [ $OAUTH_ENABLED -eq 1 ]; then
        add_rule_if_missing 8085 tcp "CLIProxyAPI OAuth callback 1"
        add_rule_if_missing 1455 tcp "CLIProxyAPI OAuth callback 2"
        add_rule_if_missing 54545 tcp "CLIProxyAPI OAuth callback 3"
        add_rule_if_missing 51121 tcp "CLIProxyAPI OAuth callback 4"
        add_rule_if_missing 11451 tcp "CLIProxyAPI OAuth callback 5"
    fi
    
    if [ $RULES_ADDED -eq 0 ]; then
        log_success "All required UFW rules already configured"
    else
        ufw reload
        log_success "UFW rules updated"
    fi
fi

echo ""

# ============================================================================
# SECRET GENERATION
# ============================================================================

log_info "=== Secret Generation ==="
echo ""

JWT_SECRET=$(openssl rand -base64 32)
MANAGEMENT_API_KEY=$(openssl rand -hex 32)
COLLECTOR_API_KEY=$(openssl rand -hex 32)
PROVIDER_ENCRYPTION_KEY=$(openssl rand -hex 32)

if [ "$DB_MODE" = "docker" ]; then
    POSTGRES_PASSWORD=$(openssl rand -hex 32)
    DATABASE_URL="postgresql://cliproxyapi:${POSTGRES_PASSWORD}@postgres:5432/cliproxyapi"
else
    POSTGRES_PASSWORD=""
fi

# Registry-backed production compose defaults to published images in the normal
# install path. Keep the installer contract minimal by exposing only tag
# overrides through the runtime bundle .env.
DASHBOARD_IMAGE_TAG="latest"
PERPLEXITY_SIDECAR_IMAGE_TAG="latest"

if [ $PERPLEXITY_ENABLED -eq 1 ]; then
    PERPLEXITY_SIDECAR_SECRET=$(openssl rand -hex 32)
fi

log_success "Secrets generated"

echo ""

# ============================================================================
# ENVIRONMENT FILE CONFIGURATION
# ============================================================================

log_info "=== Environment Configuration ==="
echo ""

if [ $SKIP_ENV -eq 0 ]; then
    log_info "Creating .env file..."

    cat > "$ENV_FILE" << EOF
# CLIProxyAPI Stack Environment Configuration
# Generated by install.sh on $(date)

# Access configuration
ACCESS_MODE=$ACCESS_MODE
LOCAL_IP=$LOCAL_IP
DOMAIN=$DOMAIN
DASHBOARD_SUBDOMAIN=$DASHBOARD_SUBDOMAIN
API_SUBDOMAIN=$API_SUBDOMAIN

# Database configuration
DB_MODE=$DB_MODE

EOF

    write_env_assignment "$ENV_FILE" "DATABASE_URL" "$DATABASE_URL"

    if [ "$DB_MODE" = "docker" ]; then
        cat >> "$ENV_FILE" << EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
    else
        cat >> "$ENV_FILE" << EOF
# External/custom Postgres selected during install.
# POSTGRES_PASSWORD is intentionally omitted because the production compose-managed
# Postgres container is not the intended database for this install mode.
EOF
    fi

    cat >> "$ENV_FILE" << EOF

# Dashboard secrets
JWT_SECRET=$JWT_SECRET
MANAGEMENT_API_KEY=$MANAGEMENT_API_KEY
COLLECTOR_API_KEY=$COLLECTOR_API_KEY
PROVIDER_ENCRYPTION_KEY=$PROVIDER_ENCRYPTION_KEY

# Management API URL
CLIPROXYAPI_MANAGEMENT_URL=http://cliproxyapi:8317/v0/management

# Registry image tags
# Override these only if you need a specific published release instead of the
# default latest tag.
DASHBOARD_IMAGE_TAG=$DASHBOARD_IMAGE_TAG
PERPLEXITY_SIDECAR_IMAGE_TAG=$PERPLEXITY_SIDECAR_IMAGE_TAG

# Access-mode compose settings
CLIPROXYAPI_BIND_ADDRESS=$CLIPROXYAPI_BIND_ADDRESS
DASHBOARD_BIND_ADDRESS=$DASHBOARD_BIND_ADDRESS
COMPOSE_PROFILES=$COMPOSE_PROFILES_VALUE

# Installation directory (host path for volume mounts)
INSTALL_DIR=$RUNTIME_ROOT

# Timezone
TZ=UTC

# Logging
LOG_LEVEL=info

# Full URLs (for reference)
DASHBOARD_URL=$DASHBOARD_URL
API_URL=$API_URL
EOF

    if [ "$ACCESS_MODE" = "cloudflare" ]; then
        write_env_assignment "$ENV_FILE" "CLOUDFLARE_TUNNEL_TOKEN" "$CLOUDFLARE_TUNNEL_TOKEN"
    fi

    # Perplexity Sidecar (conditional)
    if [ $PERPLEXITY_ENABLED -eq 1 ]; then
        PERPLEXITY_COMPOSE_PROFILES="$COMPOSE_PROFILES_VALUE"
        if [ -n "$PERPLEXITY_COMPOSE_PROFILES" ]; then
            PERPLEXITY_COMPOSE_PROFILES="$PERPLEXITY_COMPOSE_PROFILES,perplexity"
        else
            PERPLEXITY_COMPOSE_PROFILES="perplexity"
        fi

        cat >> "$ENV_FILE" << EOF

# Perplexity Pro Sidecar
COMPOSE_PROFILES=$PERPLEXITY_COMPOSE_PROFILES
PERPLEXITY_SIDECAR_SECRET=$PERPLEXITY_SIDECAR_SECRET
EOF
    fi
    
    chmod 600 "$ENV_FILE"
    write_install_metadata
    validate_runtime_compose_with_env
    log_success ".env file created"
elif [ -f "$ENV_FILE" ]; then
    write_install_metadata
    validate_runtime_compose_with_env
fi

echo ""

# ============================================================================
# SYSTEMD SERVICE INSTALLATION
# ============================================================================

log_info "=== Systemd Service Installation ==="
echo ""

SERVICE_FILE="/etc/systemd/system/cliproxyapi-stack.service"

if [ -f "$SERVICE_FILE" ]; then
    log_warning "Systemd service already exists"
    read -p "Overwrite service file? [y/N]: " OVERWRITE_SERVICE
    if [[ ! "$OVERWRITE_SERVICE" =~ ^[Yy]$ ]]; then
        log_info "Keeping existing service file"
        SKIP_SERVICE=1
    else
        SKIP_SERVICE=0
    fi
else
    SKIP_SERVICE=0
fi

if [ $SKIP_SERVICE -eq 0 ]; then
    log_info "Creating systemd service to restore the compose stack on boot..."

    # Always name startup services explicitly so boot-time reconciliation honors
    # the chosen reverse-proxy mode consistently.
    # NOTE: when services are listed explicitly on the command line Docker Compose
    # does NOT auto-start profiled services from COMPOSE_PROFILES, so
    # perplexity-sidecar must also be listed here when it is enabled.
    # Keep postgres in the explicit service list for both DB modes. In external DB
    # mode the bundled postgres container remains an inert dependency placeholder
    # because dashboard still depends on the postgres service at runtime.
    COMPOSE_SERVICES="postgres docker-proxy cliproxyapi dashboard"
    if [ "$ACCESS_MODE" = "domain" ]; then
        COMPOSE_SERVICES="caddy $COMPOSE_SERVICES"
    fi
    if [ $PERPLEXITY_ENABLED -eq 1 ]; then
        COMPOSE_SERVICES="$COMPOSE_SERVICES perplexity-sidecar"
    fi

    COMPOSE_START_CMD="/usr/bin/docker compose --env-file $RUNTIME_ROOT/.env -f $RUNTIME_ROOT/docker-compose.yml up -d --wait $COMPOSE_SERVICES"
    if [ "$ACCESS_MODE" = "domain" ]; then
        COMPOSE_DESC="(with integrated Caddy, access mode: $ACCESS_MODE, database mode: $DB_MODE; bundled postgres remains present/inert in external mode)"
    else
        COMPOSE_DESC="(without Caddy, access mode: $ACCESS_MODE, database mode: $DB_MODE; bundled postgres remains present/inert in external mode)"
    fi
    log_info "Systemd compose command: $COMPOSE_START_CMD $COMPOSE_DESC"

    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=CLIProxyAPI Stack (Docker Compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=$RUNTIME_ROOT
ExecStart=$COMPOSE_START_CMD
ExecStop=/usr/bin/docker compose --env-file $RUNTIME_ROOT/.env -f $RUNTIME_ROOT/docker-compose.yml down
TimeoutStartSec=300
TimeoutStopSec=120

# Restart policy for the systemd wrapper itself. Container restart behavior stays
# defined in compose via `restart: unless-stopped`.
Restart=on-failure
RestartSec=10s

# Security
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd and enable service
    systemctl daemon-reload
    systemctl enable cliproxyapi-stack.service
    
    log_success "Systemd service installed and enabled for automatic stack startup on boot"
fi

echo ""

# ============================================================================
# SCRIPTS INSTALLATION
# ============================================================================

log_info "=== Backup/Restore Scripts Setup ==="
echo ""

SCRIPTS_DIR="$RUNTIME_SCRIPTS_DIR"

if [ ! -d "$SCRIPTS_DIR" ] || [ ! -f "$SCRIPTS_DIR/backup.sh" ]; then
    log_error "Scripts directory not found at $SCRIPTS_DIR"
    log_error "Runtime bundle scripts were not fetched correctly"
    exit 1
fi

chmod +x "$SCRIPTS_DIR/backup.sh"
chmod +x "$SCRIPTS_DIR/restore.sh"
chmod +x "$SCRIPTS_DIR/rotate-backups.sh"

if [ "$DB_MODE" = "external" ]; then
    log_info "Backup helper scripts remain available in $SCRIPTS_DIR for Docker-managed Postgres installs only."
    log_warning "Manual backup/restore helper scripts are not supported when using an external/custom PostgreSQL server."
else
    log_success "Backup/restore scripts ready in $SCRIPTS_DIR"
fi

echo ""

# ============================================================================
# CRON JOB SETUP (if backup interval selected)
# ============================================================================

if [ "$BACKUP_INTERVAL" != "none" ]; then
    log_info "=== Automated Backup Setup ==="
    echo ""
    
    # Determine cron schedule
    if [ "$BACKUP_INTERVAL" == "daily" ]; then
        CRON_SCHEDULE="0 2 * * *"  # 2 AM daily
        CRON_COMMENT="CLIProxyAPI daily backup"
    else
        CRON_SCHEDULE="0 2 * * 0"  # 2 AM Sunday
        CRON_COMMENT="CLIProxyAPI weekly backup"
    fi
    
    # Check if cron job already exists
    if crontab -l 2>/dev/null | grep -q "$SCRIPTS_DIR/backup.sh"; then
        log_warning "Backup cron job already exists"
    else
        log_info "Installing backup cron job ($BACKUP_INTERVAL)..."
        
        # Add cron job
        (crontab -l 2>/dev/null || true; echo "# $CRON_COMMENT"; echo "$CRON_SCHEDULE $SCRIPTS_DIR/backup.sh >> $RUNTIME_BACKUPS_DIR/backup.log 2>&1 && $SCRIPTS_DIR/rotate-backups.sh $BACKUP_RETENTION >> $RUNTIME_BACKUPS_DIR/backup.log 2>&1") | crontab -
        
        log_success "Backup cron job installed (runs $BACKUP_INTERVAL at 2 AM)"
    fi
    
    echo ""
elif [ "$DB_MODE" = "external" ]; then
    log_info "Skipping installer-managed automated backups for external/custom Postgres mode."
    log_info "Current backup/restore helper scripts target only the compose-managed postgres container."
    log_info "Checking for an old installer-managed backup cron entry to remove..."

    if user_crontab_exists; then
        REMOVED_BACKUP_CRON_ENTRIES=0

        if remove_backup_cron_entry "CLIProxyAPI daily backup" "$SCRIPTS_DIR/backup.sh" "$SCRIPTS_DIR/rotate-backups.sh"; then
            REMOVED_BACKUP_CRON_ENTRIES=$((REMOVED_BACKUP_CRON_ENTRIES + 1))
        fi

        if remove_backup_cron_entry "CLIProxyAPI weekly backup" "$SCRIPTS_DIR/backup.sh" "$SCRIPTS_DIR/rotate-backups.sh"; then
            REMOVED_BACKUP_CRON_ENTRIES=$((REMOVED_BACKUP_CRON_ENTRIES + 1))
        fi

        if [ "$REMOVED_BACKUP_CRON_ENTRIES" -gt 0 ]; then
            log_success "Removed $REMOVED_BACKUP_CRON_ENTRIES installer-managed backup cron entr$( [ "$REMOVED_BACKUP_CRON_ENTRIES" -eq 1 ] && printf 'y' || printf 'ies' ) because external/custom Postgres mode is active"
        else
            log_info "No installer-managed backup cron entry found to remove"
        fi
    else
        log_info "No user crontab found; no installer-managed backup cron entry needed cleanup"
    fi

    echo ""
fi

# ============================================================================
# USAGE COLLECTOR SCHEDULER
# ============================================================================

log_info "=== Usage Collector Scheduler ==="
echo ""

log_info "Periodic usage collection is now handled by the dashboard app itself."
log_info "Checking for a legacy installer-managed usage collector cron entry to remove..."

if user_crontab_exists; then
    CURRENT_CRONTAB=$(mktemp)
    CLEANED_CRONTAB=$(mktemp)
    trap 'rm -f "$CURRENT_CRONTAB" "$CLEANED_CRONTAB"' EXIT

    crontab -l > "$CURRENT_CRONTAB"

    if grep -q "# CLIProxyAPI usage collector (every 5 minutes)" "$CURRENT_CRONTAB"; then
        python3 - "$CURRENT_CRONTAB" "$CLEANED_CRONTAB" <<'PY'
import sys

source_path, dest_path = sys.argv[1], sys.argv[2]
legacy_comment = "# CLIProxyAPI usage collector (every 5 minutes)"

with open(source_path, "r", encoding="utf-8") as source_file:
    lines = source_file.readlines()

cleaned_lines = []
skip_next = False

for line in lines:
    if skip_next:
        skip_next = False
        if "/api/usage/collect" in line:
            continue
        cleaned_lines.append(line)
        continue

    if line.rstrip("\n") == legacy_comment:
        skip_next = True
        continue

    cleaned_lines.append(line)

with open(dest_path, "w", encoding="utf-8") as dest_file:
    dest_file.writelines(cleaned_lines)
PY

        crontab "$CLEANED_CRONTAB"

        log_success "Removed only the legacy installer-managed usage collector cron entry; periodic collection is handled internally by the dashboard app"
    else
        log_info "No legacy installer-managed usage collector cron entry found; custom external POST /api/usage/collect calls remain supported"
    fi

    rm -f "$CURRENT_CRONTAB" "$CLEANED_CRONTAB"
    trap - EXIT
else
    log_info "No user crontab found; no legacy installer-managed usage collector cron entry needed cleanup"
fi

echo ""

# ============================================================================
# EXTERNAL PROXY MODE SETUP
# ============================================================================

ROOT_OVERRIDE_CREATED_BY_INSTALLER=0

if [ "$ACCESS_MODE" = "domain" ]; then
    echo ""
    log_info "=== Integrated Caddy Setup ==="
    echo ""
    log_info "Runtime Caddy template fetched to $RUNTIME_CADDY_FILE"
    log_info "Bundled Caddy remains the only supported domain-mode reverse proxy in this installer flow."
    echo ""
fi

# ============================================================================
# CADDY INTEGRATION (if external proxy mode)
# ============================================================================



# ============================================================================
# FINAL STEPS
# ============================================================================

log_info "=== Installation Complete ==="
echo ""

log_success "CLIProxyAPI Stack installation completed successfully!"
echo ""
log_info "Next steps:"
echo "  1. Start the stack:"
echo "     sudo systemctl start cliproxyapi-stack"
echo ""
echo "  2. Check status:"
echo "     sudo systemctl status cliproxyapi-stack"
echo ""
echo "  3. View logs:"
echo "     cd $RUNTIME_ROOT"
echo "     docker compose --env-file .env -f docker-compose.yml logs -f"
echo ""
echo "  4. Local IP: $LOCAL_IP"
if [ "$ACCESS_MODE" = "cloudflare" ]; then
    echo "     Dashboard local URL: http://${LOCAL_IP}:8318"
    echo "     API local URL: http://${LOCAL_IP}:8317"
    echo ""
    echo "  5. Cloudflare Tunnel origin targets:"
    echo "     Dashboard origin target: http://${LOCAL_IP}:8318"
    echo "     API origin target: http://${LOCAL_IP}:8317"
    echo "     Configure your Cloudflare hostnames to point to those origin targets."
    echo ""
elif [ "$ACCESS_MODE" = "local" ]; then
    echo "     Dashboard: http://${LOCAL_IP}:8318"
    echo "     API: http://${LOCAL_IP}:8317"
    echo ""
else
    echo "     Domain URLs:"
    echo "     Dashboard: https://${DASHBOARD_SUBDOMAIN}.${DOMAIN}"
    echo "     API: https://${API_SUBDOMAIN}.${DOMAIN}"
    echo ""
fi
echo "  5. Create your admin account at the dashboard, then configure"
echo "     API keys and providers through the Configuration page."
echo ""
log_info "Backup commands:"
if [ "$DB_MODE" = "external" ]; then
    echo "  Manual backup:  unsupported for external/custom Postgres installs"
    echo "  Restore:        unsupported for external/custom Postgres installs"
    echo "                  use your external database platform's native backup/restore workflow"
elif [ "$BACKUP_INTERVAL" != "none" ]; then
    echo "  Manual backup:  $SCRIPTS_DIR/backup.sh"
    echo "  Restore:        $SCRIPTS_DIR/restore.sh <backup_file>"
    echo "  Automated:      $BACKUP_INTERVAL backups at 2 AM (keep last $BACKUP_RETENTION)"
else
    echo "  Manual backup:  $SCRIPTS_DIR/backup.sh"
    echo "  Restore:        $SCRIPTS_DIR/restore.sh <backup_file>"
fi
if [ "$DB_MODE" = "external" ]; then
    echo "  Automated:      disabled for external/custom Postgres installs"
    echo "                  (current helper scripts only support compose-managed postgres)"
fi
echo ""
log_warning "Secrets are stored in: $ENV_FILE"
log_warning "Install metadata is stored in: $INSTALL_INFO_FILE"
echo ""
