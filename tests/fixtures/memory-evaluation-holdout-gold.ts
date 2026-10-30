import type { MemoryEvaluationHoldoutCase } from './memory-evaluation-holdout.ts';

/** Scoring-only gold. Evaluation runners should load this after baseline and activation observations are frozen. */
export interface MemoryEvaluationHoldoutGold {
  caseId: string;
  expectedAnswer: string | null;
  requiredSourceIds: string[];
}

const COLOURS = ['aubergine', 'burgundy', 'chartreuse', 'fuchsia', 'lavender', 'maroon', 'turquoise', 'vermilion'] as const;
const DATES = ['March 14', 'May 22', 'June 3', 'September 19', 'October 8', 'December 2', 'January 17'] as const;
const id = (family: string, index: number) => `holdout-${family}-${String(index + 1).padStart(2, '0')}`;
const source = (caseId: string, suffix: string) => `src-holdout-${caseId}-${suffix}`;

function answerableGold(family: string, index: number, expectedAnswer: string, sourceIds: string[]): MemoryEvaluationHoldoutGold {
  return { caseId: id(family, index), expectedAnswer, requiredSourceIds: sourceIds };
}

function noAnswerGold(family: string, index: number): MemoryEvaluationHoldoutGold {
  return { caseId: id(family, index), expectedAnswer: null, requiredSourceIds: [] };
}

export function createMemoryEvaluationHoldoutGold(): MemoryEvaluationHoldoutGold[] {
  return [
    ...Array.from({ length: 20 }, (_, index) => {
      const caseId = id('cue', index);
      return answerableGold('cue', index, COLOURS[(index * 3) % COLOURS.length]!, [source(caseId, 'memory')]);
    }),
    ...Array.from({ length: 20 }, (_, index) => {
      const caseId = id('bridge', index);
      const colour = COLOURS[(index + 5) % COLOURS.length]!;
      return answerableGold('bridge', index, colour, [source(caseId, 'invitation'), source(caseId, 'outcome')]);
    }),
    ...Array.from({ length: 20 }, (_, index) => {
      const caseId = id('schedule', index);
      return answerableGold('schedule', index, DATES[(index + 3) % DATES.length]!, [source(caseId, 'latest')]);
    }),
    ...Array.from({ length: 20 }, (_, index) => {
      const caseId = id('correction', index);
      return answerableGold('correction', index, COLOURS[(index + 7) % COLOURS.length]!, [source(caseId, 'correction')]);
    }),
    ...Array.from({ length: 20 }, (_, index) => {
      const caseId = id('mentioned', index);
      return answerableGold('mentioned', index, COLOURS[(index + 1) % COLOURS.length]!, [source(caseId, 'memory')]);
    }),
    ...Array.from({ length: 10 }, (_, index) => noAnswerGold('deleted', index)),
    ...Array.from({ length: 10 }, (_, index) => noAnswerGold('unrecorded', index)),
    ...Array.from({ length: 10 }, (_, index) => noAnswerGold('ambiguous', index)),
    ...Array.from({ length: 10 }, (_, index) => noAnswerGold('near-miss', index)),
  ];
}

export function validateMemoryEvaluationHoldoutGold(cases: readonly MemoryEvaluationHoldoutCase[], gold: readonly MemoryEvaluationHoldoutGold[]): void {
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error('holdout cases have duplicate IDs');
  if (new Set(gold.map((item) => item.caseId)).size !== gold.length) throw new Error('holdout gold has duplicate case IDs');
  if (cases.length !== gold.length) throw new Error('holdout cases and gold have different lengths');
  const casesById = new Map(cases.map((item) => [item.id, item]));
  for (const item of gold) {
    const testCase = casesById.get(item.caseId);
    if (!testCase) throw new Error(`holdout gold has no case: ${item.caseId}`);
    if (testCase.answerable !== (item.expectedAnswer !== null)) throw new Error(`holdout answerability disagrees: ${item.caseId}`);
    if (testCase.requiredSourceIds.join('\0') !== item.requiredSourceIds.join('\0')) throw new Error(`holdout source gold disagrees: ${item.caseId}`);
    const sourceIds = new Set(testCase.documents.map((document) => document.sourceId));
    if (item.requiredSourceIds.some((sourceId) => !sourceIds.has(sourceId))) throw new Error(`holdout answer source is missing: ${item.caseId}`);
    if (item.expectedAnswer !== null && !item.requiredSourceIds.some((sourceId) => testCase.documents
      .find((document) => document.sourceId === sourceId)?.text.toLowerCase().includes(item.expectedAnswer!.toLowerCase()))) {
      throw new Error(`holdout answer has no matching source evidence: ${item.caseId}`);
    }
    if ([...item.requiredSourceIds, ...(testCase.deletedSourceIds ?? []), ...testCase.forbiddenSourceIds]
      .some((sourceId) => !sourceIds.has(sourceId))) throw new Error(`holdout source reference is missing: ${item.caseId}`);
    const eventIds = new Set<string>();
    for (const event of testCase.mentionEvents ?? []) {
      if (!event.userEventId || eventIds.has(event.userEventId)) throw new Error(`holdout mention event ID is empty or duplicated: ${item.caseId}`);
      if (event.actor !== 'user' || event.sourceType !== 'user_mention') throw new Error(`holdout reinforcement is not user-sourced: ${item.caseId}`);
      if (!sourceIds.has(event.targetSourceId)) throw new Error(`holdout mention target is missing: ${item.caseId}`);
      if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error(`holdout mention timestamp is invalid: ${item.caseId}`);
      if (!Number.isFinite(event.semanticMatch) || event.semanticMatch < 0 || event.semanticMatch > 1
        || !Number.isFinite(event.intensity) || event.intensity < 0 || event.intensity > 1) {
        throw new Error(`holdout mention evidence is out of range: ${item.caseId}`);
      }
      if (!Number.isInteger(event.deliveryAttempts) || event.deliveryAttempts < 1) throw new Error(`holdout mention deliveries are invalid: ${item.caseId}`);
      eventIds.add(event.userEventId);
    }
    if ((item.expectedAnswer === null) && item.requiredSourceIds.length > 0) throw new Error(`no-answer holdout case has required sources: ${item.caseId}`);
  }
}
