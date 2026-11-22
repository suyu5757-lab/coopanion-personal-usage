export const SYNTHETIC_BANK_ID = 'synthetic-growth-bank';

export const SYNTHETIC_SOURCES = [
  {
    documentId: 'synthetic-user-event-1',
    text: 'A person prefers a quiet start to focused work.',
    saidAt: '2026-10-01T10:00:00.000Z',
  },
  {
    documentId: 'synthetic-user-event-2',
    text: 'A person again asked for uninterrupted focus time.',
    saidAt: '2026-10-08T10:00:00.000Z',
  },
] as const;

export const SYNTHETIC_PROPOSAL = {
  title: 'Protect focused work time',
  summary: 'Wait before routine interruptions during focused work.',
  evidence: ['A person prefers a quiet start to focused work.'],
  sourceIds: [SYNTHETIC_SOURCES[0].documentId],
  risk: 'low',
  changes: [{
    file: 'SELF.md',
    to: 'Wait before routine interruptions during focused work.',
    reason: 'A synthetic user event records this preference.',
  }],
} as const;

export const SYNTHETIC_COMPLETE_COO_OUTPUT = `Synthetic complete Xi output ${'x'.repeat(5000)}`;
