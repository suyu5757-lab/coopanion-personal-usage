import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SYNTHETIC_BANK_ID,
  SYNTHETIC_SOURCES,
} from '../coo-self-growth-trust/synthetic.ts';

export interface SyntheticCooGrowthBank {
  baseUrl: string;
  server: Server;
  has(bankId: string, documentId: string): boolean;
  get(bankId: string, documentId: string): { text: string; metadata: Record<string, string> } | null;
  seed(bankId: string, documentId: string, text: string, metadata: Record<string, string>): void;
  replace(bankId: string, documentId: string, text: string, metadata?: Record<string, string>): void;
  holdRead(bankId: string, documentId: string): { started: Promise<void>; release(): void };
  failNextRetain(): void;
  failCandidateReadAttempts(count: number): void;
}

interface DocumentRecord {
  text: string;
  metadata: Record<string, string>;
  updatedAt: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Local Hindsight-compatible HTTP surface backed only by an in-memory synthetic Bank. */
export async function createSyntheticCooGrowthBank(): Promise<SyntheticCooGrowthBank> {
  const documents = new Map<string, DocumentRecord>();
  const deleted = new Set<string>();
  const readGates = new Map<string, { started: () => void; wait: Promise<void> }>();
  let retainFailures = 0;
  let candidateReadFailures = 0;
  const key = (bankId: string, documentId: string): string => `${bankId}:${documentId}`;
  const now = '2026-11-10T00:00:00.000Z';
  for (const source of SYNTHETIC_SOURCES) {
    documents.set(key(SYNTHETIC_BANK_ID, source.documentId), {
      text: source.text,
      updatedAt: now,
      metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: source.saidAt },
    });
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.once('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const bankId = decodeURIComponent(/\/banks\/([^/]+)/.exec(url.pathname)?.[1] ?? SYNTHETIC_BANK_ID);
      const documentId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const send = (status: number, value?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(value === undefined ? undefined : JSON.stringify(value));
      };

      if (req.method === 'DELETE' && url.pathname.includes('/documents/')) {
        deleted.add(key(bankId, documentId));
        send(200, { success: true });
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/memories/recall')) {
        const sources = SYNTHETIC_SOURCES.flatMap((source, index) => {
          const record = documents.get(key(bankId, source.documentId));
          if (!record || deleted.has(key(bankId, source.documentId)) || record.metadata.source_actor !== 'user') return [];
          return [{
            ...source,
            text: record.text,
            metadata: record.metadata,
            factId: `synthetic-fact-${index + 1}`,
            observationId: `synthetic-observation-${index + 1}`,
          }];
        });
        send(200, {
          results: sources.map((source) => ({
            id: source.observationId,
            text: 'A synthetic past record.',
            type: 'observation',
            document_id: `synthetic-derived-${source.observationId}`,
            source_fact_ids: [source.factId],
          })),
          source_facts: Object.fromEntries(sources.map((source) => [source.factId, {
            id: source.factId,
            text: source.text,
            type: 'world',
            document_id: source.documentId,
            occurred_start: source.saidAt,
            metadata: source.metadata,
          }])),
          source_facts_truncated: false,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/memories')) {
        if (retainFailures > 0) {
          retainFailures -= 1;
          send(503, { detail: 'temporary synthetic retain failure' });
          return;
        }
        let payload: { items?: Array<{ content?: unknown; document_id?: unknown; metadata?: unknown }> } = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof payload; }
        catch { send(400, { detail: 'invalid synthetic retain payload' }); return; }
        const items = payload.items ?? [];
        for (const item of items) {
          if (typeof item.document_id !== 'string' || typeof item.content !== 'string') continue;
          const metadata = item.metadata && typeof item.metadata === 'object'
            ? Object.fromEntries(Object.entries(item.metadata).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
            : {};
          documents.set(key(bankId, item.document_id), { text: item.content, metadata, updatedAt: new Date().toISOString() });
          deleted.delete(key(bankId, item.document_id));
        }
        send(200, { success: true, bank_id: bankId, items_count: items.length, async: false });
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/documents')) {
        send(200, { items: [], total: 0, limit: Number(url.searchParams.get('limit') ?? 0), offset: 0 });
        return;
      }
      if (req.method === 'GET' && documentId.startsWith('coo-growth:') && candidateReadFailures > 0) {
        candidateReadFailures -= 1;
        send(503, { detail: 'temporary synthetic candidate read failure' });
        return;
      }
      const document = documents.get(key(bankId, documentId));
      if (!document || deleted.has(key(bankId, documentId))) { send(404); return; }
      if (req.method === 'GET') {
        const response = {
          id: documentId,
          bank_id: bankId,
          original_text: document.text,
          content_hash: sha256(document.text),
          created_at: document.updatedAt,
          updated_at: document.updatedAt,
          memory_unit_count: 1,
          document_metadata: document.metadata,
        };
        const gate = readGates.get(key(bankId, documentId));
        if (gate) {
          readGates.delete(key(bankId, documentId));
          gate.started();
          void gate.wait.then(() => send(200, response));
        } else send(200, response);
        return;
      }
      send(404);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    has: (bankId, documentId) => documents.has(key(bankId, documentId)) && !deleted.has(key(bankId, documentId)),
    get: (bankId, documentId) => {
      const document = documents.get(key(bankId, documentId));
      return !document || deleted.has(key(bankId, documentId)) ? null : { text: document.text, metadata: { ...document.metadata } };
    },
    seed: (bankId, documentId, text, metadata) => documents.set(key(bankId, documentId), { text, metadata, updatedAt: now }),
    replace: (bankId, documentId, text, metadata) => {
      const current = documents.get(key(bankId, documentId));
      if (!current) throw new Error(`unknown synthetic source: ${documentId}`);
      documents.set(key(bankId, documentId), {
        text,
        metadata: metadata ?? current.metadata,
        updatedAt: text === current.text ? current.updatedAt : new Date().toISOString(),
      });
      deleted.delete(key(bankId, documentId));
    },
    failNextRetain: () => { retainFailures += 1; },
    failCandidateReadAttempts: (count) => { candidateReadFailures += count; },
    holdRead: (bankId, documentId) => {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      readGates.set(key(bankId, documentId), { started: markStarted, wait });
      return { started, release };
    },
  };
}
