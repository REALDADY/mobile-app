#!/usr/bin/env bash
# RS Water driver platform — guided VPS deploy (run as root on srv1653947).
# One database: the website's PostgreSQL (alrawdah_db). The driver backend gets its own
# schema/role `driver_ops` and reads/marks orders through the website's dispatch API.
#
# Usage:  bash deploy-driver-platform.sh <phase>
# Phases, in order (each is safe to re-run and stops instead of guessing):
#   check     read-only: shows what was found, changes nothing
#   backup    pg_dump alrawdah_db + tar of the website backend
#   website   install the dispatch router into the live website, rebuild, restart
#   database  create role + schema driver_ops (prints the generated password once)
#   backend   clone/update rswater-driver-api, write .env, start with PM2 on 127.0.0.1:5100
#   nginx     driver-api.rswater.ae server block + Let's Encrypt (DNS must point here first)
#   verify    end-to-end checks
set -euo pipefail

PHASE="${1:-check}"
REPO_URL="https://github.com/REALDADY/mobile-app.git"
REPO_BRANCH="driver-dispatch"
APP_DIR="/var/www/rswater-driver-api"
FILES_DIR="/var/lib/rswater-driver-api/files"
APP_NAME="rswater-driver-api"
APP_PORT=5100
DOMAIN="driver-api.rswater.ae"
DB_NAME="alrawdah_db"
WEBSITE_PORT=4001
BACKUP_DIR="/var/backups/driver-platform-$(date +%Y%m%d-%H%M%S)"
STATE_FILE="/root/.driver-platform-deploy.env"   # remembers detected paths between phases (root-only)

say()  { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local a; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed"; }

[[ $EUID -eq 0 ]] || die "run as root"
touch "$STATE_FILE"; chmod 600 "$STATE_FILE"
# shellcheck disable=SC1090
source "$STATE_FILE"
remember() { grep -v "^$1=" "$STATE_FILE" > "$STATE_FILE.tmp" || true; printf '%s=%q\n' "$1" "$2" >> "$STATE_FILE.tmp"; mv "$STATE_FILE.tmp" "$STATE_FILE"; chmod 600 "$STATE_FILE"; }

detect_website() {
  # The website backend is whatever PM2 process listens on 127.0.0.1:$WEBSITE_PORT.
  local pid cwd
  pid=$(ss -ltnp "sport = :$WEBSITE_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  [[ -n "$pid" ]] || die "nothing listens on port $WEBSITE_PORT — is the website backend running?"
  cwd=$(readlink -f "/proc/$pid/cwd")
  # Walk up to the folder that has package.json + src/app.ts (the website backend source).
  local d="$cwd"
  while [[ "$d" != "/" ]]; do
    if [[ -f "$d/package.json" && -f "$d/src/app.ts" ]]; then break; fi
    d=$(dirname "$d")
  done
  [[ -f "$d/src/app.ts" ]] || die "found the website process (pid $pid, cwd $cwd) but no src/app.ts above it — tell Claude this path"
  WEBSITE_BACKEND_DIR="$d"
  WEBSITE_PM2_NAME=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const p=JSON.parse(s||"[]").find(x=>x.pid==process.argv[1]);console.log(p?p.name:"")})' "$pid" || true)
  remember WEBSITE_BACKEND_DIR "$WEBSITE_BACKEND_DIR"
  remember WEBSITE_PM2_NAME "$WEBSITE_PM2_NAME"
}

case "$PHASE" in
check)
  say "Read-only check"
  need node; need pm2; need psql; need nginx
  echo "node $(node -v), $(psql --version)"
  detect_website
  echo "website backend dir : $WEBSITE_BACKEND_DIR"
  echo "website PM2 process : ${WEBSITE_PM2_NAME:-<not found in pm2>}"
  grep -q "dispatchReadRouter" "$WEBSITE_BACKEND_DIR/src/app.ts" && echo "dispatch router     : already mounted" || echo "dispatch router     : not installed yet"
  sudo -u postgres psql -Atc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 && echo "database            : $DB_NAME found" || die "database $DB_NAME not found"
  sudo -u postgres psql -d "$DB_NAME" -Atc "select 1 from pg_roles where rolname='driver_ops'" | grep -q 1 && echo "driver_ops role     : exists" || echo "driver_ops role     : not created yet"
  [[ -d "$APP_DIR/.git" ]] && echo "driver backend      : $APP_DIR ($(git -C "$APP_DIR" rev-parse --short HEAD))" || echo "driver backend      : not installed"
  ss -ltn "sport = :$APP_PORT" | grep -q LISTEN && echo "port $APP_PORT          : IN USE" || echo "port $APP_PORT          : free"
  getent hosts "$DOMAIN" >/dev/null && echo "DNS $DOMAIN : $(getent hosts "$DOMAIN" | awk '{print $1}')" || echo "DNS $DOMAIN : not resolving yet"
  ;;

