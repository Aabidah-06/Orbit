const crypto = require('crypto');
const { dispatchWebhookEvent } = require('./webhooks');
const { writeAuditLog } = require('./audit');

// Dunning retry intervals: Day 1, Day 3, Day 5, Day 7
const DUNNING_INTERVAL_DAYS = [1, 3, 5, 7];
const MAX_DUNNING_RETRIES = 4;

/**
 * Calculates the next retry timestamp based on retry count
 * @param {number} retryIndex - 0-based retry attempt index
 * @param {Date} baseDate - reference date
 * @returns {Date|null}
 */
const calculateNextDunningRetry = (retryIndex, baseDate = new Date()) => {
    if (retryIndex < 0 || retryIndex >= DUNNING_INTERVAL_DAYS.length) {
        return null;
    }
    const daysToAdd = DUNNING_INTERVAL_DAYS[retryIndex];
    return new Date(baseDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
};

/**
 * Generates unique payment recovery link allowing subscriber to top up and re-trigger
 */
const generateRecoveryLink = (subscriptionId, options = {}) => {
    const baseUrl = options.baseUrl || process.env.FRONTEND_URL || 'https://useorbit.xyz';
    const recoveryToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const recoveryUrl = `${baseUrl}/pay/${options.planId || subscriptionId}?recovery=true&token=${recoveryToken}`;
    return {
        recovery_url: recoveryUrl,
        recovery_token: recoveryToken,
        expires_at: expiresAt,
        subscription_id: subscriptionId,
    };
};

/**
 * Initializes a past_due subscription into the dunning cycle
 */
const markSubscriptionPastDue = async (supabase, subscriptionId, {
    actorAddress = null,
    ipAddress = null,
    now = new Date(),
    fetchImpl = globalThis.fetch,
} = {}) => {
    if (!supabase || !subscriptionId) return null;

    // Load subscription with plan
    const { data: sub, error: subErr } = await supabase
        .from('subscriptions')
        .select('*, plans(*)')
        .eq('id', subscriptionId)
        .single();

    if (subErr || !sub) return null;

    const nextRetryDate = calculateNextDunningRetry(0, now);
    const merchantId = sub.plans?.merchant_id;
    const recovery = generateRecoveryLink(subscriptionId, { planId: sub.plan_id });

    const changesBefore = {
        status: sub.status,
        retry_count: sub.retry_count,
        dunning_status: sub.dunning_status,
        next_dunning_retry_at: sub.next_dunning_retry_at,
    };

    const changesAfter = {
        status: 'past_due',
        retry_count: 0,
        dunning_status: 'pending',
        next_dunning_retry_at: nextRetryDate ? nextRetryDate.toISOString() : null,
    };

    await supabase
        .from('subscriptions')
        .update(changesAfter)
        .eq('id', subscriptionId);

    // Write audit log
    await writeAuditLog(supabase, {
        merchantId,
        actorAddress,
        action: 'subscription.past_due',
        resourceType: 'subscription',
        resourceId: subscriptionId,
        ipAddress,
        changesBefore,
        changesAfter,
    });

    // Dispatch webhook notifications
    if (merchantId) {
        await dispatchWebhookEvent(supabase, {
            merchantId,
            eventType: 'subscription.past_due',
            payload: {
                event: 'subscription.past_due',
                subscription_id: subscriptionId,
                customer_wallet_address: sub.customer_wallet_address,
                amount: sub.plans?.usdc_amount,
                retry_count: 0,
                next_retry_at: changesAfter.next_dunning_retry_at,
                recovery_url: recovery.recovery_url,
            },
            fetchImpl,
        });
    }

    return { ...sub, ...changesAfter, recovery_link: recovery.recovery_url };
};

/**
 * Processes dunning retries across due past-due subscriptions
 */
const processDunningRetries = async (supabase, {
    merchantId = null,
    now = new Date(),
    fetchImpl = globalThis.fetch,
} = {}) => {
    if (!supabase) return { processed: 0, results: [] };

    let query = supabase
        .from('subscriptions')
        .select('*, plans(*)')
        .eq('status', 'past_due');

    if (merchantId) {
        query = query.eq('plans.merchant_id', merchantId);
    }

    const { data: subs, error } = await query;
    if (error || !subs) return { processed: 0, results: [], error: error?.message };

    const results = [];
    const currentTime = now.getTime();

    for (const sub of subs) {
        const nextRetry = sub.next_dunning_retry_at ? new Date(sub.next_dunning_retry_at).getTime() : 0;
        // Check if retry is due
        if (nextRetry > currentTime) {
            continue;
        }

        const currentRetryCount = sub.retry_count || 0;
        const newRetryCount = currentRetryCount + 1;
        const currentMerchantId = sub.plans?.merchant_id;
        const recovery = generateRecoveryLink(sub.id);

        if (newRetryCount >= MAX_DUNNING_RETRIES) {
            // 7 days elapsed / 4 attempts exhausted -> permanently transition to cancelled
            const changesBefore = {
                status: sub.status,
                retry_count: sub.retry_count,
                dunning_status: sub.dunning_status,
            };
            const changesAfter = {
                status: 'cancelled',
                dunning_status: 'exhausted',
                next_dunning_retry_at: null,
            };

            await supabase
                .from('subscriptions')
                .update(changesAfter)
                .eq('id', sub.id);

            await writeAuditLog(supabase, {
                merchantId: currentMerchantId,
                actorAddress: sub.customer_wallet_address,
                action: 'subscription.dunning_cancelled',
                resourceType: 'subscription',
                resourceId: sub.id,
                changesBefore,
                changesAfter,
            });

            if (currentMerchantId) {
                await dispatchWebhookEvent(supabase, {
                    merchantId: currentMerchantId,
                    eventType: 'subscription.cancelled',
                    payload: {
                        event: 'subscription.cancelled',
                        subscription_id: sub.id,
                        customer_wallet_address: sub.customer_wallet_address,
                        reason: 'dunning_exhausted',
                        total_retries: newRetryCount,
                    },
                    fetchImpl,
                });
            }

            results.push({
                subscription_id: sub.id,
                action: 'cancelled',
                retry_count: newRetryCount,
                status: 'cancelled',
            });
        } else {
            // Schedule next retry (e.g. Day 3, Day 5, Day 7)
            const nextDate = calculateNextDunningRetry(newRetryCount, now);
            const changesBefore = {
                retry_count: sub.retry_count,
                dunning_status: sub.dunning_status,
                next_dunning_retry_at: sub.next_dunning_retry_at,
            };
            const changesAfter = {
                retry_count: newRetryCount,
                dunning_status: 'in_progress',
                next_dunning_retry_at: nextDate ? nextDate.toISOString() : null,
            };

            await supabase
                .from('subscriptions')
                .update(changesAfter)
                .eq('id', sub.id);

            await writeAuditLog(supabase, {
                merchantId: currentMerchantId,
                actorAddress: sub.customer_wallet_address,
                action: 'subscription.dunning_retry',
                resourceType: 'subscription',
                resourceId: sub.id,
                changesBefore,
                changesAfter,
            });

            if (currentMerchantId) {
                await dispatchWebhookEvent(supabase, {
                    merchantId: currentMerchantId,
                    eventType: 'dunning.attempt_failed',
                    payload: {
                        event: 'dunning.attempt_failed',
                        subscription_id: sub.id,
                        customer_wallet_address: sub.customer_wallet_address,
                        retry_count: newRetryCount,
                        next_retry_at: changesAfter.next_dunning_retry_at,
                        recovery_url: recovery.recovery_url,
                    },
                    fetchImpl,
                });
            }

            results.push({
                subscription_id: sub.id,
                action: 'scheduled_next_retry',
                retry_count: newRetryCount,
                next_dunning_retry_at: changesAfter.next_dunning_retry_at,
            });
        }
    }

    return { processed: results.length, results };
};

module.exports = {
    DUNNING_INTERVAL_DAYS,
    MAX_DUNNING_RETRIES,
    calculateNextDunningRetry,
    generateRecoveryLink,
    markSubscriptionPastDue,
    processDunningRetries,
};
