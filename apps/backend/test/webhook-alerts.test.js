import { describe, it, expect, vi } from 'vitest';
import {
  createIncidentTracker,
  classifyStatus,
  buildIncidentAlert,
  dispatchIncidentAlert,
  createDeliveryAlertObserver,
  alertChannelSchema,
  dlqInspectorUrl,
  FAILURE_WINDOW_MS,
  CONSECUTIVE_FAILURE_THRESHOLD,
} from '../webhook-alerts.js';
import { setDeliveryObserver, dispatchWebhookEvent } from '../webhooks.js';

const MERCHANT_ID = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const ENDPOINT = { id: 'wh-1', url: 'https://merchant.example.com/hooks' };

const okResponse = (status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => '' });

describe('incident tracker', () => {
  it('uses the documented window and threshold', () => {
    expect(FAILURE_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(CONSECUTIVE_FAILURE_THRESHOLD).toBe(5);
  });

  it('classifies 5xx and connection errors as outages, 2xx as success, other 4xx as neutral', () => {
    expect(classifyStatus(500)).toBe('outage');
    expect(classifyStatus(503)).toBe('outage');
    expect(classifyStatus(0)).toBe('outage');
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(204)).toBe('success');
    expect(classifyStatus(404)).toBe('neutral');
  });

  it('opens exactly one incident after the consecutive failure threshold', () => {
    const tracker = createIncidentTracker();
    const transitions = [];
    for (let i = 0; i < 7; i += 1) {
      transitions.push(tracker.record(ENDPOINT.id, {
        url: ENDPOINT.url, eventType: 'payment.settled', responseStatus: 503, deliveryId: `d${i}`, now: 1_000 + i,
      }));
    }
    const opened = transitions.filter((t) => t?.type === 'incident_opened');
    expect(opened).toHaveLength(1);
    expect(transitions.slice(0, 4).every((t) => t === null)).toBe(true);
    expect(opened[0].incident.errorCode).toBe(503);
    expect(opened[0].incident.failureRate).toBe(1);
    expect(tracker.snapshot(ENDPOINT.id, 1_010).activeIncident).not.toBeNull();
  });

  it('resolves the incident on the next 2xx and resets the counter', () => {
    const tracker = createIncidentTracker({ threshold: 2 });
    tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 500, now: 1 });
    const opened = tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 500, now: 2 });
    expect(opened.type).toBe('incident_opened');

    const resolved = tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 200, now: 3 });
    expect(resolved.type).toBe('incident_resolved');
    expect(resolved.incident.id).toBe(opened.incident.id);
    expect(tracker.snapshot(ENDPOINT.id, 3).consecutiveFailures).toBe(0);
    expect(tracker.snapshot(ENDPOINT.id, 3).activeIncident).toBeNull();
  });

  it('does not reset the consecutive count on neutral 4xx responses', () => {
    const tracker = createIncidentTracker({ threshold: 3 });
    tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 500, now: 1 });
    tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 404, now: 2 });
    tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 500, now: 3 });
    const third = tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 500, now: 4 });
    expect(third.type).toBe('incident_opened');
  });

  it('computes the failure rate over the 15-minute sliding window only', () => {
    const tracker = createIncidentTracker({ threshold: 100 });
    tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 500, now: 0 });
    tracker.record(ENDPOINT.id, { url: ENDPOINT.url, eventType: 'a', responseStatus: 200, now: 1 });
    expect(tracker.snapshot(ENDPOINT.id, 2).failureRate).toBe(0.5);
    // The failure falls out of the window, leaving only the success.
    expect(tracker.snapshot(ENDPOINT.id, FAILURE_WINDOW_MS + 10).failureRate).toBe(0);
  });
});

