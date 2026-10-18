# Merchant dashboard analytics (#77)

Uses `POST /analytics/challenge`, `POST /analytics/session` and `GET /analytics/overview?range=7D|30D|90D|1Y`.

Merchant wallet signs a short-lived SEP-53 challenge, bound to a registered merchant wallet and configured origin. The challenge is single-use; successful verification mints a 15-minute signed read-only session token. The client keeps the token only in memory.

## Deployment prerequisites

1. Apply issue #76's `payment_transactions` schema and verified on-chain event-ingestion pipeline in staging; this dashboard will not substitute plan quotes or webhooks for verified settlement amounts.
2. Apply `analytics-migration.sql` after the #76 migration (for the challenge table and aggregation function). The function can only be executed by the service role; never expose that secret to the browser.
3. Configure backend env: `ORBIT_ANALYTICS_SESSION_SECRET` (random 32+ bytes) and `ORBIT_ANALYTICS_ALLOWED_ORIGIN` (exact HTTPS frontend origin). For localhost only, the default allowed origin is `http://localhost:3000`.
4. The wallet's `G...` address must match the `merchants.wallet_address` database record. Browser-local accounts without server registration cannot see merchant analytics.

## Metric semantics

- **MRR:** only active USDC-priced subscriptions; raw USDC amount times 2,629,800 seconds (average Gregorian month) divided by the plan interval in seconds. For fiat/unknown-priced plans `mrr_incomplete = true`, and the UI deliberately hides MRR rather than claiming a false total.
- **Settled volume:** sum of verified confirmed settlement rows in `payment_transactions`, counted in raw token units (7 USDC decimals), not billing quotes.
- **Chart:** verified settlement timestamps grouped by UTC day within the chosen range; gaps are rendered as zero after the authorized query succeeds.
- **New subscriptions:** created in the chosen range. Growth compares this count with the preceding same-length range; it is **not** churn and not a claim about past active subscriber snapshots.

If the database migration, RPC or settlement ingestion is unavailable, the endpoint returns 503; the dashboard shows an error, not fabricated figures. Historical backfill is a separate #76 reconciliation concern.

Security note: SEP-53 verifies a signing key. It does not by itself prove authority over a multisignature or contract account. The code is explicitly limited to ordinary registered Ed25519 wallet addresses.