backup)
  [[ -n "${WEBSITE_BACKEND_DIR:-}" ]] || detect_website
  say "Backups → $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  sudo -u postgres pg_dump -Fc "$DB_NAME" > "$BACKUP_DIR/$DB_NAME.dump"
  tar --exclude=node_modules -czf "$BACKUP_DIR/website-backend.tgz" -C "$(dirname "$WEBSITE_BACKEND_DIR")" "$(basename "$WEBSITE_BACKEND_DIR")"
  ls -lh "$BACKUP_DIR"
  remember LAST_BACKUP_DIR "$BACKUP_DIR"
  ;;

website)
  [[ -n "${WEBSITE_BACKEND_DIR:-}" ]] || detect_website
  [[ -n "${LAST_BACKUP_DIR:-}" ]] || die "run the backup phase first"
  say "Install dispatch router into $WEBSITE_BACKEND_DIR"
  tmp=$(mktemp -d); git clone -q --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$tmp/repo"
  src="$tmp/repo/deploy/website-dispatch/dispatchRead.ts"
  [[ -f "$src" ]] || die "router file missing in repo"
  [[ -f "$WEBSITE_BACKEND_DIR/src/db/pool.ts" || -f "$WEBSITE_BACKEND_DIR/src/db/pool.js" ]] || die "website has no src/db/pool — layout differs from expected, stop"
  cp "$src" "$WEBSITE_BACKEND_DIR/src/routes/dispatchRead.ts"
  APP_TS="$WEBSITE_BACKEND_DIR/src/app.ts"
  if ! grep -q "dispatchReadRouter" "$APP_TS"; then
    grep -q "^// ─── RATE LIMITING" "$APP_TS" || die "could not find the RATE LIMITING marker in app.ts — apply app.ts.edit.md by hand"
    sed -i "0,/^import .* from '\.\/routes\/[^']*'$/s//&\nimport dispatchReadRouter from '.\/routes\/dispatchRead'/" "$APP_TS"
    sed -i "s|^// ─── RATE LIMITING|// Driver/dispatch feed: GET is loopback-or-key gated, writes need DISPATCH_WRITE_KEY (or loopback).\napp.use('/api/dispatch', dispatchReadRouter)\n\n&|" "$APP_TS"
  fi
  grep -n "dispatchRead" "$APP_TS"
  grep -q "trust proxy" "$APP_TS" || die "website app.ts has no 'trust proxy' — public requests could look local; stop"
  # Write key shared with the driver backend.
  ENVF="$WEBSITE_BACKEND_DIR/.env"
  if ! grep -q "^DISPATCH_WRITE_KEY=" "$ENVF" 2>/dev/null; then
    key=$(openssl rand -hex 32); printf '\nDISPATCH_WRITE_KEY=%s\n' "$key" >> "$ENVF"; remember DISPATCH_WRITE_KEY "$key"
  else
    remember DISPATCH_WRITE_KEY "$(grep '^DISPATCH_WRITE_KEY=' "$ENVF" | cut -d= -f2-)"
  fi
  say "Build + restart website"
  (cd "$WEBSITE_BACKEND_DIR" && npm run build)
  if [[ -n "${WEBSITE_PM2_NAME:-}" ]]; then pm2 restart "$WEBSITE_PM2_NAME" --update-env; else die "website PM2 name unknown — restart it yourself, then re-run 'verify'"; fi
  sleep 3
  curl -fsS "http://127.0.0.1:$WEBSITE_PORT/api/dispatch/overview" | head -c 200; echo
  rm -rf "$tmp"
  ;;

database)
  say "Role + schema driver_ops in $DB_NAME (least privilege)"
  if ! sudo -u postgres psql -d "$DB_NAME" -Atc "select 1 from pg_roles where rolname='driver_ops'" | grep -q 1; then
    pw=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -v pw="$pw" <<'SQL'
create role driver_ops login password :'pw';
SQL
    remember DRIVER_DB_PASSWORD "$pw"
  fi
  sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
grant connect on database $DB_NAME to driver_ops;
create schema if not exists driver_ops authorization driver_ops;
grant usage, create on schema driver_ops to driver_ops;
alter role driver_ops set search_path = driver_ops;
revoke all on schema public from driver_ops;
SQL
  sudo -u postgres psql -d "$DB_NAME" -Atc "select 'can read website orders: ' || has_table_privilege('driver_ops','public.orders','select')"
  ;;

