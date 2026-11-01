import type { RecallResponse } from '@vectorize-io/hindsight-client';

export interface SourceFactCounts {
  declared: number;
  returned: number;
  valid: number;
  missing: number;
  invalid: number;
  parsed?: number;
}

export function summarizeSourceFacts(response: RecallResponse): SourceFactCounts {
  const declared = new Set(response.results.flatMap((result) => result.source_fact_ids ?? []));
  const facts = response.source_facts ?? {};
  const valid = Object.entries(facts).filter(([id, fact]) => fact?.id === id
    && typeof fact.document_id === 'string' && !!fact.document_id.trim()
    && typeof fact.text === 'string' && !!fact.text.trim());
  return {
    declared: declared.size,
    returned: Object.keys(facts).length,
    valid: valid.length,
    missing: [...declared].filter((id) => !Object.hasOwn(facts, id)).length,
    invalid: Object.keys(facts).length - valid.length,
  };
}
