/**
 * The worker that turns outbox items into Hindsight retain requests and follows each async
 * operation to a terminal state. It never treats "accepted" as "stored".
 */
import type { MemoryOutbox, OutboxItem } from './outbox.ts';

export type OperationState = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'not_found';

export interface DeliveryOps {
  /** Submit one retain request to the item's own bank. `operationId` is fixed before the first attempt. */
  retain(item: OutboxItem): Promise<{ async: boolean; operationId: string | null }>;
  status(item: OutboxItem): Promise<OperationState>;
  /** Read the source document after remote completion. */
  verify(item: OutboxItem): Promise<boolean>;
  retry(item: OutboxItem): Promise<void>;
  /** Stop a queued or processing operation; a terminal operation may answer 409. */
  cancel(item: OutboxItem): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export interface DeliveryResult {
  submitted: number;
  /** Remote operation reached its terminal completed state. */
  completed: number;
  /** The source document was read back from the bank. */
  verified: number;
  failed: number;
}

export interface DeliveryOptions {
  /** Retain requests submitted in one drain. */
  batch?: number;
  /** Async operations polled in one drain. */
  poll?: number;
  now?: () => Date;
  /** The running target; items for another bank/endpoint are isolated before any call. */
  target?: () => { bankId: string; endpoint: string };
  /** A source the person has fenced; it must not be submitted or followed any further. */
  forgotten?: (item: OutboxItem) => boolean;
  log?: { warn(message: string, data?: unknown): void };
}

export class OutboxDelivery {
  private readonly now: () => Date;
  private readonly batch: number;
  private readonly poll: number;
  private readonly target?: DeliveryOptions['target'];
  private readonly forgotten?: DeliveryOptions['forgotten'];
  private readonly log?: DeliveryOptions['log'];
  private running = false;

  constructor(private readonly outbox: MemoryOutbox, private readonly ops: DeliveryOps, opts: DeliveryOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.batch = Math.max(1, opts.batch ?? 4);
    this.poll = Math.max(1, opts.poll ?? 8);
    this.target = opts.target;
    this.forgotten = opts.forgotten;
    this.log = opts.log;
  }

  async drain(): Promise<DeliveryResult> {
    if (this.running) return { submitted: 0, completed: 0, verified: 0, failed: 0 };
    this.running = true;
    try {
      return await this.drainOnce();
    } finally {
      this.running = false;
    }
  }

  private async drainOnce(): Promise<DeliveryResult> {
    const result: DeliveryResult = { submitted: 0, completed: 0, verified: 0, failed: 0 };
    for (const snapshot of this.outbox.due(this.now(), this.batch)) {
      // The batch is only a candidate list. Read the current item again immediately before
      // submitting so a cancellation or payload change between due() and this turn cannot send
      // a new request for an item the person just forgot.
      const item = this.outbox.get(snapshot.id);
      if (!item || (item.state !== 'pending' && item.state !== 'failed')) continue;
      if (!this.matchesTarget(item)) {
        this.outbox.quarantine(item.id, 'the memory bank or endpoint changed; this item was not sent');
        continue;
      }
      if (this.forgotten?.(item)) {
        this.outbox.markCancelled(item.id, 'the person asked to forget this before it was sent');
        continue;
      }
      if (!this.outbox.markSending(item.id)) continue;
      const sending = this.outbox.get(item.id);
      if (!sending || sending.state !== 'sending') continue;
      try {
        const accepted = await this.ops.retain(sending);
        // A forget that lands while the request is in flight wins: cancel what was accepted and
        // leave the source to the deletion queue.
        if (this.outbox.get(sending.id)?.state === 'cancelled' || this.forgotten?.(sending)) {
          if (accepted.async && accepted.operationId) await this.ops.cancel({ ...sending, operationId: accepted.operationId }).catch(() => {});
          this.outbox.markCancelled(item.id, 'the person asked to forget this while the retain was in flight');
          continue;
        }
        result.submitted += 1;
        if (!accepted.async) {
          if (this.outbox.markDone(item.id)) result.completed += 1;
          continue;
        }
        if (!accepted.operationId) {
          this.outbox.markFailed(item.id, 'the server accepted the retain without an operation id');
          result.failed += 1;
          continue;
        }
        this.outbox.markSent(sending.id, accepted.operationId);
      } catch (err) {
        result.failed += 1;
        const error = err instanceof Error ? err.message : String(err);
        this.outbox.markFailed(sending.id, error, { permanent: err instanceof DeliveryError && err.permanent });
      }
    }
    for (const item of this.outbox.sent(this.poll)) {
      if (!this.matchesTarget(item)) {
        this.outbox.quarantine(item.id, 'the memory bank or endpoint changed; this operation was not polled');
        continue;
      }
      if (this.forgotten?.(item)) {
        await this.ops.cancel(item).catch(() => {});
        this.outbox.markCancelled(item.id, 'the person asked to forget this while its operation was running');
        continue;
      }
      try {
        const state = await this.ops.status(item);
        if (state === 'completed') {
          if (this.outbox.markDone(item.id)) result.completed += 1;
        } else if (state === 'failed') {
          await this.ops.retry(item);
          this.outbox.noteRetry(item.id, 'the extraction failed; retried the operation', { count: true });
        } else if (state === 'cancelled') {
          this.outbox.markCancelled(item.id, 'the operation was cancelled');
        } else if (state === 'not_found') {
          // The server pruned the operation record. Re-submitting the same operation id is the
          // only way to find out whether the document was written; the document id makes a
          // duplicate retain converge on the same source.
          this.outbox.markFailed(item.id, 'the operation record is gone');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DeliveryError && err.permanent) {
          this.outbox.markFailed(item.id, message, { permanent: true });
        } else {
          this.outbox.noteRetry(item.id, message);
        }
      } finally {
        const current = this.outbox.get(item.id)?.state;
        if (current === 'sending' || current === 'sent') this.outbox.markPolled(item.id);
      }
    }
    for (const item of this.outbox.verificationDue(this.poll, this.now())) {
      if (!this.matchesTarget(item)) {
        this.outbox.quarantine(item.id, 'the memory bank or endpoint changed; this source was not verified');
        continue;
      }
      if (this.forgotten?.(item)) {
        this.outbox.markCancelled(item.id, 'the person asked to forget this before source verification');
        continue;
      }
      try {
        if (await this.ops.verify(item)) {
          if (this.outbox.markVerified(item.id)) result.verified += 1;
        } else {
          this.outbox.noteVerificationRetry(item.id, 'the completed operation has no matching readable source document yet');
        }
      } catch (err) {
        this.outbox.noteVerificationRetry(item.id, err instanceof Error ? err.message : String(err));
        result.failed += 1;
      }
    }
    return result;
  }

  private matchesTarget(item: OutboxItem): boolean {
    if (!this.target) return true;
    const target = this.target();
    return item.bankId === target.bankId && item.endpoint === target.endpoint;
  }

  /** Cancel operations for items the person asked to forget, then drop their payloads. */
  async cancelForget(items: readonly OutboxItem[]): Promise<void> {
    for (const item of items) {
      if ((item.state !== 'sending' && item.state !== 'sent' && item.state !== 'failed') || !this.matchesTarget(item)) continue;
      try {
        await this.ops.cancel(item);
      } catch (err) {
        // The operation may already be terminal; deleting the document below still covers it.
        this.log?.warn('[memory] could not cancel a forgotten retain operation', {
          operation: item.operationId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
