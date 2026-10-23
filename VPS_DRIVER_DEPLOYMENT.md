# RS Water Driver API on the VPS (PostgreSQL mode)

This runs the driver backend (`backend/`) on the company VPS with **all of its own data in the website's
existing PostgreSQL database** and its files on the VPS disk. There is one database only: `alrawdah_db`.
The driver backend keeps its tables in a separate schema, `driver_ops`, owned by a separate login role
that **cannot read or change the website's tables**.

Orders and customers still come from the website through its dispatch API (unchanged):

- read: `WEBSITE_DISPATCH_URL` → `http://127.0.0.1:4001/api/dispatch/overview`
- write: `POST ${WEBSITE_DISPATCH_WRITE_BASE_URL}/orders/:id/complete` with the `x-dispatch-write-key` header

Supabase is not needed for the driver / dispatch features. Without `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, the legacy customer-app endpoints (products, OTP login, wallet, subscriptions,
payments, notifications, `/api/admin/orders`, ...) return
`503 { "error": "...", "code": "SUPABASE_NOT_CONFIGURED" }`. The office PC can keep running the Supabase
setup unchanged: PostgreSQL mode is used only when `DRIVER_DATABASE_URL` is set.

Services already on the machine: the website on `127.0.0.1:4001`, and something on port 4000. The driver API
uses **port 5100**.

Never put real passwords or keys in this file or in git. All values below are placeholders.

---

## 1. One-time database setup (as `postgres`)

Requires PostgreSQL 13 or later (`gen_random_uuid()` is built in). Check with `psql --version`.

Generate a password on the VPS and keep it in your password manager:

```bash
openssl rand -base64 32 | tr -d '/+='
```

Open a superuser shell on the website database:

```bash
sudo -u postgres psql -d alrawdah_db
```

Run this, replacing `<generated>` with the password:

```sql
create role driver_ops login password '<generated>';
grant connect on database alrawdah_db to driver_ops;
create schema if not exists driver_ops authorization driver_ops;
grant usage, create on schema driver_ops to driver_ops;
alter role driver_ops set search_path = driver_ops;
revoke all on schema public from driver_ops;
```

Check that the role is cut off from the website (adapt `public.orders` to one of the website's real tables).
**Both values must be `f`:**

```sql
select has_table_privilege('driver_ops', 'public.orders', 'select') as can_read_website_table,
       has_schema_privilege('driver_ops', 'public', 'create')      as can_create_in_public;
```

- `can_read_website_table = t` means that table was granted to `PUBLIC`. Check whether the website needs that
  before revoking it (`revoke all on public.<table> from public;`).
- `can_create_in_public = t` (PostgreSQL 14 and older) comes from the default `PUBLIC` privilege. If the website
  doesn't rely on it, run `revoke create on schema public from public;`.

Exit with `\q`. The same statements are in the header of `backend/db/driver_ops_schema.sql`.

## 2. Code and dependencies

```bash
sudo mkdir -p /var/www/rswater-driver-api /var/lib/rswater-driver-api/files
sudo chown -R $USER:$USER /var/www/rswater-driver-api /var/lib/rswater-driver-api
chmod 750 /var/lib/rswater-driver-api /var/lib/rswater-driver-api/files
cd /var/www/rswater-driver-api
git clone <YOUR_REPO_URL> .
cd backend
npm ci --omit=dev
npm run check
```

## 3. Environment (`/var/www/rswater-driver-api/backend/.env`)

Create it on the VPS only (`nano .env`, then `chmod 600 .env`). Use `.env.example` as the template.

```env
NODE_ENV=production
PORT=5100
HOST=127.0.0.1
API_BASE_URL=https://driver-api.rswater.ae

# Driver data: driver_ops schema in the website database + files on disk
DRIVER_DATABASE_URL=postgresql://driver_ops:<password>@127.0.0.1:5432/alrawdah_db
DRIVER_FILES_DIR=/var/lib/rswater-driver-api/files