describe('alert payload and destinations', () => {
  it('builds a DLQ inspector link for the failed delivery', () => {
    expect(dlqInspectorUrl('abc 1', 'https://app.example.com/')).toBe(
      'https://app.example.com/dashboard?view=developers&delivery=abc%201',
    );
  });

  it('carries endpoint URL, failed event type, error code and DLQ link', () => {
    const transition = {
      type: 'incident_opened',
      incident: { id: 'inc-1', url: ENDPOINT.url, eventType: 'payment.settled', errorCode: 502, deliveryId: 'del-9', openedAt: 'now', consecutiveFailures: 5 },
    };
    const alert = buildIncidentAlert(transition, { frontendUrl: 'https://app.example.com' });
    expect(alert.action).toBe('triggered');
    expect(alert.endpoint_url).toBe(ENDPOINT.url);
    expect(alert.failed_event_type).toBe('payment.settled');
    expect(alert.error_code).toBe(502);
    expect(alert.dlq_url).toContain('delivery=del-9');
  });

  it('posts to Slack, PagerDuty (trigger and resolve) and the email relay', async () => {
    const fetchImpl = vi.fn(async () => okResponse(200));
    const alert = { action: 'triggered', incident_id: 'inc-1', title: 't', endpoint_url: ENDPOINT.url, failed_event_type: 'x', error_code: 500, dlq_url: 'u' };

    await dispatchIncidentAlert({ id: 's', type: 'slack', config: { webhook_url: 'https://hooks.slack.com/services/T/B/X' } }, alert, { fetchImpl });
    await dispatchIncidentAlert({ id: 'p', type: 'pagerduty', config: { routing_key: 'R'.repeat(32) } }, alert, { fetchImpl });
    await dispatchIncidentAlert({ id: 'p2', type: 'pagerduty', config: { routing_key: 'R'.repeat(32) } }, { ...alert, action: 'resolved' }, { fetchImpl });
    const emailResult = await dispatchIncidentAlert({ id: 'e', type: 'email', config: { email: 'ops@merchant.example' } }, alert, { fetchImpl, emailRelayUrl: 'https://relay.example/send' });

    expect(emailResult.ok).toBe(true);
    const bodies = fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);
    expect(bodies[0][0]).toBe('https://hooks.slack.com/services/T/B/X');
    expect(bodies[1][1].event_action).toBe('trigger');
    expect(bodies[1][1].dedup_key).toBe('inc-1');
    expect(bodies[2][1].event_action).toBe('resolve');
    expect(bodies[2][1].payload).toBeUndefined();
    expect(bodies[3][0]).toBe('https://relay.example/send');
  });

  it('reports a failing destination without throwing', async () => {
    const fetchImpl = vi.fn(async () => okResponse(500));
    const result = await dispatchIncidentAlert({ id: 's', type: 'slack', config: { webhook_url: 'https://hooks.slack.com/x' } }, { title: 't' }, { fetchImpl });
    expect(result).toMatchObject({ ok: false });
  });

  it('validates channel configuration', () => {
    expect(alertChannelSchema.safeParse({ type: 'slack', config: { webhook_url: 'https://example.com/x' } }).success).toBe(false);
    expect(alertChannelSchema.safeParse({ type: 'pagerduty', config: { routing_key: 'short' } }).success).toBe(false);
    expect(alertChannelSchema.safeParse({ type: 'email', config: { email: 'ops@merchant.example' } }).success).toBe(true);
  });
});

describe('delivery observer', () => {
  it('sends the opened and restored notices to every active channel of the merchant', async () => {
    const channels = [{ id: 'c1', type: 'email', config: { email: 'ops@merchant.example' }, active: true }];
    // Chainable, awaitable query builder: `.eq()` returns the builder and awaiting it resolves the rows.
    const supabase = {
      from: vi.fn(() => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          then: (resolve, reject) => Promise.resolve({ data: channels, error: null }).then(resolve, reject),
        };
        return builder;
      }),
    };
    const fetchImpl = vi.fn(async () => okResponse(200));
    const observer = createDeliveryAlertObserver(() => supabase, {
      tracker: createIncidentTracker({ threshold: 2 }),
      fetchImpl,
      emailRelayUrl: 'https://relay.example/send',
      now: (() => { let t = 0; return () => (t += 1); })(),
    });

    const failing = { merchantId: MERCHANT_ID, webhook: ENDPOINT, eventType: 'payment.settled', responseStatus: 500, deliveryId: 'd1' };
    expect(await observer(failing)).toEqual([]);
    const openedResults = await observer({ ...failing, deliveryId: 'd2' });
    expect(openedResults).toHaveLength(1);
    expect(openedResults[0].ok).toBe(true);

    const restored = await observer({ ...failing, responseStatus: 200, deliveryId: 'd3' });
    expect(restored).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const relayBodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(relayBodies[0].subject).toMatch(/endpoint failing/);
    expect(relayBodies[1].subject).toMatch(/Webhook Delivery Restored/);
  });

  it('is invoked for every dispatched delivery without changing the delivery result', async () => {
    const observed = [];
    setDeliveryObserver((event) => observed.push(event));
    const webhook = { id: 'wh-2', merchant_id: MERCHANT_ID, url: ENDPOINT.url, signing_secret: 'whsec_secret_1234567890', events: ['*'], active: true };
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'webhooks') {
          return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [webhook], error: null }) }) }) };
        }
        return { insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'row' }, error: null }) }) }) };
      }),
    };
    const deliveries = await dispatchWebhookEvent(supabase, {
      merchantId: MERCHANT_ID,
      eventType: 'payment.settled',
      payload: { ok: true },
      fetchImpl: vi.fn(async () => okResponse(503)),
    });
    await new Promise((resolve) => setImmediate(resolve));
    setDeliveryObserver(null);

    expect(deliveries).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ merchantId: MERCHANT_ID, responseStatus: 503, eventType: 'payment.settled' });
  });
});
