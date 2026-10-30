import type { MemoryEvaluationCase } from '../../scripts/memory-evaluation.ts';

export interface SyntheticMemoryDocument {
  sourceId: string;
  text: string;
  state: 'current' | 'superseded' | 'deleted';
}

export interface SyntheticMemoryEvaluationCase extends MemoryEvaluationCase {
  category: string;
  query: string;
  expectedAnswer?: string;
  documents: SyntheticMemoryDocument[];
  forbiddenSourceIds: string[];
}

const COLOURS = ['amber', 'cobalt', 'coral', 'indigo', 'mint', 'ochre', 'silver', 'teal'] as const;
const PLACES = ['the north room', 'the garden table', 'the library hall', 'the west studio'] as const;
const NAMES = ['Ari', 'Bo', 'Cai', 'Dara', 'Eli', 'Fenn', 'Gio', 'Hale'] as const;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

const sourceId = (index: number, suffix: string) => `src-dev-${String(index).padStart(4, '0')}-${suffix}`;
const person = (index: number) => `Person ${String(index).padStart(4, '0')}`;

function answerableCase(index: number): SyntheticMemoryEvaluationCase {
  const subject = person(index);
  const colour = COLOURS[index % COLOURS.length]!;
  const otherColour = COLOURS[(index + 3) % COLOURS.length]!;
  const place = PLACES[index % PLACES.length]!;
  const reviewer = NAMES[index % NAMES.length]!;
  const oldDay = WEEKDAYS[index % WEEKDAYS.length]!;
  const currentDay = WEEKDAYS[(index + 2) % WEEKDAYS.length]!;
  const a = sourceId(index, 'a');
  const b = sourceId(index, 'b');
  const category = index % 8;
  if (category === 0) {
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'single_fact',
      query: `Which colour did ${subject} choose for the paper kite?`, expectedAnswer: colour,
      requiredSourceIds: [a], forbiddenSourceIds: [],
      documents: [{ sourceId: a, text: `${subject} chose ${colour} for the paper kite.`, state: 'current' }],
    };
  }
  if (category === 1) {
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'multi_source',
      query: `Where did ${subject} reserve a table, and who reviewed the plan?`, expectedAnswer: `${place}; ${reviewer}`,
      requiredSourceIds: [a, b], forbiddenSourceIds: [],
      documents: [
        { sourceId: a, text: `${subject} reserved a table at ${place}.`, state: 'current' },
        { sourceId: b, text: `${reviewer} reviewed ${subject}'s plan.`, state: 'current' },
      ],
    };
  }
  if (category === 2) {
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'time_update',
      query: `Which day did ${subject} most recently move the appointment to?`, expectedAnswer: currentDay,
      requiredSourceIds: [b], forbiddenSourceIds: [a],
      documents: [
        { sourceId: a, text: `${subject} first planned the appointment for ${oldDay}.`, state: 'superseded' },
        { sourceId: b, text: `${subject} moved the appointment to ${currentDay}.`, state: 'current' },
      ],
    };
  }
  if (category === 3) {
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'correction',
      query: `What colour did ${subject} correct the kite choice to?`, expectedAnswer: otherColour,
      requiredSourceIds: [b], forbiddenSourceIds: [a],
      documents: [
        { sourceId: a, text: `${subject} originally chose ${colour} for the kite.`, state: 'superseded' },
        { sourceId: b, text: `${subject} corrected the kite colour to ${otherColour}.`, state: 'current' },
      ],
    };
  }
  if (category === 4) {
    const teammate = NAMES[(index + 2) % NAMES.length]!;
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'multi_hop',
      query: `What item did the teammate introduced by ${subject} bring?`, expectedAnswer: colour,
      requiredSourceIds: [a, b], forbiddenSourceIds: [],
      documents: [
        { sourceId: a, text: `${subject} introduced ${teammate} to the group.`, state: 'current' },
        { sourceId: b, text: `${teammate} brought the ${colour} notebook.`, state: 'current' },
      ],
    };
  }
  if (category === 5) {
    const companion = NAMES[(index + 1) % NAMES.length]!;
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'relationship_change',
      query: `What current project relationship did ${subject} describe with ${companion}?`, expectedAnswer: 'collaborators',
      requiredSourceIds: [a, b], forbiddenSourceIds: [],
      documents: [
        { sourceId: a, text: `In an earlier note, ${subject} and ${companion} were coworkers.`, state: 'superseded' },
        { sourceId: b, text: `${subject} later described ${companion} as a project collaborator.`, state: 'current' },
      ],
    };
  }
  if (category === 6) {
    return {
      id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'cross_language',
      query: `${subject} 给纸风筝选了什么颜色？`, expectedAnswer: colour,
      requiredSourceIds: [a], forbiddenSourceIds: [],
      documents: [{ sourceId: a, text: `${subject} chose ${colour} for the paper kite.`, state: 'current' }],
    };
  }
  return {
    id: `dev-answer-${String(index).padStart(4, '0')}`, answerable: true, category: 'contradiction_time',
    query: `Which colour is the latest confirmed kite choice for ${subject}?`, expectedAnswer: otherColour,
    requiredSourceIds: [b], forbiddenSourceIds: [a],
    documents: [
      { sourceId: a, text: `${subject} selected ${colour} in an earlier note.`, state: 'superseded' },
      { sourceId: b, text: `${subject} confirmed ${otherColour} in the later correction.`, state: 'current' },
    ],
  };
}

function unanswerableCase(index: number): SyntheticMemoryEvaluationCase {
  const caseIndex = 10_000 + index;
  const subject = person(caseIndex);
  const distractor = sourceId(caseIndex, 'distractor');
  if (index % 2 === 0) {
    const deleted = sourceId(caseIndex, 'deleted');
    const answer = COLOURS[index % COLOURS.length]!;
    return {
      id: `dev-no-answer-${String(index).padStart(4, '0')}`, answerable: false, category: 'explicitly_deleted',
      query: `What colour had ${subject} chosen for the paper kite?`, requiredSourceIds: [],
      deletedSourceIds: [deleted], forbiddenSourceIds: [deleted, distractor],
      documents: [
        { sourceId: deleted, text: `${subject} chose ${answer} for the paper kite.`, state: 'deleted' },
        { sourceId: distractor, text: `${subject} keeps a notebook in ${PLACES[index % PLACES.length]}.`, state: 'current' },
      ],
    };
  }
  return {
    id: `dev-no-answer-${String(index).padStart(4, '0')}`, answerable: false, category: 'unrecorded_fact',
    query: `Which instrument did ${subject} buy last year?`, requiredSourceIds: [], forbiddenSourceIds: [distractor],
    documents: [{ sourceId: distractor, text: `${subject} chose ${COLOURS[index % COLOURS.length]} for the paper kite.`, state: 'current' }],
  };
}

export function createDevelopmentMemoryEvaluationSet(): SyntheticMemoryEvaluationCase[] {
  return [
    ...Array.from({ length: 200 }, (_, index) => answerableCase(index)),
    ...Array.from({ length: 50 }, (_, index) => unanswerableCase(index)),
  ];
}
