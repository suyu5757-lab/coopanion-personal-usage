import type { MemoryEvaluationCase } from '../../scripts/memory-evaluation.ts';

export interface MemoryEvaluationHoldoutDocument {
  sourceId: string;
  text: string;
  state: 'current' | 'superseded' | 'deleted';
  activationWeight?: number;
}

export interface MemoryEvaluationHoldoutCase extends MemoryEvaluationCase {
  category: string;
  query: string;
  documents: MemoryEvaluationHoldoutDocument[];
  forbiddenSourceIds: string[];
  mentionEvents?: Array<{
    userEventId: string;
    actor: 'user';
    sourceType: 'user_mention';
    targetSourceId: string;
    occurredAt: string;
    semanticMatch: number;
    intensity: number;
    deliveryAttempts: number;
  }>;
}

export interface MemoryEvaluationHoldoutPrompt {
  id: string;
  query: string;
}

export interface MemoryEvaluationHoldoutCorpusItem {
  caseId: string;
  documents: MemoryEvaluationHoldoutDocument[];
  mentionEvents?: MemoryEvaluationHoldoutCase['mentionEvents'];
}

const COLOURS = ['aubergine', 'burgundy', 'chartreuse', 'fuchsia', 'lavender', 'maroon', 'turquoise', 'vermilion'] as const;
const OBJECTS = ['birdhouse', 'hourglass', 'coaster', 'toolbox', 'windmill', 'keyring', 'paperweight', 'telescope'] as const;
const PLACES = ['the glasshouse', 'the riverside shed', 'the cedar room', 'the east arcade', 'the old observatory'] as const;
const HELPERS = ['Niko', 'Sora', 'Tavi', 'Uma', 'Venn', 'Wren', 'Yara', 'Zev'] as const;
const DATES = ['March 14', 'May 22', 'June 3', 'September 19', 'October 8', 'December 2', 'January 17'] as const;

const person = (family: string, index: number) => `${family} ${String(index + 1).padStart(2, '0')}`;
const source = (caseId: string, suffix: string) => `src-holdout-${caseId}-${suffix}`;
const itemId = (family: string, index: number) => `holdout-${family}-${String(index + 1).padStart(2, '0')}`;

function lowActivationCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('cue', index);
  const subject = person('Member', index);
  const colour = COLOURS[(index * 3) % COLOURS.length]!;
  const object = OBJECTS[(index * 5) % OBJECTS.length]!;
  const sourceId = source(id, 'memory');
  return {
    id,
    category: 'low_activation_cue',
    answerable: true,
    query: index % 2 === 0
      ? `Which colour did ${subject} choose for the ${object}?`
      : `${subject} 给 ${object} 选的是什么颜色？`,
    requiredSourceIds: [sourceId],
    forbiddenSourceIds: [],
    documents: [{ sourceId, text: `${subject} chose the ${colour} ${object}.`, state: 'current', activationWeight: 0.05 }],
  };
}

function naturalRecallCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('natural', index);
  const subject = person('Member', index);
  const object = OBJECTS[(index * 3) % OBJECTS.length]!;
  const colour = COLOURS[(index * 5 + 2) % COLOURS.length]!;
  const distractorColour = COLOURS[(index * 5 + 5) % COLOURS.length]!;
  const selected = source(id, 'memory');
  const distractor = source(id, 'similar-detail');
  return {
    id,
    category: 'natural_recall',
    answerable: true,
    query: index % 2 === 0
      ? `I'm ordering another ${object} for the workshop. What colour should I choose?`
      : `我准备再买一个工作坊用的 ${object}，你建议选什么颜色？`,
    requiredSourceIds: [selected],
    forbiddenSourceIds: [distractor],
    documents: [
      { sourceId: selected, text: `${subject} chose ${colour} for the ${object} at the workshop.`, state: 'current', activationWeight: 0.05 },
      { sourceId: distractor, text: `${subject} chose ${distractorColour} for a different item at the workshop.`, state: 'current', activationWeight: 0.6 },
    ],
  };
}

function multiHopCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('bridge', index);
  const subject = person('Organizer', index);
  const helper = HELPERS[(index * 3) % HELPERS.length]!;
  const colour = COLOURS[(index + 5) % COLOURS.length]!;
  const invitation = source(id, 'invitation');
  const outcome = source(id, 'outcome');
  return {
    id,
    category: 'low_activation_multihop',
    answerable: true,
    query: `What colour was the ${helper}'s project item after ${subject} invited them to the workshop?`,
    requiredSourceIds: [invitation, outcome],
    forbiddenSourceIds: [],
    documents: [
      { sourceId: invitation, text: `${subject} invited ${helper} to the workshop.`, state: 'current', activationWeight: 0.05 },
      { sourceId: outcome, text: `${helper} made a desk lamp with an ${colour} shade at the workshop.`, state: 'current', activationWeight: 0.4 },
    ],
  };
}

function timeUpdateCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('schedule', index);
  const subject = person('Planner', index);
  const oldDate = DATES[index % DATES.length]!;
  const newDate = DATES[(index + 3) % DATES.length]!;
  const earlier = source(id, 'earlier');
  const latest = source(id, 'latest');
  return {
    id,
    category: 'time_update',
    answerable: true,
    query: `On which date did ${subject} most recently reschedule the greenhouse visit?`,
    requiredSourceIds: [latest],
    forbiddenSourceIds: [earlier],
    documents: [
      { sourceId: earlier, text: `${subject} first planned the greenhouse visit for ${oldDate}.`, state: 'superseded', activationWeight: 0.1 },
      { sourceId: latest, text: `${subject} moved the greenhouse visit to ${newDate}.`, state: 'current', activationWeight: 0.7 },
    ],
  };
}

function correctionCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('correction', index);
  const subject = person('Designer', index);
  const earlierChoice = COLOURS[index % COLOURS.length]!;
  const correctedChoice = COLOURS[(index + 7) % COLOURS.length]!;
  const earlier = source(id, 'earlier');
  const correction = source(id, 'correction');
  return {
    id,
    category: 'user_correction',
    answerable: true,
    query: `What colour did ${subject} correct the map cover to?`,
    requiredSourceIds: [correction],
    forbiddenSourceIds: [earlier],
    documents: [
      { sourceId: earlier, text: `${subject} first chose ${earlierChoice} for the map cover.`, state: 'superseded', activationWeight: 0.15 },
      { sourceId: correction, text: `${subject} corrected the map cover choice to ${correctedChoice}.`, state: 'current', activationWeight: 0.7 },
    ],
  };
}

function qualifiedMentionsCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('mentioned', index);
  const subject = person('Keeper', index);
  const colour = COLOURS[(index + 1) % COLOURS.length]!;
  const targetSourceId = source(id, 'memory');
  const anchor = Date.UTC(2025, 0, 1) + index * 3 * 86_400_000;
  return {
    id,
    category: 'qualified_user_mentions',
    answerable: true,
    query: `What colour did ${subject} choose for the gallery label?`,
    requiredSourceIds: [targetSourceId],
    forbiddenSourceIds: [],
    documents: [{ sourceId: targetSourceId, text: `${subject} chose ${colour} for the gallery label.`, state: 'current', activationWeight: 0.05 }],
    mentionEvents: [
      {
        userEventId: source(id, 'mention-casual'), actor: 'user', sourceType: 'user_mention', targetSourceId,
        occurredAt: new Date(anchor + 45 * 86_400_000).toISOString(), semanticMatch: 0.9, intensity: 0.06, deliveryAttempts: 10,
      },
      {
        userEventId: source(id, 'mention-detailed'), actor: 'user', sourceType: 'user_mention', targetSourceId,
        occurredAt: new Date(anchor + 120 * 86_400_000).toISOString(), semanticMatch: 0.95, intensity: 0.2, deliveryAttempts: 1,
      },
    ],
  };
}

function deletedCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('deleted', index);
  const subject = person('Guest', index);
  const colour = COLOURS[(index + 2) % COLOURS.length]!;
  const deleted = source(id, 'deleted');
  const distractor = source(id, 'distractor');
  return {
    id,
    category: 'explicitly_deleted',
    answerable: false,
    query: `Which colour had ${subject} chosen for the event badge?`,
    requiredSourceIds: [],
    deletedSourceIds: [deleted],
    forbiddenSourceIds: [deleted, distractor],
    documents: [
      { sourceId: deleted, text: `${subject} chose ${colour} for the event badge.`, state: 'deleted' },
      { sourceId: distractor, text: `${subject} stored a spare sign in ${PLACES[index % PLACES.length]}.`, state: 'current' },
    ],
  };
}

function unrecordedCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('unrecorded', index);
  const subject = person('Maker', index);
  const distractor = source(id, 'distractor');
  return {
    id,
    category: 'unrecorded_fact',
    answerable: false,
    query: `Which city did ${subject} visit for the winter festival?`,
    requiredSourceIds: [],
    forbiddenSourceIds: [distractor],
    documents: [{ sourceId: distractor, text: `${subject} assembled the ${OBJECTS[index % OBJECTS.length]} in ${PLACES[index % PLACES.length]}.`, state: 'current' }],
  };
}

function ambiguousCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('ambiguous', index);
  const subject = person('Courier', index);
  const first = source(id, 'claim-a');
  const second = source(id, 'claim-b');
  const colourA = COLOURS[index % COLOURS.length]!;
  const colourB = COLOURS[(index + 1) % COLOURS.length]!;
  return {
    id,
    category: 'unresolved_conflict',
    answerable: false,
    query: `Which colour is the confirmed current case for ${subject}'s parcel label?`,
    requiredSourceIds: [],
    forbiddenSourceIds: [first, second],
    documents: [
      { sourceId: first, text: `${subject}'s parcel label is ${colourA}.`, state: 'current' },
      { sourceId: second, text: `${subject}'s parcel label is ${colourB}.`, state: 'current' },
    ],
  };
}

function nearMissCase(index: number): MemoryEvaluationHoldoutCase {
  const id = itemId('near-miss', index);
  const subject = person('Traveler', index);
  const distractor = source(id, 'similar-detail');
  const colour = COLOURS[(index + 4) % COLOURS.length]!;
  return {
    id,
    category: 'similar_but_unrecorded',
    answerable: false,
    query: `What colour was ${subject}'s raincoat?`,
    requiredSourceIds: [],
    forbiddenSourceIds: [distractor],
    documents: [{ sourceId: distractor, text: `${subject} carried an umbrella whose colour was ${colour} on the ferry.`, state: 'current' }],
  };
}

export function createMemoryEvaluationHoldoutSet(): MemoryEvaluationHoldoutCase[] {
  return [
    ...Array.from({ length: 10 }, (_, index) => lowActivationCase(index)),
    ...Array.from({ length: 10 }, (_, index) => naturalRecallCase(index)),
    ...Array.from({ length: 20 }, (_, index) => multiHopCase(index)),
    ...Array.from({ length: 20 }, (_, index) => timeUpdateCase(index)),
    ...Array.from({ length: 20 }, (_, index) => correctionCase(index)),
    ...Array.from({ length: 20 }, (_, index) => qualifiedMentionsCase(index)),
    ...Array.from({ length: 10 }, (_, index) => deletedCase(index)),
    ...Array.from({ length: 10 }, (_, index) => unrecordedCase(index)),
    ...Array.from({ length: 10 }, (_, index) => ambiguousCase(index)),
    ...Array.from({ length: 10 }, (_, index) => nearMissCase(index)),
  ];
}

export function createMemoryEvaluationHoldoutPrompts(): MemoryEvaluationHoldoutPrompt[] {
  return createMemoryEvaluationHoldoutSet().map(({ id, query }) => ({ id, query }));
}

export function createMemoryEvaluationHoldoutCorpus(): MemoryEvaluationHoldoutCorpusItem[] {
  return createMemoryEvaluationHoldoutSet().map(({ id, documents, mentionEvents }) => ({
    caseId: id,
    documents,
    ...(mentionEvents ? { mentionEvents } : {}),
  }));
}
