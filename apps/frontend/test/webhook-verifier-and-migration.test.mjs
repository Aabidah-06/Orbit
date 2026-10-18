import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  computeHmacSha256Hex,
  generateSignedWebhookTestBundle,
  generateWebhookVerificationCode,
  parseOrbitSignatureHeader,
  verifyWebhookSignature,
} from "../src/lib/webhook-verifier.ts";
import {
  calculateEffectivePlanPrice,
  completeSubscriberTierUpgrade,
  computeMigrationCampaignStats,
  createPlanMigrationCampaign,
  enforceCampaignSunset,
  evaluatePlanLifecyclePolicy,
} from "../src/lib/plan-migration.ts";

test("HMAC-SHA256 implementation matches Node.js crypto.createHmac exactly (#182)", () => {
  const secret = "whsec_9482f3a7c1b0e4d28e7c9f0158b246";
  const payload = '1729260000.{"event":"payment.settled","amount":29}';
  const expected = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const actual = computeHmacSha256Hex(secret, payload);
  assert.equal(actual, expected);
});

test("verifyWebhookSignature validates valid signatures and classifies expired, mutated, and malformed inputs (#182)", () => {
  const secret = "whsec_live_orbit_verification_secret";
  const nowUnixSeconds = 1_760_000_000;

  const bundle = generateSignedWebhookTestBundle({
    secret,
    event: "payment.settled",
    timestampSeconds: nowUnixSeconds - 45,
  });

  // 1. Valid signature within 5-minute window
  const validResult = verifyWebhookSignature({
    signingSecret: secret,
    rawBody: bundle.rawBody,
    signatureHeader: bundle.signatureHeader,
    nowUnixSeconds,
  });
  assert.equal(validResult.isValid, true);
  assert.equal(validResult.diagnosticCode, "VALID_SIGNATURE");
  assert.equal(validResult.diagnosticTitle, "Valid Signature");
  assert.equal(validResult.expectedDigestHex, bundle.digestHex);

  // 2. Expired timestamp (>5 mins)
  const expiredResult = verifyWebhookSignature({
    signingSecret: secret,
    rawBody: bundle.rawBody,
    signatureHeader: bundle.signatureHeader,
    nowUnixSeconds: nowUnixSeconds + 600,
  });
  assert.equal(expiredResult.isValid, false);
  assert.equal(expiredResult.diagnosticCode, "TIMESTAMP_EXPIRED");
  assert.equal(expiredResult.diagnosticTitle, "Timestamp expired (>5 mins)");

  // 3. Digest mismatch due to JSON body whitespace mutation
  const compactBody = JSON.stringify(JSON.parse(bundle.rawBody));
  const whitespaceMismatch = verifyWebhookSignature({
    signingSecret: secret,
    rawBody: compactBody,
    signatureHeader: bundle.signatureHeader,
    nowUnixSeconds,
  });
  assert.equal(whitespaceMismatch.isValid, false);
  assert.equal(whitespaceMismatch.diagnosticCode, "DIGEST_MISMATCH");
  assert.equal(whitespaceMismatch.whitespaceNormalizedMatch, true);

  // 4. Malformed header
  const malformedResult = verifyWebhookSignature({
    signingSecret: secret,
    rawBody: bundle.rawBody,
    signatureHeader: "invalid_header_value",
    nowUnixSeconds,
  });
  assert.equal(malformedResult.isValid, false);
  assert.equal(malformedResult.diagnosticCode, "MALFORMED_HEADER");
  assert.equal(parseOrbitSignatureHeader("sha256=" + bundle.digestHex).scheme, "sha256");
});

test("generateWebhookVerificationCode produces valid snippets for all 6 supported languages (#182)", () => {
  const languages = ["nodejs", "python", "go", "rust", "php", "ruby"];
  for (const lang of languages) {
    const snippet = generateWebhookVerificationCode(lang, "whsec_custom_123");
    assert.ok(snippet.code.length > 100);
    assert.ok(snippet.framework.length > 2);
  }
});

