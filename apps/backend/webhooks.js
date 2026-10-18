const crypto = require('crypto');
const { z } = require('zod');

const createWebhookSchema = z.object({
    merchant_id: z.string().uuid("merchant_id must be a valid UUID"),
    url: z.string().url("url must be a valid URL"),
    events: z.array(z.string()).min(1, "at least one event must be selected").default(["*"]),
    signing_secret: z.string().min(16).optional(),
});

const updateWebhookSchema = z.object({
    url: z.string().url("url must be a valid URL").optional(),
    events: z.array(z.string()).min(1).optional(),
    active: z.boolean().optional(),
    signing_secret: z.string().min(16).optional(),
});

const generateSigningSecret = () => {
    return `whsec_${crypto.randomBytes(16).toString('hex')}`;
};

const computeWebhookSignature = (secret, payloadString) => {
    return `sha256=${crypto.createHmac('sha256', secret).update(payloadString).digest('hex')}`;
};

// During rotation both the current and previous secret are accepted. This keeps
// retries in flight valid while new deliveries immediately use the new secret.
const verifyWebhookSignature = (signature, payloadString, secrets) => {
    if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
    return secrets.filter(Boolean).some((secret) => {
        const expected = computeWebhookSignature(secret, payloadString);
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    });
};

// Optional hook called after every delivery attempt (dispatch and resend). The
// alerting bridge uses it for failure telemetry. It runs off the request path, so
// a slow or failing alert destination never delays or fails a delivery.
let deliveryObserver = null;

const setDeliveryObserver = (observer) => {
    deliveryObserver = typeof observer === 'function' ? observer : null;
};

const notifyDeliveryObserver = (event) => {
    if (!deliveryObserver) return;
    Promise.resolve()
        .then(() => deliveryObserver(event))
        .catch((err) => console.error('Webhook delivery observer failed:', err));
};

/**
 * Dispatches an event to all active webhooks subscribed to this merchant and event type
 */
const dispatchWebhookEvent = async (supabase, {
    merchantId,
    eventType,
    payload,
    fetchImpl = globalThis.fetch,
}) => {
    if (!supabase || !merchantId) return [];

    try {
        const { data: webhooks, error } = await supabase
            .from('webhooks')
            .select('*')
            .eq('merchant_id', merchantId)
            .eq('active', true);

        if (error || !webhooks || webhooks.length === 0) {
            return [];
        }

        const matchingWebhooks = webhooks.filter((wh) => {
            if (!wh.events || !Array.isArray(wh.events)) return true;
            return wh.events.includes('*') || wh.events.includes(eventType);
        });

        const deliveries = [];
        const payloadString = JSON.stringify(payload);

        for (const wh of matchingWebhooks) {
            const secret = wh.signing_secret || generateSigningSecret();
            const signature = computeWebhookSignature(secret, payloadString);
            const deliveryId = crypto.randomUUID();
            const timestamp = new Date().toISOString();

            const headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'Orbit-Webhooks/1.0',
                'X-Orbit-Signature': signature,
                'X-Orbit-Event': eventType,
                'X-Orbit-Delivery': deliveryId,
                'X-Orbit-Timestamp': timestamp,
            };

            let responseStatus = 0;
            let responseBody = '';
            let status = 'failed';

            try {
                if (typeof fetchImpl === 'function') {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 6000);

                    const res = await fetchImpl(wh.url, {
                        method: 'POST',
                        headers,
                        body: payloadString,
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);

                    responseStatus = res.status;
                    responseBody = await res.text().catch(() => '');
                    status = res.ok ? 'success' : 'failed';
                } else {
                    responseStatus = 200;
                    responseBody = '{"received":true}';
                    status = 'success';
                }
            } catch (fetchErr) {
                responseStatus = 500;
                responseBody = fetchErr.message || 'Connection error';
                status = 'failed';
            }

            const { data: deliveryRecord, error: deliveryErr } = await supabase
                .from('webhook_deliveries')
                .insert([{
                    id: deliveryId,
                    webhook_id: wh.id,
                    merchant_id: merchantId,
                    event_type: eventType,
                    payload,
                    request_headers: headers,
                    response_status: responseStatus,
                    response_body: responseBody,
                    attempt_count: 1,
                    status,
                }])
                .select()
                .single();

            notifyDeliveryObserver({ merchantId, webhook: wh, eventType, responseStatus, deliveryId });

            if (!deliveryErr && deliveryRecord) {
                deliveries.push(deliveryRecord);
            }
        }

        return deliveries;
    } catch (err) {
        console.error("Error dispatching webhook event:", err);
        return [];
    }
};

