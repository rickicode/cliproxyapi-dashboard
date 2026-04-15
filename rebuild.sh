#!/bin/bash
# Rebuild dashboard locally and refresh pulled services
# Usage: ./rebuild.sh [--dashboard-only]

set -e

cd "$(dirname "$0")/infrastructure"

echo "=== CLIProxyAPI Dashboard Update ==="
echo ""

if [ "${1:-}" = "--dashboard-only" ]; then
    echo "[1/2] Building dashboard image..."
    docker compose build dashboard

    echo ""
    echo "[2/2] Recreating dashboard container..."
    docker compose up -d --no-deps dashboard
else
    echo "[1/4] Pulling latest images for non-build services..."
    docker compose pull --ignore-buildable

    echo ""
    echo "[2/4] Building dashboard image..."
    docker compose build dashboard

    echo ""
    echo "[3/4] Stopping and removing old containers..."
    docker compose down

    echo ""
    echo "[4/4] Starting fresh containers..."
    docker compose up -d
fi

echo ""
echo "=== Done! ==="
echo ""
echo "Checking container status..."
docker compose ps

echo ""
echo "View logs: cd infrastructure && docker compose logs -f"
