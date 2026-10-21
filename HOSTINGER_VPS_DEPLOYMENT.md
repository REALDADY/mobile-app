# RS Water API Hostinger VPS Deployment

This deploys only the backend API on `api.rswater.ae`. Do not edit the existing `rswater.ae` website config or `/var/www/html`.

## DNS

Add this record in Hostinger DNS:

```text
Type: A
Name: api
Value: 72.60.221.8
TTL: default
```

Do not change `rswater.ae` or `www.rswater.ae`.

## Required Backend Environment Variables

Create `/var/www/rswater-api/backend/.env` from `.env.production.example` and fill real values on the VPS only.

```env
NODE_ENV=production
PORT=5000
HOST=0.0.0.0

API_BASE_URL=https://api.rswater.ae

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

ADMIN_API_KEY=
DRIVER_API_KEY=
FRONTEND_ALLOWED_ORIGINS=https://rswater.ae,https://admin.rswater.ae

NGENIUS_BASE_URL=
NGENIUS_API_KEY=
NGENIUS_OUTLET_ID=
NGENIUS_REDIRECT_URL=https://api.rswater.ae

APP_SCHEME=alrawdahsprings
CUSTOMER_APP_REDIRECT_URL=alrawdahsprings://payment-complete
CUSTOMER_APP_CANCEL_URL=alrawdahsprings://payment-cancel
CUSTOMER_APP_CHECKOUT_REDIRECT_URL=alrawdahsprings://checkout-complete
```

## VPS Commands

Run these manually on the VPS after SSH login.

```bash
sudo mkdir -p /var/www/rswater-api
sudo chown -R $USER:$USER /var/www/rswater-api
cd /var/www/rswater-api
```

Clone the project, or copy/upload it into `/var/www/rswater-api`. If using git:

```bash
git clone <YOUR_REPO_URL> .
```

Install and prepare the backend:

```bash
cd /var/www/rswater-api/backend
npm install
npm run check
npm run check:schema
```

Before processing real payments, run `supabase-schema.sql` from the repo root in the Supabase SQL editor. For an existing database, run `supabase-production-hardening.sql` after it.

Create the production `.env` on the VPS:

```bash
cp .env.production.example .env
nano .env
```

Start with PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Test the API locally on the VPS:

```bash
curl http://127.0.0.1:5000/api/health
```

## Nginx API Subdomain

Create only the API subdomain config:

```bash
sudo nano /etc/nginx/sites-available/rswater-api
```

Paste the contents of `nginx-rswater-api.conf`, then enable it:

```bash
sudo ln -s /etc/nginx/sites-available/rswater-api /etc/nginx/sites-enabled/rswater-api
sudo nginx -t
sudo systemctl reload nginx
```

Test HTTP:

```bash
curl http://api.rswater.ae/api/health
```

## SSL

Install Certbot if needed:

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

Issue SSL only for the API subdomain:

```bash
sudo certbot --nginx -d api.rswater.ae
```

Test HTTPS:

```bash
curl https://api.rswater.ae/api/health
```

Check the existing website still works:

```bash
curl -I https://rswater.ae
```

## PM2 Maintenance

```bash
pm2 status
pm2 logs rswater-api
pm2 restart rswater-api
```

## Notes

- The backend is JavaScript and starts with `npm start`.
- There is no backend build step.
- `.env` must stay on the VPS only and must not be committed.
- The backend uses Supabase/Postgres through the Supabase Admin API. Keep the service role key backend-only.
