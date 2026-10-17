# Customer portal authentication and endpoints (#74)

The portal is separate from merchant API-key authentication. **Do not trust a
wallet_address from request parameters** for authorization: only a verified
session's `sub` claim determines the wallet for data reads/cancellation.

1. Generate a unique, secret 32+ byte signing key and set
   `CUSTOMER_PORTAL_JWT_SECRET` in the backend deployment environment. Never
   use the sample value from tests or expose the secret to the frontend.
2. Apply `customer-portal-schema.sql` as a migration to your existing Supabase
   database. New deployments can use the updated `schema.sql` once patched.
3. `POST /customer-portal/auth` with `{"wallet_address":"G..."}` creates a
   single-use, five-minute challenge. Wallet signs **the exact UTF-8 bytes**
   of the `message` (not a transaction, and not just the nonce). Use Freighter's
   message-signing API or an equivalent Ed25519 wallet signature.
4. `POST /customer-portal/auth` with `wallet_address`, `challenge_id`, and
   `signature` (standard base64 of 64 raw Ed25519 signature bytes) verifies
   the wallet and consumes the challenge atomically. Returns a signed
   **15-minute** bearer JWT. Rate-limit auth endpoints at the edge as well.
5. `GET /customer-portal/subscriptions?page=1&limit=50` lists active
   subscriptions across plans and merchants for that signed-in wallet only.
6. `GET /customer-portal/receipts` lists confirmed on-chain pull audit
   confirmations for the verified wallet. The returned `download_url` points
   to `GET /customer-portal/receipts/:id/download`, returning a downloadable
   JSON confirmation with transaction hash and explorer URL; this is *not*
   a tax invoice and does **not** imply a verified numeric amount.
7. `POST /customer-portal/cancel` with `{"subscription_id":"UUID"}` prepares
   unsigned `cancel_vault` XDR using the wallet as source. The wallet must
   approve/sign and broadcast it. **Preparing does not revoke the vault or
   update the subscription database status**; reconcile only after chain
   confirmation. The merchant's address comes from the stored plan relation.
8. `POST /customer-portal/logout` revokes the DB session. Expired sessions
   are rejected even if a token's signature is valid.

All portal data endpoints require `Authorization: Bearer <customer JWT>` and
`Cache-Control: no-store` should be set by the deployment's reverse proxy as
well. The service role alone may read the protected view and tables.

## Legacy subscription routes secured

The legacy `GET /subscriptions/:id/timeline` and `POST` routes for
`/subscriptions/:id/cancel`, `/subscriptions/:id/refund`, and
`/subscriptions/:id/recovery-link` now require an **authenticated merchant API
key** and check that the subscription's plan belongs to that merchant. A
cross-merchant request returns 404 without revealing the record.

**Compatibility note:** the existing browser dashboard calls some of these
routes without a merchant key. Those calls will receive 401 until the app is
updated to use an authenticated, server-side merchant API proxy. Do **not** put
merchant API keys in browser JavaScript or weaken these checks to restore the
old behavior. Customer JWTs are accepted only by `/customer-portal/*` routes.
Other legacy backend endpoints should undergo their own authorization audit.

## Testing

```bash
cd apps/backend
npm ci
npm test
```

A live testnet check should verify that prepared cancellation XDR signs and
successfully executes against the deployed Soroban contract. Unit tests use
local Stellar keypairs and mocked Supabase, not production credentials.
