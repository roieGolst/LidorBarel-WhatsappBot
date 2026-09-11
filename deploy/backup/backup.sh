#!/bin/sh
# Nightly Postgres backup: a custom-format dump (pg_restore can restore it
# selectively), kept locally for a week and copied to S3. S3 retention is a
# bucket lifecycle rule, not this script — see docs/GO-LIVE.md.
#
# Postgres is the single source of truth for every lead and conversation;
# Monday is a projection. This job is the only thing standing between a dead
# disk and losing them. Do not disable it.
set -eu

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="/backups/${PGDATABASE}-${STAMP}.dump"

pg_dump --format=custom --no-owner --file "$FILE" "$PGDATABASE"
aws s3 cp "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")" --only-show-errors

# Local copies are a convenience for a quick restore; S3 is the real archive.
find /backups -name '*.dump' -mtime +7 -delete

echo "backup: $(basename "$FILE") ($(du -h "$FILE" | cut -f1)) uploaded"
