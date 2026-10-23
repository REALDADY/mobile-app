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
export PGCONNECT_TIMEOUT=15   # never hang on a database connection

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

session_url() { printf '%s' "$WEBSITE_DB_URL" | sed -E 's#:6543/#:5432/#'; }

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
  WEBSITE_DB_URL=$(grep -h '^DATABASE_URL=' "$WEBSITE_BACKEND_DIR/.env" | head -1 | cut -d= -f2-)
  [[ -n "$WEBSITE_DB_URL" ]] || die "website .env has no DATABASE_URL"
  remember WEBSITE_DB_URL "$WEBSITE_DB_URL"
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
  psql "$(session_url)" -Atc "select 'database            : '||current_database()||' on '||split_part(version(),' ',2)" || die "cannot connect to the website database"
  psql "$(session_url)" -Atc "select 1 from pg_roles where rolname='driver_ops'" | grep -q 1 && echo "driver_ops role     : exists" || echo "driver_ops role     : not created yet"
  [[ -d "$APP_DIR/.git" ]] && echo "driver backend      : $APP_DIR ($(git -C "$APP_DIR" rev-parse --short HEAD))" || echo "driver backend      : not installed"
  ss -ltn "sport = :$APP_PORT" | grep -q LISTEN && echo "port $APP_PORT          : IN USE" || echo "port $APP_PORT          : free"
  timeout 5 getent hosts "$DOMAIN" >/dev/null && echo "DNS $DOMAIN : $(getent hosts "$DOMAIN" | awk '{print $1}')" || echo "DNS $DOMAIN : not resolving yet"
  ;;

backup)
  [[ -n "${WEBSITE_BACKEND_DIR:-}" ]] || detect_website
  say "Backups → $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  pg_dump --schema-only --no-owner "$(session_url)" > "$BACKUP_DIR/website-db-schema.sql"
  tar --exclude=node_modules -czf "$BACKUP_DIR/website-backend.tgz" -C "$(dirname "$WEBSITE_BACKEND_DIR")" "$(basename "$WEBSITE_BACKEND_DIR")"
  ls -lh "$BACKUP_DIR"
  remember LAST_BACKUP_DIR "$BACKUP_DIR"
  ;;

website)
  [[ -n "${WEBSITE_BACKEND_DIR:-}" ]] || detect_website
  [[ -n "${LAST_BACKUP_DIR:-}" ]] || die "run the backup phase first"
  say "Install dispatch router into $WEBSITE_BACKEND_DIR"
  tmp=$(mktemp -d); git clone -q --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$tmp/repo"
  pkg="$tmp/repo/deploy/website-dispatch"
  [[ -f "$pkg/dispatchRead.ts" && -f "$pkg/createOrder.ts" ]] || die "router files missing in repo"
  [[ -f "$WEBSITE_BACKEND_DIR/src/db/pool.ts" || -f "$WEBSITE_BACKEND_DIR/src/db/pool.js" ]] || die "website has no src/db/pool — layout differs from expected, stop"
  # Keep copies of every file we touch so a failed type-check can be undone exactly.
  undo="$tmp/undo"; mkdir -p "$undo"
  for f in src/routes/dispatchRead.ts src/services/createOrder.ts src/app.ts; do
    [[ -f "$WEBSITE_BACKEND_DIR/$f" ]] && { mkdir -p "$undo/$(dirname "$f")"; cp -p "$WEBSITE_BACKEND_DIR/$f" "$undo/$f"; }
  done
  restore() {
    for f in src/routes/dispatchRead.ts src/services/createOrder.ts src/app.ts; do
      if [[ -f "$undo/$f" ]]; then cp -p "$undo/$f" "$WEBSITE_BACKEND_DIR/$f"; else rm -f "$WEBSITE_BACKEND_DIR/$f"; fi
    done
  }
  if [[ -f "$WEBSITE_BACKEND_DIR/src/services/createOrder.ts" ]] && ! cmp -s "$pkg/createOrder.ts" "$WEBSITE_BACKEND_DIR/src/services/createOrder.ts"; then
    die "the live website already has a different src/services/createOrder.ts — not overwriting it"
  fi
  cp "$pkg/dispatchRead.ts" "$WEBSITE_BACKEND_DIR/src/routes/dispatchRead.ts"
  cp "$pkg/createOrder.ts" "$WEBSITE_BACKEND_DIR/src/services/createOrder.ts"
  APP_TS="$WEBSITE_BACKEND_DIR/src/app.ts"
  if ! grep -q "dispatchReadRouter" "$APP_TS"; then
    # CRLF-aware edit: import after the last ./routes/ import, mount just before the RATE LIMITING block.
    python3 - "$APP_TS" <<'PY' || { restore; die "could not place the dispatch router in app.ts — files restored"; }
