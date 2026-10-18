# Congestion, metered usage, retention, and notification operations

Apply `apps/backend/migrations/140-142-148-fees-usage-cohorts-notifications.sql` to an existing database. Fresh installs receive the same objects from `schema.sql`.

## Stellar congestion

Unsigned merchant pulls use Horizon `fee_stats` p75 bids; sponsored priority pulls use p95. A sponsored transaction still missing after two ledgers is rewrapped as a higher-fee Stellar fee-bump transaction. The signed inner envelope, source sequence, and Soroban authorization never change, so replacement cannot execute the subscription settlement twice. Configure `HORIZON_URL`, `RELAYER_MAX_FEE_STROOPS`, and the relayer budget variables.

## Metered usage

`POST /usage-records` requires a merchant API key and accepts `subscription_id`, `metric`, positive integer `quantity`, a stable `idempotency_key`, and optional `occurred_at`. Redis uses an atomic Lua operation with integer `HINCRBY`; HyperLogLog is intentionally not used for additive quantities. Closed five-minute windows are committed to hourly `usage_rollups`. `commit_usage_window` records each window key in the same database transaction, making a worker retry safe after a crash. `GET /usage-reconciliation/:subscriptionId` compares period consumption with `plans.usage_limit`.

Set `REDIS_URL`; ingestion returns 503 rather than silently degrading to process memory. The worker runs every `USAGE_ROLLUP_INTERVAL_MS` (default 300000 ms). `POST /usage-rollups/run` is an authenticated operational trigger.

## Retention cohorts

The migration installs a status-history trigger and records every future transition. It backfills known acquisition dates, but deliberately records legacy non-active state at migration time instead of inventing a historical churn date. `GET /analytics/cohorts` supports `plan_id`, `from`, and `to`; heatmap drilldowns return wallets whose recorded status was not retained at that month end.

## Transactional templates

Templates are authenticated merchant records for payment receipts, activation, failed/past-due payment, and cancellation. Markdown is HTML-escaped before a small formatting subset is applied. Test dispatch is real: configure `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`, and a verified `merchants.notification_email`. `POST /notification-templates/:type/test` sends only to that database-bound merchant address; it does not accept a caller-supplied recipient.
