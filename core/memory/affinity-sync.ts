import { existsSync, readFileSync, statSync } from 'node:fs';
import type { HindsightMemory } from './hindsight.ts';

export interface AffinitySyncOptions {
  file: string;
  memory: HindsightMemory;
  log?: { warn(message: string, data?: unknown): void };
}

export class AffinitySync {
  private file = '';
  private memory: HindsightMemory | null = null;
  private log: AffinitySyncOptions['log'];
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  configure(opts: AffinitySyncOptions): void {
    this.file = opts.file;
    this.memory = opts.memory;
    this.log = opts.log;
    this.offset = 0;
  }

  start(): void {
    if (!this.file || !this.memory?.enabled() || this.timer) return;
    this.read();
    this.timer = setInterval(() => this.read(), 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private read(): void {
    if (!this.memory?.enabled() || !existsSync(this.file)) return;
    try {
      const size = statSync(this.file).size;
      if (size < this.offset) this.offset = 0;
      if (size === this.offset) return;
      const bytes = readFileSync(this.file).subarray(this.offset);
      const text = bytes.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return;
      const complete = text.slice(0, end + 1);
      this.offset += Buffer.byteLength(complete, 'utf8');
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this.memory.retainAffinityChange(event);
        } catch (err) {
          this.log?.warn('[affinity] could not read an event line', { message: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      this.log?.warn('[affinity] could not read affinity-events.jsonl', { message: err instanceof Error ? err.message : String(err) });
    }
  }
}