import re, sys
p = sys.argv[1]; s = open(p, newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
lines = s.split(nl)
idx = max(i for i, l in enumerate(lines) if re.match(r"^import .* from '\./routes/[^']*'\s*;?\s*$", l))
lines.insert(idx + 1, "import dispatchReadRouter from './routes/dispatchRead'")
j = next(i for i, l in enumerate(lines) if l.startswith('// \u2500\u2500\u2500 RATE LIMITING'))
lines[j:j] = ["// Driver/dispatch feed: GET is loopback-or-key gated, writes need DISPATCH_WRITE_KEY (or loopback).",
              "app.use('/api/dispatch', dispatchReadRouter)", ""]
open(p, 'w', newline='').write(nl.join(lines))
PY
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
  say "Type-check before building (the running website is not touched if this fails)"
  if ! (cd "$WEBSITE_BACKEND_DIR" && npx --no-install tsc --noEmit -p .); then
    restore; die "type-check failed against the live website code — files restored, website unchanged. Send Claude the errors above."
  fi
  say "Build + restart website"
  (cd "$WEBSITE_BACKEND_DIR" && npm run build)
  if [[ -n "${WEBSITE_PM2_NAME:-}" ]]; then pm2 restart "$WEBSITE_PM2_NAME" --update-env; else die "website PM2 name unknown — restart it yourself, then re-run 'verify'"; fi
  sleep 3
  curl -fsS "http://127.0.0.1:$WEBSITE_PORT/api/dispatch/overview" | head -c 200; echo
  rm -rf "$tmp"
  ;;

database)
  [[ -n "${WEBSITE_DB_URL:-}" ]] || detect_website
  say "Role + schema driver_ops in the website database (least privilege)"
  DBU="$(session_url)"
  if ! psql "$DBU" -Atc "select 1 from pg_roles where rolname='driver_ops'" | grep -q 1; then
    pw=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
    psql "$DBU" -v ON_ERROR_STOP=1 -v pw="$pw" <<'SQL'
create role driver_ops login password :'pw';
SQL
    remember DRIVER_DB_PASSWORD "$pw"
  fi
  psql "$DBU" -v ON_ERROR_STOP=1 <<'SQL'
grant connect on database postgres to driver_ops;
-- PostgreSQL 16+: the creator must be able to SET ROLE to the schema owner.
grant driver_ops to postgres;
create schema if not exists driver_ops authorization driver_ops;
grant usage, create on schema driver_ops to driver_ops;
alter role driver_ops set search_path = driver_ops;
revoke all on schema public from driver_ops;
SQL
  psql "$DBU" -Atc "select 'driver_ops can read website orders: ' || has_table_privilege('driver_ops','public.orders','select') || ' · can create in public: ' || has_schema_privilege('driver_ops','public','create')"
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
    [[ -n "${WEBSITE_DB_URL:-}" ]] || detect_website
    # Same Supabase pooler as the website, but logging in as the limited driver_ops role.
    ddu=$(printf '%s' "$WEBSITE_DB_URL" | sed -E 's#://postgres\.([a-z0-9]+):[^@]*@#://driver_ops.\1:'"$DRIVER_DB_PASSWORD"'@#')
    [[ "$ddu" == *"://driver_ops."* ]] || die "could not derive the driver_ops database URL from the website DATABASE_URL"
    cat > "$ENVF" <<ENV
NODE_ENV=production
PORT=$APP_PORT
HOST=127.0.0.1
API_BASE_URL=https://$DOMAIN
DRIVER_DATABASE_URL=$ddu
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
