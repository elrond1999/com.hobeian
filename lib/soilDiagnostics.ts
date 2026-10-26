'use strict';

const MAX_CHANNELS = 64;
const MAX_EVENTS = 32;
const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 80;

type Sample = {
  count: number;
  changes: number;
  firstAt: number;
  lastAt: number;
  lastChangedAt: number;
  value: number | boolean | string;
  totalIntervalMs: number;
  maxIntervalMs: number;
};
type SettingEvent = {
  at: number;
  kind: 'requested' | 'attempt' | 'sent' | 'failed' | 'reported';
  key: string;
  dp: number;
  value: number | boolean;
  requested?: number | boolean;
  error?: string;
};
type DiagnosticState = {
  schema: 1;
  since: number;
  channels: Record<string, Sample>;
  events: SettingEvent[];
  settings: Record<string, {
    requested?: number | boolean;
    requestedAt?: number;
    attempts: number;
    failures: number;
    lastAttemptAt?: number;
    lastSentAt?: number;
    lastError?: string;
    reported?: number | boolean;
    reportedAt?: number;
  }>;
  frames: { at: number; cluster: number; hex: string; truncated: boolean }[];
  errors: { at: number; context: string; message: string }[];
  starts: number;
  lastStartedAt?: number;
  frameCount: number;
  lastFrameAt?: number;
  maxFrameGapMs: number;
  batteryReads: number;
  batteryReadErrors: number;
  identity: Record<string, string | number | boolean | null>;
};

// Observations only: these records never decide conversions or send Zigbee commands.
export default class SoilDiagnostics {

  private state: DiagnosticState;

  constructor(saved?: DiagnosticState) {
    this.state = saved?.schema === 1 ? JSON.parse(JSON.stringify(saved)) : {
      schema: 1,
      since: Date.now(),
      channels: {},
      events: [],
      settings: {},
      frames: [],
      errors: [],
      starts: 0,
      frameCount: 0,
      maxFrameGapMs: 0,
      batteryReads: 0,
      batteryReadErrors: 0,
      identity: {},
    };
  }

  start(identity: DiagnosticState['identity']) {
    this.state.starts += 1;
    this.state.lastStartedAt = Date.now();
    this.state.identity = { ...this.state.identity, ...identity };
  }

  identify(key: string, value: string | number | boolean) {
    this.state.identity[key] = value;
  }

  sample(channel: string, value: Sample['value']) {
    const now = Date.now();
    const previous = this.state.channels[channel];
    if (!previous) {
      if (Object.keys(this.state.channels).length >= MAX_CHANNELS) return;
      this.state.channels[channel] = {
        count: 1,
        changes: 0,
        firstAt: now,
        lastAt: now,
        lastChangedAt: now,
        value,
        totalIntervalMs: 0,
        maxIntervalMs: 0,
      };
      return;
    }
    const interval = Math.max(0, now - previous.lastAt);
    previous.totalIntervalMs += interval;
    previous.maxIntervalMs = Math.max(previous.maxIntervalMs, interval);
    previous.lastAt = now;
    previous.count += 1;
    if (previous.value !== value) {
      previous.changes += 1;
      previous.lastChangedAt = now;
    }
    previous.value = value;
  }

  frame(cluster: number, data: Buffer) {
    const now = Date.now();
    if (this.state.lastFrameAt !== undefined) {
      this.state.maxFrameGapMs = Math.max(this.state.maxFrameGapMs, Math.max(0, now - this.state.lastFrameAt));
    }
    this.state.lastFrameAt = now;
    this.state.frameCount += 1;
    this.state.frames.push({
      at: now, cluster, hex: data.subarray(0, MAX_FRAME_BYTES).toString('hex'), truncated: data.length > MAX_FRAME_BYTES,
    });
    this.state.frames = this.state.frames.slice(-MAX_FRAMES);
  }

  setting(event: Omit<SettingEvent, 'at'>) {
    const at = Date.now();
    const status = this.state.settings[event.key] ?? { attempts: 0, failures: 0 };
    const retainEvent = event.kind !== 'reported' || status.reported !== event.value
      || status.reportedAt === undefined || (status.requestedAt ?? 0) > status.reportedAt;
    if (event.kind === 'requested') {
      status.requested = event.value;
      status.requestedAt = at;
    } else if (event.kind === 'attempt') {
      status.attempts += 1;
      status.lastAttemptAt = at;
    } else if (event.kind === 'sent') {
      status.lastSentAt = at;
      status.lastError = undefined;
    } else if (event.kind === 'failed') {
      status.failures += 1;
      status.lastError = event.error;
    } else if (event.kind === 'reported') {
      status.reported = event.value;
      status.reportedAt = at;
    }
    this.state.settings[event.key] = status;
    if (retainEvent) {
      this.state.events.push({ at, ...event });
      this.state.events = this.state.events.slice(-MAX_EVENTS);
    }
    return retainEvent;
  }

  requested(key: string) {
    return this.state.settings[key]?.requested;
  }

  error(context: string, error: unknown) {
    this.state.errors.push({ at: Date.now(), context, message: String(error).slice(0, 240) });
    this.state.errors = this.state.errors.slice(-MAX_FRAMES);
  }

  batteryRead(failed = false) {
    if (failed) this.state.batteryReadErrors += 1;
    else this.state.batteryReads += 1;
  }

  snapshot() {
    const state: DiagnosticState = JSON.parse(JSON.stringify(this.state));
    return state;
  }

}
