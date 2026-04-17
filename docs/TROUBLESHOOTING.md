# Troubleshooting

← [Back to README](../README.md)

## Services Not Starting

**Check systemd status:**
```bash
sudo systemctl status cliproxyapi-stack
```

**Check Docker container status:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml ps
```

**View logs:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f
```

## Database Connection Errors

### Password Authentication Failed (error code 28P01)

If you see an error like:
```
error: password authentication failed for user "cliproxyapi"
  severity: 'FATAL',
  code: '28P01',
```

This is almost always caused by a **password mismatch** between your `infrastructure/.env` file and what PostgreSQL was initialized with.

> **Important**: PostgreSQL only reads `POSTGRES_PASSWORD` during **first-time initialization** (when the data volume is empty). If you change the password in `infrastructure/.env` after the database has already been created, PostgreSQL will still use the old password — but the dashboard will try to connect with the new one.

> **External/custom DB mode**: If your production install uses an external/custom PostgreSQL instance, ignore the bundled `postgres` container troubleshooting below. The production Compose stack keeps that bundled service inert in external DB mode, and password resets/backups must be handled on the external database itself.

**Fix — Option 1: Reset the volume** (easiest, destroys all data):
```bash
# Local setup
docker compose -f docker-compose.local.yml down -v
./setup-local.sh          # macOS/Linux
.\setup-local.ps1         # Windows

# Server setup
docker compose --env-file infrastructure/.env -f docker-compose.yml down -v
sudo systemctl start cliproxyapi-stack
```

**Fix — Option 2: Update PostgreSQL password** (preserves data):
```bash
# 1. Find the current password in your production env file
grep POSTGRES_PASSWORD infrastructure/.env

# 2. Connect to PostgreSQL with the OLD password and change it
docker compose --env-file infrastructure/.env -f docker-compose.yml exec postgres psql -U cliproxyapi -d cliproxyapi -c \
  "ALTER USER cliproxyapi PASSWORD 'YOUR_NEW_PASSWORD_FROM_ENV';"
```
If you don't know the old password, use option 1.

**Fix — Option 3: Revert `infrastructure/.env` to the original password**:
If you accidentally changed `POSTGRES_PASSWORD` in `infrastructure/.env`, revert it to the value that was originally generated, then restart the stack.

### General Database Connectivity

**Verify PostgreSQL is healthy:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml ps postgres
docker compose --env-file infrastructure/.env -f docker-compose.yml exec postgres pg_isready -U cliproxyapi
```

**Check credentials in `infrastructure/.env`:**
```bash
grep -E 'POSTGRES_PASSWORD|DATABASE_URL' infrastructure/.env
```

**Verify the password in `DATABASE_URL` matches `POSTGRES_PASSWORD`:**
The `DATABASE_URL` contains the password inline: `postgresql://cliproxyapi:<password>@postgres:5432/cliproxyapi`. If you set these manually, ensure both values use the same password.
## OAuth Callbacks Failing

**Verify firewall rules:**
```bash
sudo ufw status numbered
```

**Test OAuth port accessibility from external network:**
```bash
nc -zv YOUR_SERVER_IP 8085
nc -zv YOUR_SERVER_IP 1455
# ... test other OAuth ports
```

**Check CLIProxyAPIPlus logs:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml logs -f cliproxyapi
```

## TLS Certificate Issues

**Check Caddy logs:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml logs caddy
```

**Verify DNS records:**
```bash
dig dashboard.example.com
dig api.example.com
```

**Common causes:**
- DNS records not propagated yet (wait 5-15 minutes)
- Firewall blocking ports 80/443
- Domain not pointing to correct IP
- Rate limit hit (Let's Encrypt has rate limits)

## Port Already in Use

**Find process using port:**
```bash
sudo lsof -i :80
sudo lsof -i :443
```

**Stop conflicting services:**
```bash
sudo systemctl stop nginx    # If using nginx
sudo systemctl stop apache2  # If using apache
```

## Dashboard Not Loading

**Check all services are healthy:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml ps
```

**Verify dashboard logs:**
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml logs dashboard
```

**Common issues:**
- Database not initialized (run `npx prisma migrate deploy` in container)
- JWT_SECRET not set in `infrastructure/.env`
- Dashboard container can't reach PostgreSQL

## Can't Login to Dashboard

There are no default credentials. The setup flow is:

1. **First Visit**: Navigate to `https://dashboard.yourdomain.com`
2. **Auto-Redirect**: You'll be redirected to `/setup` automatically
3. **Create Account**: Enter username and password to create the first admin user
4. **Setup Locked**: After first user is created, `/setup` becomes inaccessible

**If you forgot your password**, reset via the database:
```bash
docker compose --env-file infrastructure/.env -f docker-compose.yml exec postgres psql -U cliproxyapi -d cliproxyapi -c "DELETE FROM users;"
```
Then visit `/setup` again to create a new admin account.

**If setup page is not accessible**, it means an admin account already exists. Use your credentials to log in at the main login page.
