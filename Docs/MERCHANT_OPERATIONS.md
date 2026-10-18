# Merchant operations: indexing, GraphQL, payroll review, and billing recovery

## Install and migrate

Use Node.js 22.12+ (Apollo Server 5 requires Node 20+, and the existing Vitest/Vite
toolchain requires Node 22.12+). Install with `npm ci` in both `apps/backend` and
`apps/frontend`.

For a new Supabase database, execute `apps/backend/schema.sql`. For an existing
database, apply these files in order with the database administrator:

1. `apps/backend/migrations/101-ledger-checkpoints.sql`
2. `apps/backend/migrations/102-merchant-analytics.sql`
3. `apps/backend/migrations/105-billing-resolution.sql`

These add backend-only tables/functions and `subscriptions.last_failure`. No new
public write policies are introduced. Functions that accept a merchant ID can
only be called by the backend service role; browser clients must use the API.

## Persistent contract event indexing (#101)

Configure `INDEXER_START_LEDGER` to the contract's deployment ledger, or the first
ledger you intend to ingest, and start the API with `node index.js`.
`ORBIT_CONTRACT_ID`, `SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE` identify
the stream. The worker uses Soroban RPC `getEvents` for contract events and
`getLatestLedger` for lag; it does not depend on a Horizon account-payment stream.

Every batch drains all event pages in its ledger window. The PostgreSQL function
`commit_ledger_batch` locks the checkpoint row, checks the expected previous
sequence, inserts deduplicated events, and advances the sequence in one
transaction. Failure anywhere rolls everything back. Concurrent stale workers
reload instead of overwriting progress. Empty windows advance too. On restart,
ingestion starts at `last_processed_ledger_sequence + 1`.

The starting ledger must be within the RPC provider's retained history. If an
outage outlasts retention, the worker reports an error and requires archival
backfill; it never silently skips to the latest ledger. A checkpoint ahead of
the RPC node also makes readiness unhealthy.

Settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `INDEXER_START_LEDGER` | unset | Required to enable indexing; inclusive initial ledger |
| `INDEXER_BATCH_SIZE` | `100` | Ledgers per atomic batch; range 1–1000 |
| `INDEXER_INTERVAL_MS` | `5000` | Poll interval |

`GET /health/ready` returns `last_processed_ledger_sequence`, `latest_ledger`, and
`ledger_lag`. A lag **greater than 20**, a processing/RPC error, or an unconfigured
worker returns HTTP 503 with a warning. Healthy readiness returns HTTP 200.
Structured critical logs include `ledger_indexer_lag` and
`ledger_ingestion_failed`. Event values preserve large integer amounts as strings.

## Federated analytics API (#102)

`POST /graphql` runs Apollo Server using the Express 5 integration and an Apollo
Federation 2 schema. `Merchant`, `Plan`, and `Subscription` have entity keys, and
`_service`/`_entities` support composition into an Apollo gateway/router. The
single endpoint works directly with the existing Supabase data; no separate
router process is required for this repository's one analytics service.

Authenticate with the same `Authorization: Bearer orb_test_...` or `orb_live_...`
key used by merchant REST routes. Authentication, rate limiting, and private-field
ownership checks apply to the whole graph, including entity references.
Caller-supplied merchant IDs and wallet-address headers never grant access.

Wallet authentication is also available for registered merchants:

1. `POST /auth/wallet/challenge` with `{ "address": "G..." }`.
2. Sign the returned `message` with Freighter `signMessage` (Stellar's signed
   message convention).
3. Send one GraphQL request with
   `Authorization: Wallet <nonce>:<base64 signature>`.

Challenges expire after five minutes and are consumed once, including failed
verification attempts. A fresh challenge is required for another request.
The verified wallet must match a merchant record in Supabase.

```graphql
query Dashboard($id: ID!) {
  merchant(id: $id) {
    name
    plans { id name amount currency intervalSeconds }
    subscriptions(filter: { status: "past_due" }, pagination: { limit: 25, offset: 0 }) {
      total
      nodes {
        id
        customerWalletAddress
        plan { name merchant { id } }
        payments(pagination: { limit: 5 }) { amount transactionHash createdAt }
      }
    }
    payrollSplits(pagination: { limit: 25 }) { recipientWallet amount currency }
  }
  analytics(timeframe: { from: "2026-10-01", to: "2026-11-01" }) {
    activeSubscribers
    settledPayments
    settledAmount
  }
}
```

