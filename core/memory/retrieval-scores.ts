export type RetrievalScoreValue =
  | { status: 'present'; value: number }
  | { status: 'missing' };

export interface RetrievalScoreEvidence {
  source: 'hindsight-recall';
  inputRank: number;
  final: RetrievalScoreValue;
  reranker: RetrievalScoreValue;
  semantic: RetrievalScoreValue;
  keyword: RetrievalScoreValue;
}

function scoreValue(value: unknown): RetrievalScoreValue {
  return typeof value === 'number' && Number.isFinite(value)
    ? { status: 'present', value }
    : { status: 'missing' };
}

export function captureRetrievalScores(scores: unknown, inputRank: number): RetrievalScoreEvidence {
  const raw = scores && typeof scores === 'object' && !Array.isArray(scores)
    ? scores as Record<string, unknown>
    : {};
  return {
    source: 'hindsight-recall',
    inputRank,
    final: scoreValue(raw.final),
    reranker: scoreValue(raw.reranker),
    semantic: scoreValue(raw.semantic),
    keyword: scoreValue(raw.keyword),
  };
}
