#!/usr/bin/env bash
set -euo pipefail
cd /opt/sixseven-service
exec 9>.deploy.lock
flock 9
[[ $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a commit SHA'; exit 2; }
# registry.env contains REGISTRY=<region>-docker.pkg.dev/<project>/<repository>
source ./registry.env
revision=$1
previous=$(cat deployed-sha 2>/dev/null || true)
set_images() {
  export BACKEND_IMAGE="$REGISTRY/backend:$1"
  export FRONTEND_IMAGE="$REGISTRY/frontend:$1"
  export INFERENCE_IMAGE="$REGISTRY/inference:$1"
}
set_images "$revision"
# Pull all images successfully before touching running containers.
docker compose -f compose.yaml -f deploy/compose.yaml pull
if docker compose ps --status running --services | grep -qx backend; then
  docker compose exec -T backend python - < scripts/backup_db.py
fi
if docker compose -f compose.yaml -f deploy/compose.yaml up -d --no-build --wait --wait-timeout 120 && curl --fail --silent http://127.0.0.1:8080/api/ready >/dev/null; then
  printf '%s\n' "$revision" > deployed-sha
  echo 'Deployment healthy'
else
  if [[ -n "$previous" ]]; then
    set_images "$previous"
    docker compose -f compose.yaml -f deploy/compose.yaml up -d --no-build --wait --wait-timeout 120
    echo 'Previous images restored; database was not reset'
  fi
  exit 1
fi
