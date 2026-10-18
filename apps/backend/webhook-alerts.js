const crypto = require('crypto');
const { z } = require('zod');

// Rolling window used for the per-endpoint failure rate (15 minutes).
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
// Opens an incident once this many outages happen back to back on one endpoint.
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

const ALERT_CHANNEL_TYPES = ['slack', 'pagerduty', 'email'];

const alertChannelSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('slack'),
        config: z.object({
            webhook_url: z.string().url().refine((u) => u.startsWith('https://hooks.slack.com/'), 'webhook_url must be a Slack Incoming Webhook URL'),
        }),
    }),
    z.object({
        type: z.literal('pagerduty'),
        config: z.object({
            routing_key: z.string().min(16, 'routing_key must be a PagerDuty Events API v2 integration key'),
        }),
    }),
    z.object({
        type: z.literal('email'),
        config: z.object({
            email: z.string().email('email must be a valid address'),
        }),
    }),
]);

// An outage is a connection failure or any 5xx response. A 2xx is a success and
// is the only signal that resolves an incident. Other 4xx responses are neutral:
// they don't open incidents and don't reset the consecutive-failure counter.
const classifyStatus = (responseStatus) => {
    if (responseStatus === 0 || responseStatus >= 500) return 'outage';
    if (responseStatus >= 200 && responseStatus < 300) return 'success';
    return 'neutral';
};

/**
 * In-memory failure telemetry per merchant endpoint. The rolling failure rate is
 * computed over a 15-minute window. An incident opens after `threshold`
 * consecutive outages and resolves on the next 2xx response.
 *
 * State lives in this process, so each API instance tracks its own deliveries.
 */
const createIncidentTracker = ({
    windowMs = FAILURE_WINDOW_MS,
    threshold = CONSECUTIVE_FAILURE_THRESHOLD,
} = {}) => {
    const endpoints = new Map();

    const stateFor = (endpointId) => {
        if (!endpoints.has(endpointId)) {
            endpoints.set(endpointId, { attempts: [], consecutiveFailures: 0, incident: null });
        }
        return endpoints.get(endpointId);
    };

    const failureRateFor = (state, now) => {
        const recent = state.attempts.filter((a) => now - a.at <= windowMs);
        state.attempts = recent;
        if (recent.length === 0) return 0;
        const failures = recent.filter((a) => a.outcome === 'outage').length;
        return failures / recent.length;
    };

    /**
     * Records one delivery attempt. Returns the incident transition it caused,
     * `{ type: 'incident_opened' | 'incident_resolved', incident }`, or null.
     */
    const record = (endpointId, {
        url,
        eventType,
        responseStatus,
        deliveryId = null,
        now = Date.now(),
    }) => {
        const state = stateFor(endpointId);
        const outcome = classifyStatus(responseStatus);
        state.attempts.push({ at: now, outcome });

        if (outcome === 'outage') {
            state.consecutiveFailures += 1;
            if (state.consecutiveFailures >= threshold && !state.incident) {
                state.incident = {
                    id: crypto.randomUUID(),
                    endpointId,
                    url,
                    eventType,
                    errorCode: responseStatus,
                    deliveryId,
                    openedAt: new Date(now).toISOString(),
                    consecutiveFailures: state.consecutiveFailures,
                };
                return { type: 'incident_opened', incident: { ...state.incident, failureRate: failureRateFor(state, now) } };
            }
            return null;
        }

        if (outcome === 'success') {
            state.consecutiveFailures = 0;
            if (state.incident) {
                const resolved = { ...state.incident, resolvedAt: new Date(now).toISOString(), resolvedBy: { eventType, responseStatus } };
                state.incident = null;
                return { type: 'incident_resolved', incident: resolved };
            }
        }
        return null;
    };

    const snapshot = (endpointId, now = Date.now()) => {
        const state = endpoints.get(endpointId);
        if (!state) return { failureRate: 0, consecutiveFailures: 0, activeIncident: null };
        return {
            failureRate: failureRateFor(state, now),
            consecutiveFailures: state.consecutiveFailures,
            activeIncident: state.incident,
        };
    };

    return { record, snapshot };
};

const dlqInspectorUrl = (deliveryId, baseUrl = process.env.FRONTEND_URL || 'https://useorbit.xyz') => {
    const base = `${baseUrl.replace(/\/$/, '')}/dashboard?view=developers`;
    return deliveryId ? `${base}&delivery=${encodeURIComponent(deliveryId)}` : base;
};

/**
 * Builds the channel-agnostic incident payload used by every dispatcher.
 */
const buildIncidentAlert = (transition, { frontendUrl } = {}) => {
    const { incident } = transition;
    const resolved = transition.type === 'incident_resolved';
    return {
        action: resolved ? 'resolved' : 'triggered',
        incident_id: incident.id,
        title: resolved
            ? `Webhook Delivery Restored: ${incident.url}`
            : `Webhook endpoint failing: ${incident.url}`,
        endpoint_url: incident.url,
        failed_event_type: incident.eventType,
        error_code: incident.errorCode,
        consecutive_failures: incident.consecutiveFailures ?? null,
        failure_rate: incident.failureRate ?? null,
        opened_at: incident.openedAt,
        resolved_at: incident.resolvedAt ?? null,
        dlq_url: dlqInspectorUrl(incident.deliveryId, frontendUrl),
    };
};

