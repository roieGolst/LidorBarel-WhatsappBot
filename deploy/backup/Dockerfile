# pg_dump + the AWS CLI, driven by cron. Dumps go to a local volume and to S3.
FROM postgres:16-alpine
RUN apk add --no-cache aws-cli tzdata
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
# The schedule is written from $BACKUP_CRON at start, then crond runs in the
# foreground so the container's life is the scheduler's.
CMD ["sh", "-c", "echo \"$BACKUP_CRON /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1\" > /etc/crontabs/root && echo 'backup: scheduled' && crond -f -l 8"]