# Website dispatch API (same machine)
WEBSITE_DISPATCH_URL=http://127.0.0.1:4001/api/dispatch/overview
WEBSITE_DISPATCH_WRITE_BASE_URL=http://127.0.0.1:4001/api/dispatch
WEBSITE_DISPATCH_WRITE_KEY=<same value as the website's DISPATCH_WRITE_KEY>
# Optional: sent as x-dispatch-read-key to the website's read endpoints, only if the website
# requires a read key from loopback callers.
# WEBSITE_DISPATCH_READ_KEY=<the website's dispatch read key>
# Optional, recommended UNSET on the VPS: emirate polygons for automatic routing then come from the
# bundled data-static/uae-emirates.geojson.json (same file the console serves at /api/emirates).
# When set, the URL is fetched and the bundled file is the fallback if it fails.
# EMIRATE_BOUNDARIES_URL=

# Driver logins: drivers are <DRIVER_LOGIN_USERNAME>1..N, all sharing DRIVER_LOGIN_PASSWORD
DRIVER_LOGIN_USERNAME=<username prefix>
DRIVER_LOGIN_PASSWORD=<strong password>
DRIVER_LOGIN_COUNT=7
DRIVER_LOGIN_NAME=Driver
# Signs driver sessions, assignment tokens and every download link (reports, invoices, files)
DRIVER_SESSION_SECRET=<openssl rand -base64 48>

# API keys
ADMIN_API_KEY=<openssl rand -hex 32>
DRIVER_API_KEY=<openssl rand -hex 32>
# Browser origins allowed to call the API (production default: none)
FRONTEND_ALLOWED_ORIGINS=https://rswater.ae

# Invoices / receipts (without a TRN they print as RECEIPT)
INVOICE_COMPANY_NAME=<legal company name>
INVOICE_COMPANY_TRN=<TRN>
INVOICE_COMPANY_ADDRESS=<address>
INVOICE_COMPANY_PHONE=<phone>
INVOICE_COMPANY_EMAIL=<email>