const postJson = async (fetchImpl, url, body, headers = {}) => {
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} from alert destination`);
    return res;
};

const formatSlack = (alert) => {
    const headline = alert.action === 'resolved'
        ? ':white_check_mark: *Webhook Delivery Restored*'
        : ':rotating_light: *Webhook endpoint failing*';
    return {
        text: `${alert.title}`,
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `${headline}\n*Endpoint:* ${alert.endpoint_url}\n*Failed event:* ${alert.failed_event_type}\n*Error code:* ${alert.error_code}` } },
            { type: 'section', text: { type: 'mrkdwn', text: `<${alert.dlq_url}|Inspect in the dead-letter queue>` } },
        ],
    };
};

const dispatchers = {
    slack: async (channel, alert, { fetchImpl }) => {
        await postJson(fetchImpl, channel.config.webhook_url, formatSlack(alert));
    },
    pagerduty: async (channel, alert, { fetchImpl }) => {
        const resolved = alert.action === 'resolved';
        await postJson(fetchImpl, PAGERDUTY_EVENTS_URL, {
            routing_key: channel.config.routing_key,
            event_action: resolved ? 'resolve' : 'trigger',
            // The incident id is stable across trigger and resolve, so PagerDuty
            // closes the same alert instead of opening a new one.
            dedup_key: alert.incident_id,
            payload: resolved ? undefined : {
                summary: alert.title,
                source: alert.endpoint_url,
                severity: 'error',
                component: 'webhooks',
                class: alert.failed_event_type,
                custom_details: {
                    endpoint_url: alert.endpoint_url,
                    failed_event_type: alert.failed_event_type,
                    error_code: alert.error_code,
                    dlq_url: alert.dlq_url,
                },
            },
        });
    },
    email: async (channel, alert, { fetchImpl, emailRelayUrl }) => {
        if (!emailRelayUrl) throw new Error('ALERT_EMAIL_RELAY_URL is not configured');
        await postJson(fetchImpl, emailRelayUrl, {
            to: channel.config.email,
            subject: alert.title,
            text: [
                `Endpoint: ${alert.endpoint_url}`,
                `Failed event: ${alert.failed_event_type}`,
                `Error code: ${alert.error_code}`,
                `Dead-letter queue: ${alert.dlq_url}`,
            ].join('\n'),
        });
    },
};

/**
 * Sends one incident alert to a single channel. Failures are reported in the
 * result, not thrown, so one broken channel doesn't block the others.
 */
const dispatchIncidentAlert = async (channel, alert, {
    fetchImpl = globalThis.fetch,
    emailRelayUrl = process.env.ALERT_EMAIL_RELAY_URL,
} = {}) => {
    const send = dispatchers[channel.type];
    if (!send) return { channel_id: channel.id, ok: false, error: `unsupported channel type ${channel.type}` };
    try {
        await send(channel, alert, { fetchImpl, emailRelayUrl });
        return { channel_id: channel.id, ok: true };
    } catch (err) {
        return { channel_id: channel.id, ok: false, error: err.message };
    }
};

/**
 * Creates the observer that `webhooks.js` calls after every delivery attempt.
 * It feeds the tracker and, on an incident transition, fans the alert out to the
 * merchant's configured channels.
 */
const createDeliveryAlertObserver = (getSupabase, {
    tracker = createIncidentTracker(),
    fetchImpl = globalThis.fetch,
    emailRelayUrl,
    frontendUrl,
    now = () => Date.now(),
} = {}) => async ({ merchantId, webhook, eventType, responseStatus, deliveryId }) => {
    const transition = tracker.record(webhook.id, {
        url: webhook.url,
        eventType,
        responseStatus,
        deliveryId,
        now: now(),
    });
    if (!transition) return [];

    const supabase = getSupabase();
    if (!supabase || !merchantId) return [];

    const { data: channels, error } = await supabase
        .from('webhook_alert_channels')
        .select('*')
        .eq('merchant_id', merchantId)
        .eq('active', true);
    if (error || !channels) return [];

    const alert = buildIncidentAlert(transition, { frontendUrl });
    return Promise.all(channels.map((channel) => dispatchIncidentAlert(channel, alert, { fetchImpl, emailRelayUrl })));
};

const registerWebhookAlertRoutes = (app, getSupabase, authenticateMerchant) => {
    app.get('/webhook-alert-channels', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { data, error } = await supabase
            .from('webhook_alert_channels')
            .select('id, type, config, active, created_at')
            .eq('merchant_id', req.merchant.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ channels: data || [] });
    });

    app.post('/webhook-alert-channels', authenticateMerchant, async (req, res) => {
        const parsed = alertChannelSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { data, error } = await supabase
            .from('webhook_alert_channels')
            .insert([{ merchant_id: req.merchant.id, type: parsed.data.type, config: parsed.data.config, active: true }])
            .select('id, type, config, active, created_at')
            .single();
        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ channel: data });
    });

    app.delete('/webhook-alert-channels/:id', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { error } = await supabase
            .from('webhook_alert_channels')
            .delete()
            .eq('id', req.params.id)
            .eq('merchant_id', req.merchant.id);
        if (error) return res.status(500).json({ error: error.message });
        res.status(204).end();
    });
};

module.exports = {
    FAILURE_WINDOW_MS,
    CONSECUTIVE_FAILURE_THRESHOLD,
    ALERT_CHANNEL_TYPES,
    alertChannelSchema,
    classifyStatus,
    createIncidentTracker,
    dlqInspectorUrl,
    buildIncidentAlert,
    dispatchIncidentAlert,
    createDeliveryAlertObserver,
    registerWebhookAlertRoutes,
};