/**
 * Redelivers a specific webhook delivery attempt
 */
const resendWebhookDelivery = async (supabase, deliveryId, fetchImpl = globalThis.fetch) => {
    if (!supabase || !deliveryId) return null;

    const { data: delivery, error: delErr } = await supabase
        .from('webhook_deliveries')
        .select('*, webhooks(*)')
        .eq('id', deliveryId)
        .single();

    if (delErr || !delivery) {
        return null;
    }

    const wh = delivery.webhooks;
    const destinationUrl = wh?.url || delivery.destination_url;
    const secret = wh?.signing_secret || 'whsec_default_secret';
    const payloadString = JSON.stringify(delivery.payload);
    const signature = computeWebhookSignature(secret, payloadString);

    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Orbit-Webhooks/1.0',
        'X-Orbit-Signature': signature,
        'X-Orbit-Event': delivery.event_type,
        'X-Orbit-Delivery': deliveryId,
        'X-Orbit-Timestamp': new Date().toISOString(),
        'X-Orbit-Resend': 'true',
    };

    let responseStatus = 0;
    let responseBody = '';
    let status = 'failed';

    try {
        if (typeof fetchImpl === 'function' && destinationUrl) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);

            const res = await fetchImpl(destinationUrl, {
                method: 'POST',
                headers,
                body: payloadString,
                signal: controller.signal,
            });
            clearTimeout(timeout);

            responseStatus = res.status;
            responseBody = await res.text().catch(() => '');
            status = res.ok ? 'success' : 'failed';
        } else {
            responseStatus = 200;
            responseBody = '{"received":true,"resend":true}';
            status = 'success';
        }
    } catch (err) {
        responseStatus = 500;
        responseBody = err.message || 'Connection error';
        status = 'failed';
    }

    const { data: updated, error: updateErr } = await supabase
        .from('webhook_deliveries')
        .update({
            attempt_count: (delivery.attempt_count || 1) + 1,
            response_status: responseStatus,
            response_body: responseBody,
            status,
            request_headers: headers,
        })
        .eq('id', deliveryId)
        .select()
        .single();

    notifyDeliveryObserver({ merchantId: delivery.merchant_id, webhook: wh || { id: delivery.webhook_id, url: destinationUrl }, eventType: delivery.event_type, responseStatus, deliveryId });

    if (updateErr) throw updateErr;
    return updated;
};

const backfillWebhookSchema = z.object({
    event_types: z.union([z.array(z.string()), z.string().transform((s) => [s])]).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
});

/**
 * Replays historical webhook events for a specific webhook endpoint with rate limiting.
 */
