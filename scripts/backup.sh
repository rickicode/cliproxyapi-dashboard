#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="cliproxyapi_backup_${TIMESTAMP}.tar.gz"
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
    echo "[ERROR] Backup helper only supports DB_MODE=docker compose-managed Postgres. Current DB_MODE=${DB_MODE:-unset}."
    echo "[ERROR] Use your external/custom PostgreSQL platform backup workflow instead."
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

mkdir -p "$BACKUP_DIR"

echo "[INFO] Starting backup at $(date)"
echo "[INFO] Backup location: $BACKUP_DIR/$BACKUP_FILE"

TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "[INFO] Backing up Postgres database..."
compose exec -T postgres pg_dump -U cliproxyapi -d cliproxyapi > "$TMP_DIR/database.sql"

echo "[INFO] Backing up config.yaml..."
cp "$PROJECT_DIR/infrastructure/config/config.yaml" "$TMP_DIR/config.yaml"

echo "[INFO] Backing up auth directory..."
AUTH_ARCHIVE_ARGS=()
if AUTH_VOLUME=$(find_auth_volume); then
    docker run --rm \
        -v "$AUTH_VOLUME":/data:ro \
        -v "$TMP_DIR":/backup \
        alpine tar czf /backup/auth-dir.tar.gz -C /data .
    AUTH_ARCHIVE_ARGS+=(auth-dir.tar.gz)
else
    echo "[WARN] Auth volume not found, skipping auth backup"
fi

echo "[INFO] Creating backup archive..."
cd "$TMP_DIR"
tar czf "$BACKUP_DIR/$BACKUP_FILE" database.sql config.yaml "${AUTH_ARCHIVE_ARGS[@]}"

echo "[SUCCESS] Backup completed: $BACKUP_DIR/$BACKUP_FILE"
echo "[INFO] Backup size: $(du -h "$BACKUP_DIR/$BACKUP_FILE" | cut -f1)"
