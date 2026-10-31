#!/usr/bin/env bash
set -euo pipefail

main() {
cd "$(dirname "$0")"

REF="${1:?usage: deploy.sh <commit-sha|origin/main|origin/development>}"
setting() { grep -m1 "^$1=" .env | cut -d= -f2- | tr -d '"' || true; }
IMAGE=$(setting API_IMAGE); IMAGE=${IMAGE:-hook-api}
APIS=$(setting API_SERVICES); APIS=${APIS:-api-1 api-2 api-3}
[[ "$REF" =~ ^([0-9a-f]{7,40}|origin/main|origin/development)$ ]] || { echo "refusing ref: $REF"; exit 2; }
git -C .. fetch --quiet origin
git -C .. checkout --quiet --force --detach "$REF"
echo "Deploying $(git -C .. log -1 --format='%h %s')"

sudo install -m 644 hook-firewall.service /etc/systemd/system/hook-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable --now hook-firewall

if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  docker tag "$IMAGE:latest" "$IMAGE:previous"
fi
docker compose build api-1
docker compose up -d redis rabbitmq

wait_healthy() {
  local id
  id=$(docker compose ps -q "$1")
  for _ in $(seq 1 45); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}

rollback() {
  echo "!! $1 did not become healthy; restoring the previous image"
  docker compose logs --tail=40 "$1" || true
  if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
    docker tag "$IMAGE:previous" "$IMAGE:latest"
    for s in $APIS worker consumer-payments consumer-orders consumer-fulfilment; do docker compose up -d --no-deps --force-recreate "$s"; done
  fi
  exit 1
}

for s in $APIS; do
  docker compose up -d --no-deps --force-recreate "$s"
  wait_healthy "$s" || rollback "$s"
  echo "ok  $s healthy"
done

docker compose up -d --no-deps --force-recreate worker consumer-payments consumer-orders consumer-fulfilment
[ "$(setting SKIP_NGINX)" = 1 ] || { docker compose up -d nginx && docker compose exec -T nginx nginx -s reload; }
docker image prune -f >/dev/null
echo "Deploy complete"
}

main "$@"
