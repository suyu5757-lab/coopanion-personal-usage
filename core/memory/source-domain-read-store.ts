import type { DomainId, DomainSourcePage, SourceDomainClassification, SourceDomainStats } from './source-domains.ts';

/**
 * The state-store surface the source-domain read path needs. Writers, delivery accessors,
 * transactions and the SQLite handle stay outside this interface.
 */
export interface SourceDomainReadStore {
  getSourceDomainClassification(bankId: string, endpoint: string, documentId: string): SourceDomainClassification | null;
  listDomainSources(
    bankId: string,
    endpoint: string,
    domains: readonly DomainId[],
    opts?: { limit?: number; cursor?: string | null },
  ): DomainSourcePage;
  domainIndexStats(bankId: string, endpoint: string): SourceDomainStats;
}

/**
 * Facade -> the live store it closes over. Kept private so the facade never exposes a raw
 * writable store, while the safety probe below can still inspect what it really points at.
 */
const boundStores = new WeakMap<object, SourceDomainReadStore>();

/**
 * The private field `MemoryStateStore` always carries, whether or not a provider is set.
 * A missing field means the object is not a state store this module can audit, so it is
 * treated as unsafe instead of being assumed safe.
 */
const SYNC_READBACK_FIELD = 'sourceDomainEvidence';

function hasSyncReadbackProvider(store: SourceDomainReadStore): boolean {
  try {
    if (!Object.prototype.hasOwnProperty.call(store, SYNC_READBACK_FIELD)) return true;
    return (store as unknown as Record<string, unknown>)[SYNC_READBACK_FIELD] !== undefined;
  } catch {
    return true;
  }
}

/** Resolves nested facades to the live store; cycles or unbound facades fail closed. */
function liveStoreOf(store: SourceDomainReadStore): SourceDomainReadStore | null {
  let current: SourceDomainReadStore = store;
  const seen = new Set<object>();
  while (boundStores.has(current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    const next = boundStores.get(current);
    if (!next) return null;
    current = next;
  }
  return current;
}

/** Binds the read methods to the live store without handing out the store itself. */
export function createSourceDomainReadStore(store: SourceDomainReadStore): SourceDomainReadStore {
  const facade: SourceDomainReadStore = Object.freeze({
    getSourceDomainClassification: (bankId: string, endpoint: string, documentId: string) =>
      store.getSourceDomainClassification(bankId, endpoint, documentId),
    listDomainSources: (
      bankId: string,
      endpoint: string,
      domains: readonly DomainId[],
      opts?: { limit?: number; cursor?: string | null },
    ) => store.listDomainSources(bankId, endpoint, domains, opts),
    domainIndexStats: (bankId: string, endpoint: string) => store.domainIndexStats(bankId, endpoint),
  });
  boundStores.set(facade, store);
  return facade;
}

/**
 * True when the live store behind this handle may hold a synchronous reentrant readback
 * provider. The facade is resolved to its bound store and inspected on every call, so a
 * provider installed or replaced after facade creation cannot bypass the consumer guard.
 * A facade without a factory binding, or a reader without the state-store private field,
 * fails closed.
 */
export function sourceDomainReadStoreUsesSyncReadback(store: SourceDomainReadStore): boolean {
  const live = liveStoreOf(store);
  return live === null || hasSyncReadbackProvider(live);
}