# Optional
# REQUIRE_DELIVERY_SIGNATURE=true
# SUPABASE_URL= / SUPABASE_SERVICE_ROLE_KEY=   (leave both unset on the VPS; setting only one stops startup)
```

Logical bucket names stay as before and are the top-level folders under `DRIVER_FILES_DIR`:
`delivery-proofs/` (proof photos and `signatures/`), `delivery-invoices/`, `driver-day-reports/`,
`driver-customer-requests/`. The proof reference sent to the website stays
`{ bucket: 'delivery-proofs', path, mimeType, size }`.

Files are never served as static files. They are only available through HMAC-signed links:
`/api/invoices/:id/download`, `/api/driver/reports/:id/download`, and, for proof photos and signatures,
`/api/files/delivery-proofs/download?path=…` (returned as `proof.url` / `signature.url` by
`/api/admin/delivery-attempts` in PostgreSQL mode).

## 4. Create the driver tables (as `driver_ops`)

```bash
cd /var/www/rswater-driver-api/backend
npm run db:apply-driver-schema
npm run db:check-driver-schema
```

`db:apply-driver-schema` runs `db/driver_ops_schema.sql` in one transaction. It's idempotent, so run it again
after updates. `db:check-driver-schema` is read-only and exits non-zero if a table, column, index or
`driver_ops.next_invoice_number()` is missing.

## 5. PM2 process `rswater-driver-api`

```bash
cd /var/www/rswater-driver-api/backend
pm2 start src/server.js --name rswater-driver-api --time
pm2 save
pm2 logs rswater-driver-api --lines 50
```

The first log lines must include `Driver data storage: postgres (files in /var/lib/rswater-driver-api/files)`.
`PORT`, `HOST` and the rest come from `.env`. Don't reuse the existing `rswater-api` entry in
`ecosystem.config.js`; that one is the Supabase API on port 5000.

Local checks on the VPS:

```bash
curl -s http://127.0.0.1:5100/api/health
curl -s http://127.0.0.1:5100/api/admin/dispatch/overview | head -c 300   # loopback is allowed without a key
```

## 6. nginx: `driver-api.rswater.ae`

DNS: an `A` record `driver-api` → the VPS IP. Then `/etc/nginx/sites-available/rswater-driver-api`:

```nginx
server {
    listen 80;
    server_name driver-api.rswater.ae;

    # Proof photos and signatures arrive as base64 JSON (the API accepts up to 8 MB).
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:5100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rswater-driver-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d driver-api.rswater.ae
curl -s https://driver-api.rswater.ae/api/health
```

Don't touch the website's existing nginx server blocks.

## 7. Dispatch console on the office PC

On the VPS the website's `/api/dispatch/*` only answers loopback (or a key) and nginx blocks it publicly. The
driver API therefore re-exposes the endpoints the console needs, protected by the API keys:

| Driver API (public, key required)                        | Website (loopback)                         |
|----------------------------------------------------------|--------------------------------------------|
| `GET /api/admin/website-dispatch/overview`               | `GET /api/dispatch/overview`               |
| `GET /api/admin/website-dispatch/customers/:id/orders`   | `GET /api/dispatch/customers/:id/orders`   |
| `GET /api/admin/website-dispatch/products`               | `GET /api/dispatch/products`               |
| `POST /api/admin/website-dispatch/orders`                | `POST ${WEBSITE_DISPATCH_WRITE_BASE_URL}/orders` |

- Auth: header `x-dispatch-read-key` **or** `x-api-key` must equal `ADMIN_API_KEY` or `DRIVER_API_KEY`;
  anything else gets `401`. There is no loopback exception on these routes.
- `:id` must be a UUID or `[A-Za-z0-9._:-]{1,80}` (otherwise `400`).
- The website's status and JSON body are passed through unchanged with `Cache-Control: no-store`; query strings
  are forwarded. If the website is unreachable or slower than 10 s, the API answers `503 { "error": ... }`.
- The website base URL is `WEBSITE_DISPATCH_URL` without `/overview`.
- `products` and `orders` (order entry from the console) use a 20 s timeout instead of 10 s; status and JSON
  are passed through the same way (`201`/`200`/`400` …), and an unreachable website gives `503`.
- `POST …/orders` takes a JSON object body of at most 64 KB (`Content-Type: application/json`): larger bodies get
  `413`, non-JSON or invalid JSON gets `400`. The driver API adds `x-dispatch-write-key: WEBSITE_DISPATCH_WRITE_KEY`
  itself and never forwards client headers, so a write key sent by the console is ignored. If
  `WEBSITE_DISPATCH_WRITE_KEY` is not set, the endpoint answers `503` without calling the website.

Set these in the console's environment on the office PC (placeholders; use the real host and key):

```env
RSWATER_WEBSITE_DISPATCH_URL=https://driver-api.rswater.ae/api/admin/website-dispatch
RSWATER_WEBSITE_DISPATCH_KEY=<DRIVER_API_KEY value>
RSWATER_OPERATIONS_API_URL=https://driver-api.rswater.ae/api
RSWATER_OPERATIONS_API_KEY=<DRIVER_API_KEY value>
```

Quick check from the office PC:

```bash
curl -s -H "x-dispatch-read-key: <DRIVER_API_KEY value>" https://driver-api.rswater.ae/api/admin/website-dispatch/overview | head -c 300
```

## 8. Backups

- **Database:** the `driver_ops` schema lives in `alrawdah_db`, so the website's existing database backup already
  covers it. To back up only the driver data:
  `pg_dump -h 127.0.0.1 -U driver_ops -n driver_ops alrawdah_db > driver_ops-$(date +%F).sql`
- **Files:** `DRIVER_FILES_DIR` is **not** in the database. Back it up as well (proofs, signatures, invoice PDFs,
  day reports, customer requests), for example nightly:
  `tar -czf /var/backups/rswater-driver-files-$(date +%F).tgz -C /var/lib/rswater-driver-api files`
  and copy the archive off the machine. Invoice PDFs can be re-rendered from the database, but proofs,
  signatures, day journals and customer requests cannot.

## 9. Rollback

The driver backend never writes to the website's tables, so rolling back has no effect on the website.

1. Stop the new process: `pm2 stop rswater-driver-api` (or `pm2 delete rswater-driver-api && pm2 save`).
2. Point the driver app / dispatch console back to the previous API (the Supabase-backed office PC setup).
   Data recorded on the VPS in the meantime stays in `driver_ops` and `DRIVER_FILES_DIR`; it isn't copied
   back to Supabase.
3. To run the VPS process against Supabase again instead, remove `DRIVER_DATABASE_URL` from `.env`, set
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then `pm2 restart rswater-driver-api`.
4. To remove the driver data entirely (irreversible; take a backup first), as `postgres`:
   `drop schema driver_ops cascade; drop role driver_ops;` and delete `DRIVER_FILES_DIR`.
