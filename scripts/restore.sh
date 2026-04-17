#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/infrastructure/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

normalize_env_value() {
    local value="$1"

    if [ "${#value}" -ge 2 ]; then
        local first_char="${value:0:1}"
        local last_char="${value: -1}"

        if { [ "$first_char" = '"' ] || [ "$first_char" = "'" ]; } && [ "$first_char" = "$last_char" ]; then
            value="${value:1:${#value}-2}"
        fi
    fi

    printf '%s' "$value"
}

read_env_value() {
    local env_file="$1"
    local key="$2"
    local line

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "${key}="*)
                normalize_env_value "${line#*=}"
                return 0
                ;;
        esac
    done < "$env_file"

    return 1
}

if [ ! -f "$ENV_FILE" ]; then
    echo "[ERROR] Environment file not found: $ENV_FILE"
    exit 1
fi

DB_MODE="docker"
if db_mode_value=$(read_env_value "$ENV_FILE" "DB_MODE"); then
    DB_MODE="$db_mode_value"
fi

if [ "$DB_MODE" != "docker" ]; then
    echo "[ERROR] Restore helper only supports DB_MODE=docker compose-managed Postgres. Current DB_MODE=${DB_MODE:-unset}."
    echo "[ERROR] Use your external/custom PostgreSQL platform restore workflow instead."
    exit 1
fi

compose() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

find_auth_volume() {
    local volume_name

    while IFS= read -r volume_name; do
        case "$volume_name" in
            *cliproxyapi_auths*)
                printf '%s\n' "$volume_name"
                return 0
                ;;
        esac
    done < <(docker volume ls --format '{{.Name}}')

    return 1
}

if [ $# -ne 1 ]; then
    echo "[ERROR] Usage: $0 <backup_file.tar.gz>"
    echo ""
    echo "Available backups:"
    ls -lh "$PROJECT_DIR/backups" 2>/dev/null || echo "  No backups found"
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "[ERROR] Backup file not found: $BACKUP_FILE"
    exit 1
fi

echo "[WARNING] This will restore data from backup and overwrite current data!"
echo "[INFO] Backup file: $BACKUP_FILE"
read -p "Continue with restore? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "[INFO] Restore cancelled"
    exit 0
fi

TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "[INFO] Extracting backup..."
tar xzf "$BACKUP_FILE" -C "$TMP_DIR"

echo "[INFO] Stopping CLIProxyAPI stack..."
compose down

echo "[INFO] Starting Postgres for restore..."
compose up -d postgres
sleep 10

echo "[INFO] Restoring database..."
compose exec -T postgres psql -U cliproxyapi -d cliproxyapi -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null
compose exec -T postgres psql -U cliproxyapi -d cliproxyapi < "$TMP_DIR/database.sql"

echo "[INFO] Restoring config.yaml..."
cp "$TMP_DIR/config.yaml" "$PROJECT_DIR/infrastructure/config/config.yaml"

echo "[INFO] Restoring auth directory..."
if [ ! -f "$TMP_DIR/auth-dir.tar.gz" ]; then
    echo "[WARN] Auth backup archive not found, skipping auth restore"
elif ! AUTH_VOLUME=$(find_auth_volume); then
    echo "[WARN] Auth volume not found, skipping auth restore"
else
    docker run --rm \
        -v "$AUTH_VOLUME":/data \
        -v "$TMP_DIR":/backup \
        alpine sh -c "cd /data && rm -rf * && tar xzf /backup/auth-dir.tar.gz"
fi

echo "[INFO] Starting CLIProxyAPI stack..."
compose up -d --wait

echo "[SUCCESS] Restore completed successfully"
