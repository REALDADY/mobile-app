# RS Water Backend Deployment

Production target example:

`https://api.rswater.ae`

## Required Environment Variables

Use `.env.production.example` as the template. Do not commit real values.

Required for production:

- `NODE_ENV=production`
- `PORT=5000`
- `HOST=0.0.0.0`
- `API_BASE_URL=https://api.rswater.ae`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_API_KEY`
- `DRIVER_API_KEY`
- `FRONTEND_ALLOWED_ORIGINS=https://admin.rswater.ae`
- `NGENIUS_BASE_URL`
- `NGENIUS_API_KEY`
- `NGENIUS_OUTLET_ID`
- `NGENIUS_REDIRECT_URL=https://api.rswater.ae`
- `CUSTOMER_APP_REDIRECT_URL`
- `CUSTOMER_APP_CANCEL_URL`
- `CUSTOMER_APP_CHECKOUT_REDIRECT_URL`

## Install And Start

```bash
npm install
npm run check
npm run check:schema
npm start
```

This backend is plain Node.js/Express, so there is no build step.

## Health Check

After deployment:

```bash
curl https://api.rswater.ae/api/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "rswater-api",
  "environment": "production"
}
```

## Database Notes

For a fresh deployment, run `../supabase-schema.sql` in the Supabase SQL editor first. It creates the product catalog, coupon packs, orders, subscriptions, driver locations, payment ledger, push notification tables, RLS policies, triggers, and seed rows.

For an existing deployment, run `../supabase-production-hardening.sql` after the base schema. It is idempotent and keeps older databases aligned with the current backend contracts.

The backend no longer uses Prisma. Production data is read and written through Supabase using `SUPABASE_SERVICE_ROLE_KEY`; keep that key backend-only.

Run `npm run check:schema` after setting `.env`. If it reports missing columns such as `products.code`, apply `../supabase-production-hardening.sql` in the Supabase SQL editor and rerun the check.

## Hostinger Notes

- Set all environment variables in the Hostinger Node.js app panel.
- Set the startup file/command to `npm start`.
- Make sure the app listens on `process.env.PORT`.
- Configure your domain/subdomain to proxy to the Node.js app.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, `NGENIUS_API_KEY`, `ADMIN_API_KEY`, and `DRIVER_API_KEY` secret.

## Payment Notes

N-Genius redirects must use HTTPS URLs on your API domain. The backend relays those URLs back to the mobile app scheme using:

- `/api/payment/complete`
- `/api/payment/cancel`
- `/api/payment/checkout-complete`

Card-payment fulfillment should be completed with a verified N-Genius webhook/status check before awarding paid-only benefits.
