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

for attempt in $(seq 1 30); do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mmwx-controller 2>/dev/null || true)
    case "$health" in
        healthy|running)
            docker compose --project-directory "$APP_DIR" -f "$COMPOSE_FILE" ps controller
            exit 0
            ;;
        unhealthy|exited|dead)
            docker logs --tail 100 mmwx-controller >&2 || true
            exit 1
            ;;
    esac
    sleep 2
done

docker logs --tail 100 mmwx-controller >&2 || true
echo "MMWX controller did not become healthy within 60 seconds." >&2
exit 1
