import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AffectionKind =
  | 'pet' | 'poke' | 'throw' | 'crash' | 'drop' | 'grab'
  | 'comfort' | 'promise' | 'conflict' | 'apology' | 'gift';

export interface AffectionEvent {
  id: string;
  ts: string;
  kind: AffectionKind;
  delta: number;
  source: string;
  reason?: string;
  memoryId?: string;
}

export interface AffectionState {
  bond: number;
  mood: number;
  level: number;
  levelName: string;
  events: number;
  recent: AffectionEvent[];
}

export interface AffectionOptions {
  dailyPositive?: number;
  dailyNegative?: number;
  now?: () => Date;
  timezone?: string;
  log?: { warn(message: string, data?: unknown): void };
}

const DELTAS: Record<AffectionKind, number> = {
  pet: 1,
  poke: 0,
  throw: -2,
  crash: -2,
  drop: 0,
  grab: 0,
  comfort: 2,
  promise: 3,
  conflict: -3,
  apology: 2,
  gift: 3,
};

const LEVELS = [0, 40, 120, 280, 520, 820];
const LEVEL_NAMES = ['stranger', 'acquaintance', 'friend', 'close', 'bonded', 'family'];
const DAY_MS = 86_400_000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));


export class AffectionLedger {
  private file: string | null = null;
  private events: AffectionEvent[] = [];
  private ids = new Set<string>();
  private dailyPositive = 10;
  private dailyNegative = 5;
  private now: () => Date = () => new Date();
  private timezone = 'UTC';
  private log: AffectionOptions['log'];

