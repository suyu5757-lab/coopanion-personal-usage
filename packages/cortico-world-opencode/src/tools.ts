/** Tool declarations; `OpencodeWorld.tools()` binds the handlers. Descriptions are English whatever the model-text language. */
import type { ToolDef } from 'cortico/core/types.ts';

export const OPENCODE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'opencode_task',
    tags: ['act'],
    description: 'Hand a coding task to opencode, a separate coding agent that reads and edits files and runs commands in a directory the person allowed. It runs in the background and this returns at once. It asks for permission before writing or running a command; an opencode.result or opencode.failed event wakes you when it ends. One task at a time.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do: the goal, the symptoms, what to change, and how to verify it. Be specific.' },
        dir: { type: 'string', description: 'Absolute working directory, one of the directories the person allowed. Omit when exactly one is configured.' },
        resume: { type: 'boolean', description: 'true continues the last session in this directory; default false starts a new one.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'opencode_answer',
    tags: ['act'],
    description: 'Answer a pending opencode permission request. Call it only after the person chose an option in your pet_ask bubble. once allows this request, always allows matching requests for this session, reject refuses it.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id from the opencode.permission event.' },
        choice: { type: 'string', enum: ['once', 'always', 'reject'], description: "The person's answer." },
      },
      required: ['taskId', 'choice'],
    },
  },
  {
    name: 'opencode_stop',
    tags: ['act'],
    description: 'Stop the running opencode task. It winds down, the prompt ends as cancelled, and a result event follows.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id; omit to stop whatever is running.' },
      },
      required: [],
    },
  },
  {
    name: 'opencode_status',
    tags: ['read'],
    description: 'Say whether an opencode task is running, in which directory, and whether it waits for a permission answer.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'opencode_review',
    tags: ['read'],
    description: "Read the last opencode task's review: its final summary, changed files with added/removed line counts, and the commands it ran. Set diff true to include the old and new text of each changed file (truncated). Use it after an opencode.result to decide whether the work meets the request; if not, call opencode_task with resume true and say exactly what to fix.",
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id; omit for the last task.' },
        diff: { type: 'boolean', description: 'true includes the changed text; default false.' },
      },
      required: [],
    },
  },
];
