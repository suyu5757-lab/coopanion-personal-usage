import type { MemoryReadStatus } from './hindsight.ts';

/** Status notices keep an empty result distinct from a failed or restricted history read. */
export function memoryReadNotice(status: MemoryReadStatus): string {
  if (status === 'absent') return '[memory] No verified source record matched this query.';
  if (status === 'unavailable') return '[memory] Historical memory could not be checked because the service is unavailable. This does not mean the record is absent.';
  if (status === 'fenced') return '[memory] Historical memory is restricted while a forget request or unreadable ledger is unresolved. Do not use derived memory.';
  return '';
}
