# Orbit Merchant API

See [Merchant operations](../../Docs/MERCHANT_OPERATIONS.md) for the persistent
event indexer, `/health/ready`, federated `/graphql` API, wallet authentication,
billing recovery endpoints, and required migrations for existing databases.

The Orbit Merchant API (`apps/backend/index.js`) is an Express service that manages pricing plans, customer subscriptions, and automated on-chain pull executions on Stellar Soroban. Data is persisted in Supabase using the tables defined in `apps/backend/schema.sql` (`merchants`, `plans`, `subscriptions`).

## Setup and Configuration

### Prerequisites

- Node.js 18+ and npm 9+
- A Supabase project with tables initialized via `apps/backend/schema.sql`
- A deployed Orbit Soroban contract on Stellar Testnet

### Environment Variables

Copy `apps/backend/.env.example` to `apps/backend/.env` and configure:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Local port for Express server (defaults to 3001) | `3001` |
| `SUPABASE_URL` | Supabase project URL | `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret key | `eyJhbGciOi...` |
| `ORBIT_CONTRACT_ID` | Deployed Orbit Soroban smart contract ID | `CAZBZBUWBSQYK2RZ6WHMXVDLIQHSU5WD7ANZYL6HLNSCRUOTNYCDYQNG` |
| `IDEMPOTENCY_KEY_TTL_SECONDS` | How long an `Idempotency-Key` replays its stored response (defaults to 24h) | `86400` |
| `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS` | After this long an unfinished claim is treated as abandoned and may be retried (defaults to 300) | `300` |
| `PREPARE_LOCK_TTL_SECONDS` | Billing lease held while `/trigger-pull` simulates a pull (defaults to 60) | `60` |
| `RECONCILE_INTERVAL_MS` | Delay between reconciliation worker runs (defaults to 60000) | `60000` |
| `RECONCILE_EVENT_LOOKBACK_LEDGERS` | Ledgers scanned back when no event cursor is stored or it has left RPC retention (defaults to 17280, ~1 day) | `17280` |
| `RECONCILE_GRACE_SECONDS` | Subscriptions younger than this are not checked against `get_vault` (defaults to 300) | `300` |
| `RATE_LIMIT_WINDOW_MS` | Sliding window length for both rate limits (defaults to 60000) | `60000` |
| `API_KEY_RATE_LIMIT_MAX` | Requests per window allowed for each API key on authenticated routes (defaults to 100) | `100` |
| `IP_RATE_LIMIT_MAX` | Requests per window allowed for each client IP on every route (defaults to 300) | `300` |
| `TRUST_PROXY` | Express `trust proxy` setting; set when behind a load balancer so rate limiting sees the client IP | `1` |
| `RELAYER_SECRET_KEY` | Orbit relayer account that pays sponsored pull fees (fee-bump fee source). `/relay/*` returns 503 when unset | `S...` |
| `RELAYER_CHANNEL_SECRET_KEYS` | Optional comma-separated channel accounts used as inner transaction sources (defaults to the relayer account) | `S...,S...` |
| `RELAYER_DAILY_FEE_LIMIT_STROOPS` | Sponsored fee budget per merchant per UTC day (defaults to 50000000 = 5 XLM) | `50000000` |
| `RELAYER_MAX_FEE_STROOPS` | Largest total fee sponsored for one pull (defaults to 5000000) | `5000000` |
| `RELAYER_BASE_FEE` | Fee bump inclusion fee per operation in stroops (defaults to 100) | `100` |
| `RELAYER_MAX_ATTEMPTS` | Submission attempts on `txBadSeq` / `TRY_AGAIN_LATER` (defaults to 3) | `3` |
| `RELAYER_QUEUE_TIMEOUT_MS` | Longest a relay waits for a free channel before `503` (defaults to 30000) | `30000` |
| `RELAYER_AUTH_VALIDITY_LEDGERS` | Ledgers a prepared merchant authorization remains signable (defaults to 100, ~8 minutes) | `100` |
| `RELAYER_RATE_LIMIT_MAX` / `RELAYER_RATE_LIMIT_WINDOW_MS` | Relay requests allowed per merchant per window (defaults to 10 per 60000 ms) | `10` |
| `ORACLE_SYNC_INTERVAL_MS` | Background worker refresh interval for the fiat → USDC rate cache (defaults to 300000 = 5 min) | `300000` |
| `ORACLE_SLIPPAGE_TOLERANCE_BPS` | Maximum rate movement from a subscription's quoted rate that a fiat pull may settle at (defaults to 200 = 2%) | `200` |
| `ORACLE_FETCH_TIMEOUT_MS` | Price feed request timeout in milliseconds (defaults to 6000) | `6000` |
| `SPLIT_RELAYER_SECRET_KEY` | Account that signs on-chain payout-split transfers; falls back to `RELAYER_SECRET_KEY`. Splits stay pending when unset | `S...` |
| `SPLIT_TOKEN_CONTRACT_ID` | Stellar Asset Contract used for split payouts; falls back to `USDC_CONTRACT_ID` | `C...` |
| `PRICE_INDEXATION_INTERVAL_MS` | Delay between price indexation worker runs (defaults to 900000 = 15 min) | `900000` |

### Running the API

```bash
cd apps/backend
npm install
node index.js
```

The service runs at `http://localhost:3001`.

---

## API Routes Overview

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/plans` | API key | Create a new recurring pricing plan |
| `GET` | `/plans/:id` | Public | Fetch plan and merchant details |
| `GET` | `/subscribers` | API key | List active subscribers for a merchant |
| `GET` | `/rates` | Public | Supported fiat → USDC pairs with their newest cached rate |
| `POST` | `/trigger-pull` | API key | Prepare an unsigned merchant pull transaction |
| `POST` | `/submit-pull` | API key | Verify and submit a wallet-signed pull transaction |
| `POST` | `/relay/prepare-pull` | API key | Get the authorization entry for a gas-sponsored pull |
| `POST` | `/relay/submit-pull` | API key | Submit a merchant-authorized pull through the fee-bump relayer |
| `GET` | `/relay/budget` | API key | Today's sponsored fee usage and remaining budget |
| `POST` | `/subscriptions` | Public | Record a customer subscription after handshake |
| `POST` | `/api-keys` | API key | Create an API key (secret shown once) |
| `GET` | `/api-keys` | API key | List the merchant's API keys |
| `DELETE` | `/api-keys/:id` | API key | Revoke an API key |
| `GET` | `/payout-splits` | API key | List the merchant's payout split rules |
| `POST` | `/payout-splits` | API key | Create a payout split rule |
| `PATCH` | `/payout-splits/:id` | API key | Update a payout split rule |
| `DELETE` | `/payout-splits/:id` | API key | Deactivate a payout split rule |
| `GET` | `/payout-distributions` | API key | List recorded split distributions |
| `POST` | `/payout-distributions/reconcile` | API key | Retry pending split forwards |
| `GET` | `/plans/:id/price-schedules` | API key | List a plan's scheduled price changes |
| `POST` | `/plans/:id/price-schedules` | API key | Schedule a future plan price change |
| `DELETE` | `/price-schedules/:id` | API key | Cancel a scheduled price change |
| `POST` | `/price-schedules/process` | API key | Run the notice/apply pipeline once |
| `POST` | `/price-reauthorizations/:token/authorize` | Public | Subscriber accepts updated allowance terms |

---

## Authentication

Merchant routes require an API key in the `Authorization` header:

```bash
curl http://localhost:3001/subscribers -H "Authorization: Bearer orb_live_<64 hex chars>"
```

- Keys look like `orb_live_<32 random bytes as hex>` or `orb_test_<...>`.
- Only the SHA-256 hash of a key is stored (`api_keys.key_hash`), together with a short `key_prefix` such as `orb_live_71c2` used to identify the key in the dashboard. The full secret is returned once, when the key is created, and cannot be recovered.
- The authenticated merchant is derived from the key. `merchant_id` in request bodies and query strings is now optional; if sent it must match the key's merchant, otherwise the request is rejected with `403 Forbidden`. `/trigger-pull` and `/submit-pull` return `404` for subscriptions owned by another merchant.
- A missing, malformed, unknown or revoked key returns `401 Unauthorized` with a `WWW-Authenticate: Bearer` header.
- `last_used_at` is updated at most once a minute per key.

The checkout routes (`GET /plans/:id`, `POST /subscriptions`) stay public.

### Issuing keys

Bootstrap a merchant's first key directly against the database (requires the Supabase env vars):

```bash
npm run create-api-key -- <merchant_id> "Server key" live
```

Further keys can be managed over the API with an existing key:

```bash
# Create (environment: "live" or "test"). A test key cannot create a live key.
curl -X POST http://localhost:3001/api-keys \
  -H "Authorization: Bearer $ORBIT_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "CI", "environment": "test"}'

# List (never includes secrets or hashes)
curl http://localhost:3001/api-keys -H "Authorization: Bearer $ORBIT_API_KEY"

# Revoke
curl -X DELETE http://localhost:3001/api-keys/<key id> -H "Authorization: Bearer $ORBIT_API_KEY"
```

`POST /api-keys` deliberately does not support `Idempotency-Key`, since replaying the response would require persisting the secret.

### Rate limiting

Two in-memory sliding-window limits apply (default window 60 seconds):

- **Per client IP** on every route, including public ones and failed authentication attempts (`IP_RATE_LIMIT_MAX`, default 300).
- **Per API key** on authenticated routes (`API_KEY_RATE_LIMIT_MAX`, default 100).

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds until the oldest counted request leaves the window) and `RateLimit-Policy`. Over the limit the API returns `429 Too Many Requests` with `Retry-After`. Counters are per process; with several API instances behind a load balancer each enforces its own limit.

---

## Route Reference

### 1. POST /plans

#### Purpose
Creates a new recurring subscription plan for a merchant.

#### Request Body
Content-Type: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `merchant_id` | `string` (UUID) | No | Taken from the API key. If sent, must match the authenticated merchant (`403` otherwise). |
| `name` | `string` | Yes | Name of the subscription plan (e.g., `"Pro Plan - 29 USDC/month"`). |
| `currency` | `string` | No | Pricing currency. `USDC` (the default) requires `usdc_amount`; `USD` and `EUR` require `price_amount`. Fiat plans settle at the oracle's live rate when a pull is prepared. |
| `usdc_amount` | `integer` | USDC plans | Billing amount per interval in raw token units. USDC has 7 decimals, so `290000000` is 29 USDC. This is the same unit as the contract's `amount_per_interval`. |
| `price_amount` | `number` | Fiat plans | Price per interval in the plan's fiat currency (e.g. `20` for 20 USD). The oracle converts it to raw USDC units at pull time. |
| `interval_seconds` | `number` | Yes | Cadence between billing pulls in seconds (e.g., `2592000` for 30 days). |

#### Example Request

```bash
curl -X POST http://localhost:3001/plans \
  -H "Authorization: Bearer $ORBIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pro Plan - 29 USDC/month",
    "usdc_amount": 290000000,
    "interval_seconds": 2592000
  }'
```

#### Example Success Response
Status: `201 Created`

```json
{
  "message": "Plan created successfully",
  "plan": {
    "id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "name": "Pro Plan - 29 USDC/month",
    "usdc_amount": 290000000,
    "interval_seconds": 2592000,
    "created_at": "2026-09-30T00:00:00.000Z"
  }
}
```

#### Error Responses

- `400 Bad Request`
  Returned when any required field (`merchant_id`, `name`, `usdc_amount`, `interval_seconds`) is missing.
  ```json
  {
    "error": "Missing required fields"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails or a foreign key constraint is violated.
  ```json
  {
    "error": "insert or update on table \"plans\" violates foreign key constraint \"plans_merchant_id_fkey\""
  }
  ```

---

### 2. GET /plans/:id

#### Purpose
Fetches details of a specific plan along with the associated merchant's name and Stellar wallet address. Used by checkout widgets and payment pages.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Unique ID of the plan to fetch. |

#### Example Request

```bash
curl http://localhost:3001/plans/e2a0b3df-2015-4672-9721-a1e94c1408d7
```

#### Example Success Response
Status: `200 OK`

```json
{
  "plan": {
    "id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "name": "Pro Plan - 29 USDC/month",
    "usdc_amount": 290000000,
    "interval_seconds": 2592000,
    "created_at": "2026-09-30T00:00:00.000Z",
    "merchants": {
      "name": "Acme SaaS",
      "wallet_address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    }
  }
}
```

#### Error Responses

- `404 Not Found`
  Returned if no plan exists with the given ID.
  ```json
  {
    "error": "Plan not found"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails or the ID syntax is invalid.
  ```json
  {
    "error": "invalid input syntax for type uuid: \"invalid-id\""
  }
  ```

---

### 3. GET /subscribers

#### Purpose
Fetches all active subscriptions across plans owned by the authenticated merchant, used by the merchant dashboard.

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `merchant_id` | `string` (UUID) | No | Taken from the API key. If sent, must match the authenticated merchant (`403` otherwise). |

#### Example Request

```bash
curl http://localhost:3001/subscribers -H "Authorization: Bearer $ORBIT_API_KEY"
```

#### Example Success Response
Status: `200 OK`

```json
{
  "subscribers": [
    {
      "id": "c1f7b9e0-1234-5678-9abc-def012345678",
      "plan_id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
      "customer_wallet_address": "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
      "status": "active",
      "next_billing_date": "2026-10-30T00:00:00.000Z",
      "created_at": "2026-09-30T00:00:00.000Z",
      "plans": {
        "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "name": "Pro Plan - 29 USDC/month",
        "usdc_amount": 290000000
      }
    }
  ]
}
```

#### Error Responses

- `400 Bad Request`
  Returned when `merchant_id` is not a valid UUID.

- `403 Forbidden`
  Returned when `merchant_id` names a different merchant than the API key.

- `500 Internal Server Error`
  Returned if the database query fails.
  ```json
  {
    "error": "invalid input syntax for type uuid: \"invalid-merchant-id\""
  }
  ```

---

### 4. POST /trigger-pull

#### Purpose
Prepares an unsigned on-chain pull payment for the merchant's registered public address. Orbit never receives a merchant secret key.

The flow:
1. Loads subscription, plan terms, and merchant wallet address from Supabase.
2. For fiat plans (`USD`/`EUR`), resolves the live USDC rate from the oracle and rejects the pull when the rate moved more than 200 bps (2%) from the subscription's quoted rate. The response then carries `usdc_amount`, `currency`, and the `rate` used; USDC plans report their stored `usdc_amount` unchanged.
3. Builds and simulates `pull_funds(user, merchant)`.
4. Returns the transaction XDR and network passphrase for signing in the merchant wallet.
5. The client sends the signed envelope to `POST /submit-pull`.
6. The API verifies the merchant signature, submits it, and updates billing state after confirmation.

#### Request Body
Content-Type: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `subscription_id` | `string` (UUID) | Yes | Unique ID of the subscription to pull funds for. |

#### Example Request

```bash
curl -X POST http://localhost:3001/trigger-pull \
  -H "Authorization: Bearer $ORBIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subscription_id": "c1f7b9e0-1234-5678-9abc-def012345678"
  }'
```

#### Example Success Response
Status: `200 OK`

```json
{
  "transaction_xdr": "AAAAAg...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "merchant_address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "subscription_id": "c1f7b9e0-1234-5678-9abc-def012345678"
}
```

#### Error Responses

- `400 Bad Request`
  Returned when `subscription_id` is missing, malformed, or an unexpected secret field is supplied.
  ```json
  {
    "error": "Invalid input on subscription_id: subscription_id must be a valid UUID"
  }
  ```

- `POST /submit-pull` accepts `{ "subscription_id": "...", "signed_xdr": "..." }`. It returns `401` unless the envelope source and a valid signature match the merchant wallet registered for the plan.
  ```json
  {
    "error": "A valid merchant wallet signature is required"
  }
  ```

- `404 Not Found`
  Returned when the subscription record does not exist.
  ```json
  {
    "error": "Subscription not found"
  }
  ```

- `409 Conflict`
  Returned for a fiat plan when the live exchange rate moved more than the slippage tolerance away from the subscription's quoted rate. The pull is not simulated or locked; the response reports both rates and the move in basis points.
  ```json
  {
    "error": "Exchange rate moved 500 bps from the quoted rate, exceeding the 200 bps slippage tolerance",
    "quoted_rate": 1,
    "current_rate": 1.05,
    "move_bps": 500,
    "max_bps": 200
  }
  ```

- `503 Service Unavailable`
  Returned for a fiat plan when no exchange rate can be resolved (cold cache and the price feed is unreachable).
  ```json
  {
    "error": "Exchange rate for USD/USDC is unavailable"
  }
  ```

- `500 Internal Server Error`
  Returned when `ORBIT_CONTRACT_ID` is not set in `.env`, or the Soroban transaction build, simulation, or submission fails (e.g., interval not elapsed, insufficient allowance).
  ```json
  {
    "error": "ORBIT_CONTRACT_ID not set in .env"
  }
  ```
  ```json
  {
    "error": "Transaction failed: {\"status\":\"FAILED\"}"
  }
  ```

---

### 5. POST /subscriptions

#### Purpose
Records a customer subscription after the customer has executed the on-chain allowance approval and vault creation handshake with the Orbit contract.

Sets `next_billing_date` to the current timestamp (`new Date().toISOString()`), enabling the initial pull immediately.

For fiat plans the current oracle rate is stored on the subscription as `quoted_rate`, which is the baseline the pull-time slippage guard compares against. When the rate cache is cold the subscription is still created and the first pull stores the baseline instead.

#### Request Body
Content-Type: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `plan_id` | `string` (UUID) | Yes | Unique ID of the plan being subscribed to. |
| `customer_wallet_address` | `string` | Yes | Stellar public key (`G...`) of the subscriber. |

#### Example Request

```bash
curl -X POST http://localhost:3001/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "plan_id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "customer_wallet_address": "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG"
  }'
```

#### Example Success Response
Status: `201 Created`

```json
{
  "message": "Subscription created",
  "subscription": {
    "id": "c1f7b9e0-1234-5678-9abc-def012345678",
    "plan_id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "customer_wallet_address": "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
    "status": "active",
    "next_billing_date": "2026-09-30T00:00:00.000Z",
    "created_at": "2026-09-30T00:00:00.000Z"
  }
}
```

#### Error Responses

- `400 Bad Request`
  Returned when `plan_id` or `customer_wallet_address` is missing.
  ```json
  {
    "error": "Missing required fields"
  }
  ```

- `409 Conflict`
  Returned if the customer is already subscribed to the plan (unique constraint on `(plan_id, customer_wallet_address)`).
  ```json
  {
    "error": "This wallet is already subscribed to this plan"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails.

---

## Ledger Reconciliation Worker

A subscriber can cancel their vault directly on-chain (from a wallet or block explorer), and a `/submit-pull` can lose track of a transaction that later lands. `reconciliation.js` is a background worker that keeps Supabase in line with the Soroban ledger, which is always treated as the source of truth.

```bash
cd apps/backend
npm run reconcile             # poll every RECONCILE_INTERVAL_MS
npm run reconcile -- --once   # single run, exits non-zero if any errors occurred (for cron)
```

Each run performs two passes:

1. **Event ingestion**: reads `vault_created`, `vault_cancelled` and `funds_pulled` events for `ORBIT_CONTRACT_ID` via `getEvents`, resuming from the cursor stored in `reconciliation_state`. A `vault_cancelled` sets matching `active`/`past_due` subscriptions to `cancelled`; a `funds_pulled` sets `next_billing_date` to the pull's ledger timestamp plus the plan interval. The cursor is saved only after every event is applied.
2. **State sweep**: calls `get_vault` (by simulation, no fees) for every `active`/`past_due` subscription older than `RECONCILE_GRACE_SECONDS`. A missing vault cancels the subscription; otherwise `next_billing_date` is realigned to `last_pull_timestamp + interval_seconds`. This catches drift whose events are already outside the RPC's retention window.

Safety rules:

- A failed or ambiguous lookup (RPC error, archived vault entry) is logged and never treated as a cancellation.
- Every write takes the per-subscription billing lock, so the worker never races an in-flight `/submit-pull`; locked subscriptions are skipped and retried on the next run.

Each discrepancy is logged as a JSON line with `event: "reconciliation.discrepancy"` and a `type` of `vault_missing_on_chain`, `next_billing_date_drift`, `untracked_vault` or `vault_archived`, plus the subscription id, source (`event` or `ledger_state`) and ledger/tx hash where known. Every run ends with a `reconciliation.run_completed` line carrying the metrics `events_ingested`, `subscriptions_checked`, `cancelled`, `billing_dates_updated`, `skipped_locked`, `discrepancies`, `errors` and `duration_ms`.
### 6. GET /rates

#### Purpose
Lists the supported fiat → USDC conversion pairs with their newest cached exchange rate. Fiat plan creation, subscription quoting, and pull-time pricing all read this cache, which the background oracle worker refreshes every `ORACLE_SYNC_INTERVAL_MS` (default 5 minutes).

No authentication required. On a cold cache the endpoint refreshes once from the live feed; if the feed is unreachable it still answers with `rate: null` and `available: false` per pair.

#### Example Request

```bash
curl http://localhost:3001/rates
```

#### Example Success Response
Status: `200 OK`

```json
{
  "pairs": [
    {
      "pair": "USD/USDC",
      "base": "USD",
      "quote": "USDC",
      "rate": 1.0204081632653061,
      "source": "coingecko",
      "fetched_at": "2026-10-17T12:00:00.000Z",
      "available": true
    },
    {
      "pair": "EUR/USDC",
      "base": "EUR",
      "quote": "USDC",
      "rate": 1.0869565217391304,
      "source": "coingecko",
      "fetched_at": "2026-10-17T12:00:00.000Z",
      "available": true
    }
  ],
  "supported_pairs": ["USD/USDC", "EUR/USDC"],
  "slippage_tolerance_bps": 200,
  "updated_at": "2026-10-17T12:00:00.000Z"
}
```

`rate` is how many USDC one unit of the base currency buys, so `usdc_units = price_amount * rate * 10^7`.

#### Error Responses

- `500 Internal Server Error`
  Returned when the `exchange_rates` table cannot be read.
  ```json
  {
    "error": "permission denied for table exchange_rates"
  }
  ```

---

## Idempotency and Concurrency

### Idempotency-Key header

`POST /plans`, `POST /subscriptions`, `POST /trigger-pull` and `POST /submit-pull` accept an optional `Idempotency-Key` header (1–255 characters, e.g. a UUID v4), following the same conventions as Stripe. Send a fresh key per logical operation and reuse it verbatim when retrying after a timeout or network error.

Keys are scoped to the merchant that owns the resource (the `merchant_id` of the plan, or of the subscription's plan) and are stored in the `idempotency_keys` table for 24 hours.

| Situation | Response |
|---|---|
| First request with a key | Executed normally; the response is stored |
| Retry after it completed | The stored status code and body are replayed with header `Idempotent-Replayed: true`; nothing is re-executed |
| Retry while the first request is still running | `409 Conflict` with `Retry-After` |
| Same key, different endpoint or request body | `422 Unprocessable Entity` |
| First attempt ended in a `5xx` or a transient `409` (billing lock busy) | The key is marked `failed` and the next retry with the same body executes again |
| Header empty or longer than 255 characters | `400 Bad Request` |

The request body is hashed with SHA-256 after sorting object keys, so key order does not matter. Claiming a key is a single atomic statement (`claim_idempotency_key`), so concurrent duplicates cannot both execute. An attempt whose process died mid-request is recoverable after `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS`.

### Per-subscription billing lock

Independently of idempotency keys, `/trigger-pull` and `/submit-pull` take a lease on the subscription in the `billing_locks` table (`acquire_billing_lock` / `release_billing_lock`). A second billing operation on the same subscription while the lease is held gets `409 Conflict` with `Retry-After` and never reaches Soroban simulation or submission. Leases expire automatically (60s for preparation, the confirmation poll timeout plus 60s for submission), so a crashed process cannot block billing permanently. When `/submit-pull` returns `202` (transaction submitted but unconfirmed), the lease is deliberately kept until it expires so no second pull can race the one still in flight.

### Housekeeping

`purge_expired_idempotency_keys()` deletes expired keys and stale leases. Schedule it with `pg_cron`, for example:

```sql
SELECT cron.schedule('purge-idempotency', '0 * * * *', 'SELECT purge_expired_idempotency_keys()');
```

---

## Gas-Sponsored Pulls (Fee-Bump Relayer)

`/trigger-pull` + `/submit-pull` make the merchant wallet the transaction source, so it must hold XLM for fees and track its sequence number. The `/relay/*` routes remove both: the Orbit relayer (`relayer.js`) submits the transaction and pays for it.

1. `POST /relay/prepare-pull` with `{ "subscription_id" }` simulates `pull_funds` and returns `auth_entry_xdr`, the merchant's unsigned Soroban authorization entry, plus `valid_until_ledger` and `network_passphrase`.
2. The merchant signs **only that authorization**, not a transaction. With the JS SDK: `authorizeEntry(xdr.SorobanAuthorizationEntry.fromXdr(auth_entry_xdr, 'base64'), keypair, valid_until_ledger, network_passphrase)`, or the wallet's `signAuthEntry`.
3. `POST /relay/submit-pull` with `{ "subscription_id", "signed_auth_entry_xdr" }`. The API checks that the entry authorizes exactly `pull_funds(subscriber, merchant)` on `ORBIT_CONTRACT_ID`, is signed by the merchant's key for this network, and has not expired. It then relays the pull and records the outcome exactly like `/submit-pull` (billing date, audit log, `payment.settled` webhook, or `past_due` on failure). The response adds `sponsored`, `sponsor_address`, `fee_charged_stroops` and `attempts`.

How it is submitted:

- The authorization goes into a transaction sourced from a relayer **channel account**, signed by the channel, then wrapped in a `FeeBumpTransaction` whose fee source is `RELAYER_SECRET_KEY`. The merchant is never a transaction source and is never charged a fee. Its account only has to exist so its signature can be checked.
- **Sequence management**: channels are handed out one relay at a time (FIFO queue, `503 relayer_busy` after `RELAYER_QUEUE_TIMEOUT_MS`), and each channel's sequence number is cached and advanced locally, so concurrent relays never collide. On `txBadSeq` the cache is re-read from the ledger and the transaction rebuilt; on `TRY_AGAIN_LATER` it is retried after a backoff, up to `RELAYER_MAX_ATTEMPTS`. The merchant's signature covers the invocation, not the transaction, so retries never need a new signature. Add channels with `RELAYER_CHANNEL_SECRET_KEYS` for more parallelism.
- **Budget**: before submitting, the fee-bump fee is booked against the merchant's daily budget with `reserve_relayer_fee` (atomic, in `relayer_fee_usage`), then settled to the fee actually charged. Unsubmitted reservations are refunded; an unconfirmed (`202`) relay keeps the full reservation. Over budget returns `429 daily_budget_exceeded`, and a pull costing more than `RELAYER_MAX_FEE_STROOPS` returns `422 fee_cap_exceeded`. `GET /relay/budget` shows today's usage.
- **Throttling**: relay routes have their own per-merchant limit (`RELAYER_RATE_LIMIT_MAX`, default 10/minute) on top of the API key limit.
- `/relay/submit-pull` takes the same per-subscription billing lock and honours `Idempotency-Key` like `/submit-pull`.

Errors carry a machine-readable `code`: `invalid_authorization` (400), `authorization_expired` (400), `invalid_signature` (401), `simulation_failed` (422, e.g. pulling too early), `fee_cap_exceeded` (422), `daily_budget_exceeded` (429), `submission_rejected` (502), `relayer_busy` / `relayer_unavailable` (503).

---

## Database Schema Reference

The API queries the tables defined in `apps/backend/schema.sql`:

- `merchants`: `id` (UUID PK), `wallet_address` (VARCHAR UNIQUE), `name` (VARCHAR), `created_at` (TIMESTAMP).
- `plans`: `id` (UUID PK), `merchant_id` (UUID FK -> `merchants.id`), `name` (VARCHAR), `currency` (`USDC` / `USD` / `EUR`), `usdc_amount` (NUMERIC), `price_amount` (NUMERIC, fiat plans), `interval_seconds` (BIGINT), `created_at` (TIMESTAMP).
- `subscriptions`: `id` (UUID PK), `plan_id` (UUID FK -> `plans.id`), `customer_wallet_address` (VARCHAR), `status` (VARCHAR DEFAULT 'active'), `next_billing_date` (TIMESTAMP), `quoted_rate` (NUMERIC, fiat plans' slippage baseline), `created_at` (TIMESTAMP).
- `idempotency_keys`: `id` (UUID PK), `key` (VARCHAR), `merchant_id` (UUID FK -> `merchants.id`, cascade), `request_path` (VARCHAR), `request_hash` (VARCHAR(64)), `status` (`in_progress` / `completed` / `failed`), `response_code` (INTEGER), `response_body` (JSONB), `created_at`, `updated_at`, `expires_at` (TIMESTAMP). Unique on `(merchant_id, key)`.
- `billing_locks`: `subscription_id` (UUID PK, FK -> `subscriptions.id`), `lock_token` (UUID), `locked_until` (TIMESTAMP), `created_at` (TIMESTAMP).
- `reconciliation_state`: `id` (VARCHAR PK, e.g. `soroban_events`), `event_cursor` (TEXT), `last_ledger` (BIGINT), `updated_at` (TIMESTAMP). Progress markers for the reconciliation worker.
- `api_keys`: `id` (UUID PK), `merchant_id` (UUID FK -> `merchants.id`, cascade), `name` (VARCHAR), `key_prefix` (VARCHAR(16)), `key_hash` (VARCHAR(64), unique SHA-256 hex), `environment` (`live` / `test`), `last_used_at`, `created_at`, `revoked_at` (TIMESTAMP). Active while `revoked_at` is null.
- `relayer_fee_usage`: `merchant_id` (UUID FK -> `merchants.id`, cascade), `usage_date` (DATE, UTC), `fee_stroops` (BIGINT), `tx_count` (INTEGER), `updated_at` (TIMESTAMP). Primary key `(merchant_id, usage_date)`. Daily sponsored fees per merchant, updated through `reserve_relayer_fee` / `adjust_relayer_fee`.
- `exchange_rates`: `base_currency` (VARCHAR), `quote_currency` (VARCHAR DEFAULT 'USDC'), `rate` (NUMERIC), `source` (VARCHAR), `fetched_at` (TIMESTAMP). Append-only history of oracle quotes; the newest row per currency wins. Indexed on `(base_currency, quote_currency, fetched_at DESC)`.

Existing databases can apply the new sections of `schema.sql` (tables 4 to 10, their functions, indexes, `REVOKE`s and RLS statements) as a migration.

### Row Level Security (RLS) Policy Model

Row Level Security is enabled on all tables in `schema.sql` with a locked-down principle of least privilege:

1. **Backend Service Role**: The backend Express API connects with `SUPABASE_SERVICE_ROLE_KEY`. The Postgres service role possesses the `BYPASSRLS` privilege, granting the backend full authority to execute queries, create plans, record subscriptions, and advance billing schedules.
2. **Public Anon Access (Checkout Flow)**: Direct access via the public Supabase anon key is restricted to `SELECT` on `plans` and `merchants`. This allows unauthenticated checkout widgets and client browsers to inspect plan details and the merchant's recipient address.
3. **No Public Mutations**: Open `INSERT` and `UPDATE` policies have been removed from all tables. Clients cannot directly inject plans, alter subscriptions, or create unauthorized merchant accounts with the anon key.
4. **Subscription Confidentiality**: The `subscriptions`, `idempotency_keys`, `billing_locks`, `api_keys` and `reconciliation_state` tables have **no** policies granted to public/anon roles. Postgres default-deny prevents unauthenticated or client-side anon requests from querying subscriber lists or viewing competitor customer accounts.
4. **Subscription Confidentiality**: The `subscriptions`, `idempotency_keys`, `billing_locks`, `api_keys` and `exchange_rates` tables have **no** policies granted to public/anon roles. Postgres default-deny prevents unauthenticated or client-side anon requests from querying subscriber lists, viewing competitor customer accounts, or rewriting the rate history.

---

## Response and Error Conventions

- All JSON responses return UTF-8 encoded text.
- Successful mutations return `201 Created` with a `message` and entity payload (`plan`, `subscription`).
- Successful queries return `200 OK` with an entity or collection payload (`plan`, `subscribers`).
- Errors return an appropriate HTTP status code (`400`, `401`, `404`, `409`, `422`, `500`) with a JSON payload of shape:
  ```json
  {
    "error": "Error description message"
  }
  ```

## Streaming transaction CSV export (#76)

Authenticated merchants can download settled on-chain payments using
`GET /reports/transactions/export` with `Authorization: Bearer <MERCHANT_API_KEY>`.
Optional query parameters: `start_date` and `end_date` (`YYYY-MM-DD`, inclusive),
`plan_id` (UUID), and `status=settled`. Data is sorted by settlement timestamp.
The response is RFC 4180 CSV with CRLF line endings and the
`orbit-transactions.csv` attachment filename. Empty reports have a header row.

This endpoint uses a PostgreSQL server-side cursor; set **server-only**
`DATABASE_URL` to a PostgreSQL connection string for the same Supabase database
used by `SUPABASE_URL`. Do not expose `DATABASE_URL` or the service-role key in
browser/public environment variables or commit them to git. Connection errors
return HTTP 503. Customer and plan fields remain scoped to the authenticated
merchant; supplying another merchant's ID does not grant access.

**Migration:** create the `payment_transactions` table, indexes, and RLS shown
in `schema.sql` before enabling the endpoint. For an existing database, use
only that new migration section in your normal SQL migration workflow; the
complete bootstrap `schema.sql` also creates tables that may already exist.

**Accounting integrity:** amounts are stored in raw USDC units and only when
a successful pull transaction includes the expected `funds_pulled` contract
event. A successful transaction without a decodable matching event logs a
reconciliation error and is **not** represented as a verified settlement.
The export does not backfill old transfers or recover missing events: operators
should plan a ledger indexing/reconciliation job before using reports as a
complete accounting ledger. Stellar RPC history retention is limited.
## Customer Portal (#74)

See [CUSTOMER_PORTAL.md](CUSTOMER_PORTAL.md) for challenge signing, wallet-scoped routes, cancellation, database migrations and security considerations.

## Coupons and promotional quotes (#75 — experimental)

Merchant API-key routes: `POST /coupons`, `GET /coupons`, `PATCH /coupons/:id`
(soft-disable with `{"active":false}`). Coupon codes are unique within each
merchant, case-insensitive at the API boundary. Use `discount_type` `percent`
(maximum 99%) or `amount` (in the plan's billing denomination). `duration_months`
is 1–120; `max_redemptions` and `expires_at` are optional.

Checkout calls `POST /coupons/validate` with `{"plan_id":"...","code":"WELCOME20"}`.
The response provides the first-period discounted quote in raw USDC units or
fiat major units and the promotion's calendar-month duration. Validating a
code does **not** reserve a redemption. `POST /subscriptions` accepts optional
`coupon_code`; the `redeem_coupon_subscription` Postgres function revalidates
and atomically enforces redemption limits and creates the subscription.

Migration: run `apps/backend/coupons-migration.sql` in the Supabase SQL editor
on existing databases. The same schema is appended to `schema.sql` for fresh
installs. Execute it before starting a backend with coupons enabled. Both the
coupons table and the redemption function are private to the service role.

**Critical on-chain limitation:** Orbit's current Soroban `pull_funds` charges
`VaultData.amount_per_interval` from the existing user-authorized vault. A
coupon quote and off-chain promotion record do NOT modify that amount or
automatically revert it after `duration_months`. Coupon subscriptions are
therefore created with `status=pending_promo`,
`promotion_onchain_verified=false`, and the pull API refuses to charge them.
A compatible, wallet-authorized contract/checkout migration plus verification
of the on-chain promotion schedule is needed before activating discounted
recurring billing. This backend-only implementation is not a complete
end-to-end promotional billing feature. Don't deploy it as finished billing.

The public legacy subscription creation route does not itself authenticate a
wallet; production coupon redemption must be coupled to proof of a confirmed
vault handshake to prevent malicious consumption of finite coupon inventories.

## Batched pull (`batch_pull_funds`, #92)

The Soroban contract exposes `batch_pull_funds(merchant, subscribers)` so a
merchant can settle every due subscriber in a single transaction instead of one
`pull_funds` per vault. A batch is capped at `MAX_BATCH_PULL_SUBSCRIBERS` (50)
subscribers, and the call returns a `Vec<BatchPullResult>` with one entry per
subscriber **in the same order as the input**:

| Field | Meaning |
|---|---|
| `subscriber` | The vault owner that was attempted. |
| `success` | `true` if funds were pulled; `false` if the vault was inactive, not due, or already locked. |
| `amount` | Raw token units pulled (`0` when `success` is `false`). |

A subscriber that fails is skipped without reverting the whole batch. Sibling
vaults, auth entries and token state are otherwise untouched. The typed client in
`packages/contract-sdk` exposes this as
`orbit.batchPullFunds({ merchant, subscribers })`.

## Contract SDK and ABI codegen (#159)

Contract calls used to be assembled by hand as `xdr.ScVal` values in several
places. `packages/contract-sdk` (`@orbit/contract-sdk`) now owns one typed
surface, generated from the canonical ABI at
`apps/backend/abi/orbit_soroban.abi.json`.

```bash
cd apps/backend
npm run inspect-contract        # optional: verify ABI against a compiled WASM
npm run generate:contract-sdk   # rewrite packages/contract-sdk/src/generated
```

`inspect-contract` uses the `stellar` CLI to compare the ABI with the exported
WASM functions when a compiled contract is present, and falls back to the
checked-in ABI with a warning otherwise (so generation works without a Rust
toolchain). `generate:contract-sdk` emits the typed `OrbitContractClient`, the
`*Input` interfaces and the ScVal codecs, and mirrors the ABI into the package.
Commit the regenerated file with any ABI change. See
[`packages/contract-sdk/README.md`](../../packages/contract-sdk/README.md) for
usage.

## Merchant payout splits (#160)

Merchants can route a share of each settled pull to other Stellar accounts
(platform fees, partners, affiliates). Each active split rule claims a
percentage of the settlement in basis points; the primary merchant keeps
whatever the splits do not allocate. Rules must use unique recipients and their
combined basis points may not exceed 100% (10000 bps), and a merchant may have at
most 20 active rules.

Routes (all API-key authenticated):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/payout-splits` | List split rules for the merchant. |
| `POST` | `/payout-splits` | Create a rule (`recipient_wallet`, `percentage_basis_points`, optional `label` and `is_active`). |
| `PATCH` | `/payout-splits/:id` | Update a rule's `percentage_basis_points`, `label` or `is_active`. |
| `DELETE` | `/payout-splits/:id` | Deactivate a rule. |
| `GET` | `/payout-distributions` | List recorded distributions and their forward status. |
| `POST` | `/payout-distributions/reconcile` | Retry `pending` forwards and settle them against the chain. |

Allocation runs when a pull settles (`applyPullOutcome` SUCCESS path, shared by
`/submit-pull` and `/relay/submit-pull`). Shares are computed with integer math
and any rounding remainder is awarded to the largest share, so the distributions
always sum to the settled amount and no dust is left behind. Each distribution is
recorded before it is forwarded, so a failed transfer becomes a retryable
`pending` row rather than a lost payout. On-chain transfers are signed by
`SPLIT_RELAYER_SECRET_KEY` (or `RELAYER_SECRET_KEY`) using the token in
`SPLIT_TOKEN_CONTRACT_ID` (or `USDC_CONTRACT_ID`); when neither is configured the
distributions are still recorded as `pending` for manual reconciliation.

Migration: run `apps/backend/migrations/160-payout-splits.sql` on existing
databases (also appended to `schema.sql`).

## Recurring plan price indexation (#164)

Scheduled plan price changes let a merchant raise a plan's price and have it
applied to existing subscribers on a future date, with a configurable advance
notice. Schedules carry an `effective_date`, an `advance_notice_days` window and
the new `new_usdc_amount` (optionally `new_price_amount`).

Routes:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/plans/:id/price-schedules` | API key | List a plan's scheduled changes. |
| `POST` | `/plans/:id/price-schedules` | API key | Schedule a change. |
| `DELETE` | `/price-schedules/:id` | API key | Cancel a `scheduled`/`notified` change. |
| `POST` | `/price-schedules/process` | API key | Run the notice/apply pass once (also useful in tests). |
| `POST` | `/price-reauthorizations/:token/authorize` | Public | Subscriber accepts the updated allowance terms. |

A background worker (also started from `index.js`, interval
`PRICE_INDEXATION_INTERVAL_MS`, default 15 min) first notifies every active
subscriber inside the notice window by minting a one-click re-authorization link
(`plan_price_reauthorizations`), then applies schedules whose effective date has
arrived by updating the plan price and emitting a `plan.price_changed` webhook.
Notices always run before applies, so a change can never take effect without
having been announced. Applying a schedule is idempotent and audited.

Migration: run `apps/backend/migrations/164-plan-price-indexation.sql` on
existing databases (also appended to `schema.sql`).
