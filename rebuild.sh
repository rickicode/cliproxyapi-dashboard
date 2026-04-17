#!/bin/bash
# Refresh non-buildable images and rebuild the local dashboard image.
# Usage: ./rebuild.sh [--dashboard-only|--full-recreate]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/infrastructure/.env"

compose() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

MODE="rolling"

case "${1:-}" in
    "" )
        ;;
    --dashboard-only)
        MODE="dashboard-only"
        ;;
    --full-recreate)
        MODE="full-recreate"
        ;;
    -h|--help)
        echo "Usage: ./rebuild.sh [--dashboard-only|--full-recreate]"
        echo ""
        echo "Modes:"
        echo "  default           Pull non-buildable images, rebuild the dashboard image from the local checkout,"
        echo "                    then run 'docker compose up -d --wait'. Unaffected services stay up and there"
        echo "                    is no full stack tear-down."
        echo "  --dashboard-only  Rebuild the dashboard image from the local checkout and recreate only the"
        echo "                    dashboard container with 'docker compose up -d --wait --no-deps dashboard'."
        echo "                    CLIProxyAPI continuity is preserved because the proxy is untouched."
        echo "  --full-recreate   Pull non-buildable images, rebuild the dashboard image from the local checkout,"
        echo "                    then run 'docker compose down' followed by 'docker compose up -d --wait'."
        echo "                    This is destructive to runtime continuity and restarts the full stack."
        echo ""
        echo "Note: Only the dashboard image is rebuilt from local source. Optional buildable services such as"
        echo "      perplexity-sidecar are not rebuilt automatically by this script."
        exit 0
        ;;
    *)
        echo "Unknown option: ${1}"
        echo "Usage: ./rebuild.sh [--dashboard-only|--full-recreate]"
        exit 1
        ;;
esac

echo "=== CLIProxyAPI Dashboard Update ==="
echo ""

if [ "$MODE" = "dashboard-only" ]; then
    echo "Mode: dashboard-only"
    echo "This rebuilds the dashboard image from the current local checkout and only recreates the dashboard container."
    echo "Optional buildable services such as perplexity-sidecar are not rebuilt automatically by this script."
    echo "Update the repository contents first (for example with 'git pull') if you want newer dashboard code."
    echo ""

    echo "[1/2] Building dashboard image..."
    compose build dashboard

    echo ""
    echo "[2/2] Recreating dashboard container and waiting for compose readiness..."
    compose up -d --wait --no-deps dashboard
else
    if [ "$MODE" = "full-recreate" ]; then
        echo "Mode: full-recreate"
        echo "This pulls non-buildable images, rebuilds the dashboard image from the current local checkout,"
        echo "then stops and recreates the full stack. CLIProxyAPI continuity will be interrupted."
    else
        echo "Mode: rolling"
        echo "This pulls non-buildable images, rebuilds the dashboard image from the current local checkout,"
        echo "and applies updates in place with 'docker compose up -d --wait'."
        echo "Unaffected services stay up, but services with changed images may still be recreated individually."
    fi
    echo "Optional buildable services such as perplexity-sidecar are not rebuilt automatically by this script."
    echo "Update the repository contents first (for example with 'git pull') if you want newer dashboard code."
    echo ""

    echo "[1/3] Pulling latest images for non-build services..."
    compose pull --ignore-buildable

    echo ""
    echo "[2/3] Building dashboard image..."
    compose build dashboard

    echo ""
    if [ "$MODE" = "full-recreate" ]; then
        echo "[3/3] Stopping and removing old containers before fresh start..."
        compose down

        echo ""
        echo "Starting fresh containers and waiting for compose readiness..."
        compose up -d --wait
    else
        echo "[3/3] Applying updates without tearing down the full stack and waiting for compose readiness..."
        compose up -d --wait
    fi
fi

echo ""
echo "Verifying container status..."
compose ps

echo ""
echo "=== Update complete ==="
echo ""
echo "View logs: docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f"
