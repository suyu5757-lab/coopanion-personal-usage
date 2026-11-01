import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { OutboxDelivery, type DeliveryOps } from '../core/memory/delivery.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';

describe('recall during source read-back', () => {
  for (const forgetDuringRead of [false, true]) {
    it(forgetDuringRead
      ? 'discards an in-flight recall when its source is forgotten after an unrelated delivery completes'
      : 'keeps an in-flight recall when an unrelated delivery is verified', async () => {
      const root = mkdtempSync(join(tmpdir(), 'coo-recall-delivery-'));
      let received!: () => void, release!: () => void;
      const requestReceived = new Promise<void>((resolve) => { received = resolve; });
      const responseReleased = new Promise<void>((resolve) => { release = resolve; });
      const content = 'A new unrelated source event.';
      const server = createServer((request, response) => {
        request.resume();
        request.once('end', () => {
          const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
          if (request.method === 'POST' && path.endsWith('/memories/recall')) {
            received();
            void responseReleased.then(() => {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(JSON.stringify({
                results: [{ id: 'existing-fact', document_id: 'existing-event', type: 'world', text: 'The remembered marker is cobalt.' }],
              }));
            });
          } else if (request.method === 'GET' && path.endsWith('/documents/new-event')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ id: 'new-event', bank_id: 'fixture-bank', original_text: content }));
          } else if (request.method === 'DELETE' && path.endsWith('/documents/existing-event')) {
            response.writeHead(204); response.end();
          } else { response.writeHead(404); response.end(); }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const store = openMemoryStateStore(join(root, 'state.sqlite'));
      const outbox = new MemoryOutbox(store), ledger = new ForgetLedger(store), memory = new HindsightMemory();
      Object.assign(memory, {
        config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: baseUrl, bankId: 'fixture-bank' }),
        client: new HindsightClient({ baseUrl, maxAttempts: 1 }), stateStore: store, outbox, ledger, ready: true, unavailableUntil: 0,
      });
      const runtime = memory as unknown as {
        deliveryOps(): DeliveryOps;
        delivery: OutboxDelivery;
        drain(): Promise<void>;
        latestDelivery: { verified: number };
        modelRefreshTimer: ReturnType<typeof setTimeout> | null;
      };
      runtime.delivery = new OutboxDelivery(outbox, runtime.deliveryOps(), { target: () => ({ bankId: 'fixture-bank', endpoint: baseUrl }) });
      expect(outbox.add({ bankId: 'fixture-bank', endpoint: baseUrl, documentId: 'new-event', content, context: '', tags: [], priority: 'normal' })).toBe('queued');
      const queued = outbox.due(new Date(), 1)[0]!;
      outbox.markDone(queued.id);
      try {
        const pending = memory.recallForTurn('What is the remembered marker?', { activationEnabled: false });
        await requestReceived;
        await runtime.drain();
        expect(outbox.get(queued.id)?.state).toBe('verified');
        expect(runtime.latestDelivery.verified).toBe(1);
        if (forgetDuringRead) await memory.forgetDocument('existing-event');
        release();
        const read = await pending;
        expect(read.status).toBe(forgetDuringRead ? 'fenced' : 'found');
        expect(read.text.includes('cobalt')).toBe(!forgetDuringRead);
        if (forgetDuringRead) expect(ledger.forgotten('fixture-bank', baseUrl, 'existing-event')).toBe(true);
      } finally {
        release();
        if (runtime.modelRefreshTimer) clearTimeout(runtime.modelRefreshTimer);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        closeMemoryStateStores();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