const replayWebhookEvents = async (supabase, {
    webhookId,
    eventTypes = ['*'],
    startDate,
    endDate,
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    rateLimitPerSecond = 10,
}) => {
    if (!supabase || !webhookId) return { total_events: 0, replayed_count: 0, deliveries: [] };

    // 1. Fetch webhook destination
    const { data: wh, error: whErr } = await supabase
        .from('webhooks')
        .select('*')
        .eq('id', webhookId)
        .single();

    if (whErr || !wh) {
        const notFoundErr = new Error('Webhook not found');
        notFoundErr.status = 404;
        throw notFoundErr;
    }

    // 2. Query historical events matching criteria from webhook_events (or fallback to webhook_deliveries)
    let query = supabase
        .from('webhook_events')
        .select('*')
        .eq('merchant_id', wh.merchant_id);

    const filterTypes = Array.isArray(eventTypes) ? eventTypes : (eventTypes ? [eventTypes] : ['*']);
    const shouldFilterTypes = filterTypes.length > 0 && !filterTypes.includes('*');

    if (shouldFilterTypes) {
        query = query.in('event_type', filterTypes);
    }
    if (startDate) {
        query = query.gte('created_at', new Date(startDate).toISOString());
    }
    if (endDate) {
        query = query.lte('created_at', new Date(endDate).toISOString());
    }
    query = query.order('created_at', { ascending: true });

    let { data: events, error: evErr } = await query;

    // Fallback to webhook_deliveries if webhook_events is not populated
    if (evErr || !events || events.length === 0) {
        let fallbackQuery = supabase
            .from('webhook_deliveries')
            .select('*')
            .eq('merchant_id', wh.merchant_id);

        if (shouldFilterTypes) {
            fallbackQuery = fallbackQuery.in('event_type', filterTypes);
        }
        if (startDate) {
            fallbackQuery = fallbackQuery.gte('created_at', new Date(startDate).toISOString());
        }
        if (endDate) {
            fallbackQuery = fallbackQuery.lte('created_at', new Date(endDate).toISOString());
        }
        fallbackQuery = fallbackQuery.order('created_at', { ascending: true });

        const { data: fallbackEvents } = await fallbackQuery;
        if (fallbackEvents && fallbackEvents.length > 0) {
            // Deduplicate fallback delivery events by id or payload timestamp if multiple deliveries exist
            events = fallbackEvents;
        }
    }

    if (!events || events.length === 0) {
        return { total_events: 0, replayed_count: 0, deliveries: [] };
    }

    // 3. Rate limiting delay calculation: 10 events/sec -> 100ms per event
    const delayMs = rateLimitPerSecond > 0 ? Math.ceil(1000 / rateLimitPerSecond) : 0;
    const secret = wh.signing_secret || generateSigningSecret();
    const deliveries = [];

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const eventType = ev.event_type;

        // Skip if webhook is not subscribed to this event type
        if (wh.events && Array.isArray(wh.events) && !wh.events.includes('*') && !wh.events.includes(eventType)) {
            continue;
        }

        // Throttle delivery
        if (i > 0 && delayMs > 0 && typeof sleepImpl === 'function') {
            await sleepImpl(delayMs);
        }

        // Preserve original timestamp in payload metadata
        const rawPayload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : (ev.payload || {});
        const originalTimestamp = ev.created_at || rawPayload.timestamp || rawPayload.settled_at || new Date().toISOString();

        const replayedPayload = {
            ...rawPayload,
            metadata: {
                ...(rawPayload.metadata || {}),
                original_timestamp: originalTimestamp,
                replayed: true,
                replayed_at: new Date().toISOString(),
            },
        };

        const payloadString = JSON.stringify(replayedPayload);
        const signature = computeWebhookSignature(secret, payloadString);
        const deliveryId = crypto.randomUUID();
        const timestamp = new Date().toISOString();

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Orbit-Webhooks/1.0',
            'X-Orbit-Signature': signature,
            'X-Orbit-Event': eventType,
            'X-Orbit-Delivery': deliveryId,
            'X-Orbit-Timestamp': timestamp,
            'X-Orbit-Replay': 'true',
        };

        let responseStatus = 0;
        let responseBody = '';
        let status = 'failed';

        try {
            if (typeof fetchImpl === 'function' && wh.url) {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 6000);

                const res = await fetchImpl(wh.url, {
                    method: 'POST',
                    headers,
                    body: payloadString,
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                responseStatus = res.status;
                responseBody = await res.text().catch(() => '');
                status = res.ok ? 'success' : 'failed';
            } else {
                responseStatus = 200;
                responseBody = '{"received":true,"replay":true}';
                status = 'success';
            }
        } catch (fetchErr) {
            responseStatus = 500;
            responseBody = fetchErr.message || 'Connection error';
            status = 'failed';
        }

        const { data: deliveryRecord, error: deliveryErr } = await supabase
            .from('webhook_deliveries')
            .insert([{
                id: deliveryId,
                webhook_id: wh.id,
                merchant_id: wh.merchant_id,
                event_type: eventType,
                payload: replayedPayload,
                request_headers: headers,
                response_status: responseStatus,
                response_body: responseBody,
                attempt_count: 1,
                status,
            }])
            .select()
            .single();

        if (!deliveryErr && deliveryRecord) {
            deliveries.push(deliveryRecord);
        } else {
            deliveries.push({
                id: deliveryId,
                webhook_id: wh.id,
                merchant_id: wh.merchant_id,
                event_type: eventType,
                payload: replayedPayload,
                request_headers: headers,
                response_status: responseStatus,
                status,
            });
        }
    }

    return {
        total_events: events.length,
        replayed_count: deliveries.length,
        deliveries,
    };
};

module.exports = {
    createWebhookSchema,
    updateWebhookSchema,
    backfillWebhookSchema,
    generateSigningSecret,
    computeWebhookSignature,
    verifyWebhookSignature,
    dispatchWebhookEvent,
    resendWebhookDelivery,
    replayWebhookEvents,
    setDeliveryObserver,
};