  configure(file: string | null, opts: AffectionOptions = {}): void {
    this.file = file;
    this.dailyPositive = opts.dailyPositive ?? 10;
    this.dailyNegative = opts.dailyNegative ?? 5;
    this.now = opts.now ?? (() => new Date());
    this.timezone = opts.timezone ?? 'UTC';
    this.log = opts.log;
    this.events = [];
    this.ids.clear();
    if (!file || !existsSync(file)) return;
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as Partial<AffectionEvent>;
        if (typeof parsed.id !== 'string' || typeof parsed.ts !== 'string' || typeof parsed.kind !== 'string' || typeof parsed.delta !== 'number') continue;
        if (!(parsed.kind in DELTAS)) continue;
        if (this.ids.has(parsed.id)) continue;
        const event: AffectionEvent = {
          id: parsed.id,
          ts: parsed.ts,
          kind: parsed.kind as AffectionKind,
          delta: parsed.delta,
          source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
          ...(typeof parsed.memoryId === 'string' ? { memoryId: parsed.memoryId } : {}),
        };
        this.events.push(event);
        this.ids.add(event.id);
      }
    } catch (err) {
      this.log?.warn('[affection] could not read the ledger', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  enabled(): boolean {
    return this.file !== null;
  }

  private append(event: AffectionEvent): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      this.log?.warn('[affection] could not write the ledger', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private dayOf(ts: string): string {
    const date = new Date(ts);
    if (Number.isNaN(date.valueOf())) return 'unknown';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  eventsOn(day: string): AffectionEvent[] {
    return this.events.filter((event) => this.dayOf(event.ts) === day);
  }

  summary(day: string): string {
    const events = this.eventsOn(day);
    if (events.length === 0) return '';
    const counts = new Map<string, { count: number; delta: number }>();
    for (const event of events) {
      const row = counts.get(event.kind) ?? { count: 0, delta: 0 };
      row.count += 1;
      row.delta += event.delta;
      counts.set(event.kind, row);
    }
    const parts = [...counts.entries()].map(([kind, row]) => `${kind}×${row.count} (${row.delta > 0 ? '+' : ''}${row.delta})`);
    const state = this.state();
    return `bond ${state.bond}/1000, mood ${state.mood > 0 ? '+' : ''}${state.mood}; ${parts.join(', ')}`;
  }

  private spentOn(day: string): { positive: number; negative: number } {
    let positive = 0;
    let negative = 0;
    for (const event of this.events) {
      if (this.dayOf(event.ts) !== day) continue;
      if (event.delta > 0) positive += event.delta;
      else negative += -event.delta;
    }
    return { positive, negative };
  }

  record(kind: AffectionKind, meta: { id?: string; reason?: string; source?: string; memoryId?: string; ts?: string } = {}): AffectionEvent | null {
    const base = DELTAS[kind];
    if (base === 0) return null;
    const ts = meta.ts ?? this.now().toISOString();
    const id = meta.id ?? `${kind}:${ts}:${Math.random().toString(36).slice(2, 10)}`;
    if (this.ids.has(id)) return null;
    const spent = this.spentOn(this.dayOf(ts));
    let delta = base;
    if (delta > 0) {
      const room = this.dailyPositive - spent.positive;
      if (room <= 0) return null;
      delta = Math.min(delta, room);
    } else {
      const room = this.dailyNegative - spent.negative;
      if (room <= 0) return null;
      delta = -Math.min(-delta, room);
    }
    const event: AffectionEvent = {
      id,
      ts,
      kind,
      delta,
      source: meta.source ?? 'app',
      ...(meta.reason ? { reason: meta.reason.slice(0, 280) } : {}),
      ...(meta.memoryId ? { memoryId: meta.memoryId } : {}),
    };
    this.events.push(event);
    this.ids.add(id);
    this.append(event);
    return event;
  }

  recordTouch(touch: { kind?: unknown; count?: unknown; crashed?: unknown }, meta: { session?: string; cursor?: number; ts?: string } = {}): AffectionEvent | null {
    const kind = String(touch.kind ?? '');
    if (kind === 'crash' || (kind === 'throw' && touch.crashed === true)) {
      return this.record('crash', { id: `touch:${meta.session ?? 'main'}:${meta.cursor ?? meta.ts ?? ''}:crash`, source: 'touch', reason: 'thrown or dropped hard', ts: meta.ts });
    }
    if (kind !== 'pet') return null;
    const count = typeof touch.count === 'number' && Number.isFinite(touch.count) ? clamp(Math.trunc(touch.count), 1, 3) : 1;
    return this.record('pet', {
      id: `touch:${meta.session ?? 'main'}:${meta.cursor ?? meta.ts ?? ''}:pet`,
      source: 'touch',
      reason: count > 1 ? `patted ${count} times` : 'patted',
      ts: meta.ts,
    });
  }

  state(): AffectionState {
    const now = this.now().valueOf();
    let bond = 0;
    let mood = 0;
    for (const event of this.events) {
      bond += event.delta;
      const age = now - new Date(event.ts).valueOf();
      if (Number.isFinite(age) && age >= 0 && age <= DAY_MS) {
        mood += event.delta * Math.exp(-age / (12 * 3_600_000));
      }
    }
    bond = clamp(Math.round(bond * 10) / 10, 0, 1000);
    const level = LEVELS.reduce((index, threshold, i) => (bond >= threshold ? i : index), 0);
    return {
      bond,
      mood: clamp(Math.round(mood * 10) / 10, -100, 100),
      level: level + 1,
      levelName: LEVEL_NAMES[level] ?? 'stranger',
      events: this.events.length,
      recent: this.events.slice(-5).reverse(),
    };
  }

  snapshot(): string {
    if (this.events.length === 0) return '';
    const state = this.state();
    const recent = state.recent
      .filter((event) => event.delta !== 0)
      .map((event) => `${event.reason ?? event.kind} (${event.delta > 0 ? '+' : ''}${event.delta})`)
      .join('; ');
    return `[affection] Bond Lv.${state.level} (${state.levelName}), bond ${state.bond}/1000, mood ${state.mood > 0 ? '+' : ''}${state.mood}.`
      + (recent ? ` Recent: ${recent}.` : '');
  }

  clear(): string {
    this.events = [];
    this.ids.clear();
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, '', 'utf8');
      } catch (err) {
        this.log?.warn('[affection] could not clear the ledger', { message: err instanceof Error ? err.message : String(err) });
      }
    }
    return 'affection ledger cleared';
  }
}
