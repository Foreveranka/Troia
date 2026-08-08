// D-17: the observability layer — a hand-rolled Prometheus registry and a webhook alert notifier, zero new
// dependencies. The philosophy matches the alarms it carries: critical signals must reach a human WITHOUT the
// human having to tail a console. `main.ts` updates the gauges/counters from every tick report and fires the
// notifier from exactly the same edge-triggered branches that already print the alarms — the webhook is a
// second delivery channel for the alarms that exist, never a new source of truth.
//
// The registry is deliberately tiny: gauges (set) and counters (add), rendered in the Prometheus text
// exposition format v0.0.4. bigint values (stroops!) render as exact decimal strings — a stroop count must
// never take a float detour on its way to a dashboard.

/** One metric's static description; registered lazily on first touch, stable thereafter. */
interface MetricRow {
  readonly help: string;
  readonly type: 'gauge' | 'counter';
  value: bigint | number;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class MetricsRegistry {
  private readonly rows = new Map<string, MetricRow>();

  /** Set a gauge to the current value (overwrites). */
  setGauge(name: string, value: bigint | number, help: string): void {
    this.touch(name, 'gauge', help).value = value;
  }

  /** Add to a counter (monotonic; negative deltas are a bug and throw). */
  addCounter(name: string, delta: bigint | number, help: string): void {
    if (typeof delta === 'number' ? delta < 0 : delta < 0n) {
      throw new RangeError(`counter ${name}: negative delta`);
    }
    const row = this.touch(name, 'counter', help);
    if (typeof row.value === 'bigint' || typeof delta === 'bigint') {
      row.value = BigInt(row.value) + BigInt(delta);
    } else {
      row.value += delta;
    }
  }

  private touch(name: string, type: 'gauge' | 'counter', help: string): MetricRow {
    if (!NAME_RE.test(name)) throw new RangeError(`invalid metric name: ${name}`);
    let row = this.rows.get(name);
    if (row === undefined) {
      row = { help, type, value: type === 'counter' ? 0 : Number.NaN };
      this.rows.set(name, row);
    }
    return row;
  }

  /** Prometheus text exposition (v0.0.4). Deterministic order (insertion), exact bigint decimals. */
  render(): string {
    const lines: string[] = [];
    for (const [name, row] of this.rows) {
      lines.push(`# HELP ${name} ${row.help}`);
      lines.push(`# TYPE ${name} ${row.type}`);
      lines.push(
        `${name} ${typeof row.value === 'bigint' ? row.value.toString() : String(row.value)}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}

/** What GET /metrics serves. A tiny value object so the route in main.ts stays two lines and THIS is the
 *  tested surface. */
export function metricsExposition(registry: MetricsRegistry): {
  contentType: string;
  body: string;
} {
  return { contentType: 'text/plain; version=0.0.4; charset=utf-8', body: registry.render() };
}

export interface AlertSink {
  /** Deliver one alarm. `key` identifies the CONDITION (not the occurrence): repeats within the cooldown are
   *  dropped, so a broken tick cannot storm the channel. Fire-and-forget — an alert path must never be able
   *  to take the money path down. */
  alert(key: string, text: string): void;
}

/** The no-op sink for deployments without a webhook: alarms still reach the console exactly as before. */
export const NULL_ALERT_SINK: AlertSink = { alert: () => {} };

/** Default per-key cooldown. The alarms this carries are edge-triggered upstream already; the cooldown is the
 *  second seatbelt for any future caller that fires per-tick. */
export const DEFAULT_ALERT_COOLDOWN_MS = 5 * 60_000;

/**
 * POSTs `{ text }` as JSON to a webhook URL — the shape Slack/Discord/Mattermost-style incoming webhooks and
 * any self-hosted receiver accept. Failures are logged once per failure streak and swallowed: observability
 * must degrade to "console only", never to "process down".
 */
export class WebhookAlertNotifier implements AlertSink {
  private readonly lastSentMs = new Map<string, number>();
  private failing = false;

  constructor(
    private readonly url: string,
    private readonly opts: {
      readonly fetchImpl?: typeof fetch;
      readonly cooldownMs?: number;
      readonly nowMs?: () => number;
    } = {},
  ) {}

  alert(key: string, text: string): void {
    const now = (this.opts.nowMs ?? Date.now)();
    const cooldown = this.opts.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    const last = this.lastSentMs.get(key);
    if (last !== undefined && now - last < cooldown) return;
    this.lastSentMs.set(key, now);

    const doFetch = this.opts.fetchImpl ?? fetch;
    void doFetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(
      (res) => {
        if (!res.ok && !this.failing) {
          this.failing = true;
          console.error(
            `[alerts] webhook answered ${res.status} — alarms are console-only until it recovers`,
          );
        }
        if (res.ok) this.failing = false;
      },
      (err: unknown) => {
        if (!this.failing) {
          this.failing = true;
          console.error(
            '[alerts] webhook unreachable — alarms are console-only until it recovers',
            err,
          );
        }
      },
    );
  }
}