test("Plan migration campaign deprecates legacy plan for new signups while servicing existing subscribers until sunset (#183)", () => {
  const legacyPlan = {
    id: "plan_legacy_starter",
    name: "AI Engine Starter",
    amount: 15.0,
    currency: "USDC",
    intervalDays: 30,
    network: "stellar-testnet",
    activeSubscribers: 3,
    status: "active",
    createdAt: "2026-09-01T00:00:00Z",
  };
  const targetPlan = {
    id: "plan_mailkit_pro",
    name: "MailKit Pro",
    amount: 30.0,
    currency: "USDC",
    intervalDays: 30,
    network: "stellar-testnet",
    activeSubscribers: 86,
    status: "active",
    createdAt: "2026-09-01T00:00:00Z",
  };

  assert.equal(calculateEffectivePlanPrice(30.0, 20), 24.0);

  const { campaign, updatedLegacyPlan } = createPlanMigrationCampaign({
    legacyPlan,
    targetPlan,
    sunsetDate: "2026-12-01T00:00:00.000Z",
    discountPercent: 20,
    subscriberWallets: [
      { id: "sub_1", walletAddress: "GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2" },
      { id: "sub_2", walletAddress: "GALI37H9P4B2N8C1X6K5M7W9D0F3L8T2V4J7R9Q0" },
      { id: "sub_3", walletAddress: "GMAR51K9T3R7V2D8L4C0F6A2H8J1K5W9Y3K7M2P6" },
    ],
  });

  assert.equal(updatedLegacyPlan.status, "deprecated");
  assert.equal(campaign.effectiveTargetAmount, 24.0);
  assert.equal(campaign.subscribers.length, 3);

  // Before sunset date: new signups disabled, existing unmigrated subscriber pulls allowed
  const gracePolicy = evaluatePlanLifecyclePolicy(
    updatedLegacyPlan,
    "2026-11-15T00:00:00.000Z"
  );
  assert.equal(gracePolicy.allowNewSignups, false);
  assert.equal(gracePolicy.allowExistingSubscriberPulls, true);
  assert.equal(gracePolicy.lifecycleStage, "deprecated_grace_period");

  // After sunset date: both new signups and unmigrated pulls disabled
  const postSunsetPolicy = evaluatePlanLifecyclePolicy(
    updatedLegacyPlan,
    "2026-12-02T00:00:00.000Z"
  );
  assert.equal(postSunsetPolicy.allowNewSignups, false);
  assert.equal(postSunsetPolicy.allowExistingSubscriberPulls, false);
  assert.equal(postSunsetPolicy.lifecycleStage, "sunset_enforced");

  // Simulate 1-click subscriber upgrades & verify progress stats
  const afterOneUpgrade = completeSubscriberTierUpgrade(campaign, "sub_1", "0xabc123");
  const stats = computeMigrationCampaignStats(
    afterOneUpgrade,
    "2026-11-15T00:00:00.000Z"
  );
  assert.equal(stats.totalSubscribers, 3);
  assert.equal(stats.migratedCount, 1);
  assert.equal(stats.pendingCount, 2);
  assert.equal(stats.completionPercent, 33);
  assert.equal(stats.legacyMonthlyMrr, 45.0);
  assert.equal(stats.projectedMigratedMrr, 72.0);
  assert.equal(stats.netMrrDelta, 27.0);

  // Enforce sunset cutoff on remaining unmigrated subscribers
  const sunsetEnforced = enforceCampaignSunset(
    afterOneUpgrade,
    "2026-12-05T00:00:00.000Z"
  );
  assert.equal(sunsetEnforced.status, "sunset_enforced");
  assert.equal(
    sunsetEnforced.subscribers.filter((s) => s.state === "sunset_expired").length,
    2
  );
});