backend)
  [[ -n "${DRIVER_DB_PASSWORD:-}" ]] || die "run the database phase first"
  [[ -n "${DISPATCH_WRITE_KEY:-}" ]] || die "run the website phase first"
  say "Driver backend → $APP_DIR"
  if [[ -d "$APP_DIR/.git" ]]; then git -C "$APP_DIR" fetch -q origin "$REPO_BRANCH" && git -C "$APP_DIR" checkout -q "$REPO_BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$REPO_BRANCH"
  else git clone -q -b "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"; fi
  mkdir -p "$FILES_DIR"; chmod 750 "$FILES_DIR"
  (cd "$APP_DIR" && npm ci --omit=dev)
  ENVF="$APP_DIR/.env"
  if [[ ! -f "$ENVF" ]]; then
    read -r -p "Driver login password (same as DRIVER_LOGIN_PASSWORD on the office PC): " -s dlp; echo
    admin=$(openssl rand -hex 32); drv=$(openssl rand -hex 32); sess=$(openssl rand -hex 48)
    cat > "$ENVF" <<ENV
NODE_ENV=production
PORT=$APP_PORT
HOST=127.0.0.1
API_BASE_URL=https://$DOMAIN
DRIVER_DATABASE_URL=postgresql://driver_ops:$DRIVER_DB_PASSWORD@127.0.0.1:5432/$DB_NAME
DRIVER_FILES_DIR=$FILES_DIR
WEBSITE_DISPATCH_URL=http://127.0.0.1:$WEBSITE_PORT/api/dispatch/overview
WEBSITE_DISPATCH_WRITE_BASE_URL=http://127.0.0.1:$WEBSITE_PORT/api/dispatch
WEBSITE_DISPATCH_WRITE_KEY=$DISPATCH_WRITE_KEY
DRIVER_LOGIN_USERNAME=driver
DRIVER_LOGIN_PASSWORD=$dlp
DRIVER_LOGIN_COUNT=7
DRIVER_LOGIN_NAME=Driver
DRIVER_SESSION_SECRET=$sess
ADMIN_API_KEY=$admin
DRIVER_API_KEY=$drv
FRONTEND_ALLOWED_ORIGINS=https://rswater.ae
INVOICE_COMPANY_NAME=RS Water
ENV
    chmod 600 "$ENVF"
    echo; echo "Console key (put in the office PC's map/.env.local as RSWATER_OPERATIONS_API_KEY and RSWATER_WEBSITE_DISPATCH_KEY):"
    echo "  $drv"
  fi
  (cd "$APP_DIR" && set -a && . ./.env && set +a && node scripts/apply-driver-schema.js && node scripts/check-driver-schema.js)
  pm2 describe "$APP_NAME" >/dev/null 2>&1 && pm2 restart "$APP_NAME" --update-env || pm2 start src/server.js --name "$APP_NAME" --cwd "$APP_DIR"
  pm2 save
  sleep 3; curl -fsS "http://127.0.0.1:$APP_PORT/api/health"; echo
  ;;

nginx)
  getent hosts "$DOMAIN" >/dev/null || die "DNS for $DOMAIN does not resolve yet — add an A record to 72.60.221.8 first"
  need certbot
  say "nginx server block for $DOMAIN"
  conf="/etc/nginx/sites-available/$APP_NAME"
  cat > "$conf" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 8m;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
NGINX
  ln -sf "$conf" "/etc/nginx/sites-enabled/$APP_NAME"
  nginx -t && systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m apps@rswater.ae
  echo; echo "Also add deploy/website-dispatch/nginx-block-public-dispatch.conf to the rswater.ae server block (see README), then: nginx -t && systemctl reload nginx"
  ;;

verify)
  say "Verify"
  curl -fsS "http://127.0.0.1:$WEBSITE_PORT/api/dispatch/overview" >/dev/null && echo "website feed (local)      : OK"
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://rswater.ae/api/dispatch/overview"); echo "website feed (public)     : $code (want 404 = blocked)"
  curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null && echo "driver backend (local)    : OK"
  curl -fsS "https://$DOMAIN/api/health" >/dev/null && echo "driver backend (public)   : OK"
  pm2 ls | grep -E "$APP_NAME|${WEBSITE_PM2_NAME:-website}" || true
  ;;

*) die "unknown phase '$PHASE' (check|backup|website|database|backend|nginx|verify)";;
esac
say "Phase '$PHASE' done"
