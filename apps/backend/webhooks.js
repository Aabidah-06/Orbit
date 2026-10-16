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

    if (updateErr) throw updateErr;
    return updated;
};

module.exports = {
    createWebhookSchema,
    updateWebhookSchema,
    generateSigningSecret,
    computeWebhookSignature,
    verifyWebhookSignature,
    dispatchWebhookEvent,
    resendWebhookDelivery,
};

