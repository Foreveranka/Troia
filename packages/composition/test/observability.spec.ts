// D-17: the observability layer. The registry must render exact Prometheus text (stroop bigints as exact
// decimals — never a float detour), and the notifier must be impossible to weaponize against the process:
// per-key cooldown, failures swallowed, nothing ever thrown into a tick loop.

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALERT_COOLDOWN_MS,
  MetricsRegistry,
  metricsExposition,
  NULL_ALERT_SINK,
  WebhookAlertNotifier,
} from '../src/observability.js';

describe('MetricsRegistry', () => {
  it('renders gauges and counters in the Prometheus text format, insertion-ordered', () => {
    const m = new MetricsRegistry();
    m.setGauge('troia_pool_available_stroops', 999_990_000_000n, 'pool minus holds');
    m.addCounter('troia_poll_polled_total', 3, 'orders examined');
    m.addCounter('troia_poll_polled_total', 2, 'orders examined');
    expect(m.render()).toBe(
      '# HELP troia_pool_available_stroops pool minus holds\n' +
        '# TYPE troia_pool_available_stroops gauge\n' +
        'troia_pool_available_stroops 999990000000\n' +
        '# HELP troia_poll_polled_total orders examined\n' +
        '# TYPE troia_poll_polled_total counter\n' +
        'troia_poll_polled_total 5\n',
    );
  });

  it('keeps bigint exactness past 2^53 — a stroop count never becomes a float', () => {
    const m = new MetricsRegistry();
    const big = 2n ** 60n + 1n; // would silently round as a JS number
    m.setGauge('troia_big', big, 'x');
    expect(m.render()).toContain(`troia_big ${big.toString()}\n`);
  });

  it('a gauge overwrites; a negative counter delta throws; a bad name throws', () => {
    const m = new MetricsRegistry();
    m.setGauge('g', 1, 'x');
    m.setGauge('g', 2, 'x');
    expect(m.render()).toContain('g 2');
    expect(() => m.addCounter('c', -1, 'x')).toThrow(/negative/);
    expect(() => m.setGauge('bad name', 1, 'x')).toThrow(/invalid metric name/);
  });

  it('metricsExposition carries the v0.0.4 content type', () => {
    const e = metricsExposition(new MetricsRegistry());
    expect(e.contentType).toContain('version=0.0.4');
    expect(e.body).toBe('\n');
  });
});

describe('WebhookAlertNotifier', () => {
  function fetchSpy(status = 200): { calls: { url: string; body: string }[]; impl: typeof fetch } {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return { ok: status < 300, status } as Response;
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it('POSTs {text} as JSON to the webhook', async () => {
    const spy = fetchSpy();
    const n = new WebhookAlertNotifier('https://hooks.example/x', {
      fetchImpl: spy.impl,
      nowMs: () => 0,
    });
    n.alert('drift', 'SOLVENCY ALARM: ...');
    await Promise.resolve();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toBe('https://hooks.example/x');
    expect(JSON.parse(spy.calls[0]?.body ?? '')).toEqual({ text: 'SOLVENCY ALARM: ...' });
  });

  it('cools down per KEY: the same condition cannot storm the channel, a different one still passes', async () => {
    const spy = fetchSpy();
    let now = 0;
    const n = new WebhookAlertNotifier('https://hooks.example/x', {
      fetchImpl: spy.impl,
      nowMs: () => now,
    });
    n.alert('drift', 'a');
    n.alert('drift', 'a again'); // same key, inside the cooldown -> dropped
    n.alert('rogue:tx1', 'b'); // different key -> delivered
    await Promise.resolve();
    expect(spy.calls).toHaveLength(2);

    now = DEFAULT_ALERT_COOLDOWN_MS; // the cooldown elapses
    n.alert('drift', 'a later');
    await Promise.resolve();
    expect(spy.calls).toHaveLength(3);
  });

  it('a dead webhook is swallowed and logged once — the tick loop never sees it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const n = new WebhookAlertNotifier('https://hooks.example/x', {
      fetchImpl: throwing,
      nowMs: () => 0,
    });
    expect(() => {
      n.alert('a', 'x');
      n.alert('b', 'y');
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(err.mock.calls.length).toBe(1); // one failure-streak log, not one per alert
    err.mockRestore();
  });

  it('NULL_ALERT_SINK is a total no-op', () => {
    expect(() => NULL_ALERT_SINK.alert('k', 't')).not.toThrow();
  });
});
