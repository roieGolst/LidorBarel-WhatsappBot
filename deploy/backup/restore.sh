#!/bin/sh
# Restores a dump into a database. Usage, from the host:
#
#   docker compose -f docker-compose.prod.yml exec backup restore.sh <file-or-s3-uri> [database]
#
# With no database given it restores over the live one — stop the app first.
# With one given (e.g. lidor_bot_restore_test) it creates that database and
# restores into it, which is how a backup is proven restorable without touching
# production. See docs/GO-LIVE.md.
set -eu

SOURCE="$1"
TARGET="${2:-$PGDATABASE}"

case "$SOURCE" in
  s3://*)
    LOCAL="/backups/$(basename "$SOURCE")"
    aws s3 cp "$SOURCE" "$LOCAL" --only-show-errors
    ;;
  *)
    LOCAL="$SOURCE"
    ;;
esac

if [ "$TARGET" != "$PGDATABASE" ]; then
  psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET\";" -c "CREATE DATABASE \"$TARGET\";"
fi

pg_restore --clean --if-exists --no-owner --dbname "$TARGET" "$LOCAL"
echo "restore: $(basename "$LOCAL") -> $TARGET"
psql -d "$TARGET" -Atc "select 'contacts: ' || count(*) from contacts union all select 'conversations: ' || count(*) from conversations union all select 'messages: ' || count(*) from messages;"
