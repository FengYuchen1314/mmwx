#!/usr/bin/env bash
set -Eeuo pipefail

# This script is the forced command for the GitHub Actions deploy key. It
# updates only the controller image; bind-mounted configuration and data are
# never removed or recreated.
readonly APP_DIR=/opt/mmwx
readonly COMPOSE_FILE="$APP_DIR/compose.yaml"

test -f "$COMPOSE_FILE"

docker compose --project-directory "$APP_DIR" -f "$COMPOSE_FILE" pull controller
docker compose --project-directory "$APP_DIR" -f "$COMPOSE_FILE" up -d --no-deps controller
docker compose --project-directory "$APP_DIR" -f "$COMPOSE_FILE" ps controller
