# Backup and Restore

← [Back to README](../README.md)

## Create Backup

```bash
/opt/cliproxyapi/scripts/backup.sh
```

### What's Included

- PostgreSQL database dump
- CLIProxyAPIPlus configuration
- OAuth token storage
- Current runtime config.yaml

### Storage Location

Backups are stored in `/opt/cliproxyapi/backups/cliproxyapi_backup_YYYYMMDD_HHMMSS.tar.gz`

## Restore from Backup

```bash
/opt/cliproxyapi/scripts/restore.sh /opt/cliproxyapi/backups/cliproxyapi_backup_20260206_020000.tar.gz
```

The restore script will:

1. Stop all services
2. Restore database from dump
3. Restore configuration files
4. Restore volumes
5. Restart services

## Automated Backups

Configured during installation via cron:

- **Daily**: 2 AM every day, keeps last 7 backups
- **Weekly**: 2 AM every Sunday, keeps last 4 backups

**View cron schedule:**

```bash
crontab -l
```

**View backup logs:**

```bash
tail -f /opt/cliproxyapi/backups/backup.log
```

> These helper scripts only support installs using the bundled Docker-managed PostgreSQL service (`DB_MODE=docker`). If you use external/custom PostgreSQL, use your database platform's native backup and restore tooling.
