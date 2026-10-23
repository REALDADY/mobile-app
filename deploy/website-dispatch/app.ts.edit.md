# Edit to the LIVE website's backend/src/app.ts (2 additions, nothing else)

1. With the other route imports near the top:

```ts
import dispatchReadRouter from './routes/dispatchRead'
```

2. After the logging (morgan) block and BEFORE the `// ─── RATE LIMITING` block:

```ts
// Driver/dispatch feed: GET is loopback-or-key gated, writes need DISPATCH_WRITE_KEY (or loopback).
// Mounted before the public API limiter so the driver backend's polling can't exhaust it.
app.use('/api/dispatch', dispatchReadRouter)
```

The file `backend/src/routes/dispatchRead.ts` is copied as-is from this folder.
It only reads `orders`, `customers` and order items, and on completion updates `orders`
(status → delivered, COD → paid) and inserts into `audit_logs`. No database migration needed.
Requires `app.set('trust proxy', 1)` (already present in the website) so public requests
never look like loopback.