The top-level `subscribers(filter, pagination)` query supports status, plan ID,
and an exact wallet address. Pagination uses stable creation-date/ID ordering,
with a default limit of 50, maximum 100, and maximum offset of 100000. Timeframes
are inclusive at `from`, exclusive at `to`, and limited to 366 days. The
`activeSubscribers` metric is the current active count; payment metrics use the
requested timeframe. Queries are limited to 10 levels and 500 expanded fields.

DataLoaders are created per authenticated request. Plan and merchant lookups
batch by ID; nested payment histories batch into one SQL query with independent
per-subscription limits. SQL calculates aggregate analytics without downloading
every subscription or payment row.

`Payment` comes from successful `pull.execute` audit records. New settlements
record their raw USDC amount; older records without an amount return null and
contribute to the settlement count but not the amount sum. Amounts are strings
to preserve token precision. `PayrollSplit` exposes existing `tax_transactions`
records; the contract's aggregate `batch_disbursed` event alone does not contain
individual recipient allocations. These analytics do not fabricate missing
historical records or settlement amounts.

## Payroll review (#104)

Upload three-column `Name,StellarWallet,AmountUSDC` or four-column
`Name,Role,StellarWallet,AmountUSDC` CSVs. Wallets must pass Stellar public-key
validation. Amounts must be positive decimal values with at most seven decimal
places, within JavaScript's safe raw-token-unit range. Invalid rows are reported
and excluded; an invalid-only upload clears the previous manifest.

Duplicate ready-to-pay wallets are highlighted and block execution. Merchants
can remove rows or merge amounts using integer token units. Previously disbursed
rows are never folded into new payouts. Search matches name or wallet; the name
and amount headers toggle sorting. Filtering never changes the total batch.

Use **Save contractor** on a row, then **Saved contractors → Quick add** for the
next payroll. Profiles are stored in browser localStorage under the signed-in
merchant's ID and validated again when loaded. They are local to that browser,
not a shared or authoritative identity registry. Address validation establishes
key syntax, not the identity of its owner.

## Past-due resolution (#105)

In Subscribers, switch to **Live API** and enter a merchant API key. It stays in
memory for the page session. The backend key determines merchant ownership;
local dashboard profile IDs are not used to authorize access.

**Resolve payment** opens a native, focus-managed dialog:

- Diagnostics show recorded insufficient-balance, expired/insufficient-allowance,
  RPC-timeout, or unknown failures. Unrecognized contract errors remain unknown
  rather than being mislabeled.
- **Retry Pull Now** connects Freighter, simulates through `/trigger-pull`, checks
  the connected wallet against the registered merchant, requests a signature,
  and submits through `/submit-pull`. Only confirmed settlement refreshes billing
  state. A pending/unknown outcome shows its transaction hash and prevents
  another charge or waiver in the dialog. Check that transaction's outcome before
  further recovery; an unknown result is never presented as a paid cycle.
  **Check transaction status** uses the saved hash to query RPC. A confirmed
  success atomically reconciles billing and its settlement audit record exactly
  once; a confirmed failure permits a fresh retry. Unknown outcomes stay pending.
- **Copy Recovery Link** copies a direct `/pay/<plan-id>?recovery=true...` checkout
  URL. The customer still signs token approval and vault authorization. The
  random link token grants no API authority. An existing subscription is expected
  during recovery; renewing authorization does not mark its past-due charge paid.
- **Waive Interval** requires a second explicit confirmation. The authenticated,
  idempotent `/subscriptions/:id/waive` route holds the billing lease while SQL
  records an audit entry, clears dunning/failure state, and advances the next
  billing date by an interval from the later of now or the current billing date.
  It records forgiveness, transfers no tokens, and does not increase settled
  revenue. Only a past-due subscription can be waived.

Demo subscriptions show the dialog with live mutations disabled. No wallet or
database mutations are performed by the demo controls.

## Local verification

```bash
cd apps/backend
npm test                          # includes embedded PostgreSQL transaction tests

cd ../frontend
npm run typecheck
npm run lint                     # includes TypeScript/React and Next.js rules
npm test                         # payroll precision, duplicates, search, sorting
npx playwright install chromium  # once, if Chromium is not already installed
npm run test:e2e                  # mocked API and Freighter bridge; no real charges
npm run build
```

Browser tests use port 3105 and exercise a 600-recipient CSV, address-book reload,
recovery-link clipboard copying, explicit waiver confirmation, signed retry
submission, and pending-transaction handling. They capture the payroll review
and resolution dialog under `apps/frontend/screenshots/` for PR review.
