# Website dispatch endpoints — minimal live deploy (approved by owner 2026-10-21)

Deploy ONLY these pieces to the live website (rswater.ae, VPS 72.60.221.8, website API on 127.0.0.1:4001).
Do not deploy the rest of the local `phase1` working tree (branch codex/phase0-business-truth has many
unrelated uncommitted changes).

1. Back up the live website release (code + `pg_dump alrawdah_db`).
2. Copy `dispatchRead.ts` → `<live website>/backend/src/routes/dispatchRead.ts` and `createOrder.ts` → `<live website>/backend/src/services/createOrder.ts` (new file; the public checkout `orders.ts` is NOT changed).
3. Apply `app.ts.edit.md` to the live `backend/src/app.ts`.
4. Set in the website's env: `DISPATCH_WRITE_KEY=<long random>` (the driver backend uses the same value as
   `WEBSITE_DISPATCH_WRITE_KEY`). Optional: `DISPATCH_READ_KEY` (loopback reads don't need it).
5. Build the website backend (`npm run build`) and restart its process (PM2).
6. Add `nginx-block-public-dispatch.conf` to the rswater.ae server block, `nginx -t`, reload.
7. Verify on the VPS:
   - `curl -s http://127.0.0.1:4001/api/dispatch/overview | head -c 300`  → JSON with orders/customers
   - `curl -s -o /dev/null -w '%{http_code}' https://rswater.ae/api/dispatch/overview` → 404 (blocked publicly)

Rollback: remove the mount line + file, rebuild, restart; remove the nginx location.

## Staff orders (added 2026-10-23, owner-approved)
`POST /api/dispatch/orders` (write key) creates a real website order for the dispatch console: priced by the
website's own `calculateOrder`, numbered by `generateOrderNumber`, customer find-or-create like checkout,
inserts into `customers`/`orders`/`order_items` and an `audit_logs` entry (`dispatch_order_created`, also used
for idempotency), then sends the same notifications as checkout. Orders get `source = 'phone'` and
`referral = {source: 'dispatch', medium: 'staff'}`. `GET /api/dispatch/products` lists what the website sells.
The deploy script type-checks against the live code before building and restores the files if that fails.
