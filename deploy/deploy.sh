#!/usr/bin/env bash
# Deploys the current checkout: build the image, apply migrations, restart the
# app. Run from the repository root on the server, after `git pull`.
#
# Migrations run BEFORE the new app starts, in a one-off container, so a failed
# migration leaves the old app running rather than a new app on an old schema.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

test -f .env || { echo "deploy: no .env — copy deploy/env.production.example and fill it in" >&2; exit 1; }

echo "deploy: building image"
$COMPOSE build --pull app backup

echo "deploy: starting postgres + redis"
# --wait blocks on the postgres healthcheck. On a fresh volume Postgres spends
# several seconds in initdb, and the migration below runs with --no-deps, so
# without this the very first deploy fails to connect and aborts.
$COMPOSE up -d --wait postgres redis

echo "deploy: applying migrations"
$COMPOSE run --rm --no-deps app node dist/db/migrate.js

echo "deploy: starting app, caddy, backup"
$COMPOSE up -d

docker image prune -f >/dev/null
echo "deploy: done —"
$COMPOSE ps
