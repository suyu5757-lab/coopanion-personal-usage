# `packages/cortico-world-opencode/src/definition.ts` and `src/world.ts`

# cortico-world-opencode

Coo can hand a coding task to a local `opencode` through the Agent Client Protocol. In Coopanion,
Core confirms each command and file write for one dispatch, binds the grant to the allowed workspace,
and stores the action receipt. The exact payload received through `fs/write_text_file` is checked
against its grant, then read back for evidence. The standalone `opencode_answer` flow
is available only when the World is used without Coopanion Core authorization.

## Configuration

The World is off until it is activated in the advanced settings' World overview. Its config lives
under `worlds.opencode`:

| key | meaning |
|---|---|
| `bin` | the `opencode` executable; `opencode` from `PATH` by default |
| `workRoots` | the absolute directories a task may start in, separated by newlines, commas or semicolons |
| `taskMinutes` | the longest one task may run |
| `permissionMinutes` | how long a permission request waits for the person |
| `askSensitive` | force opencode to ask before writing, running commands or fetching pages |

`opencode` must be signed in already (`opencode auth login`). The World never passes `--auto`.

## Behavior

With Coopanion Core authorization, the World exposes `opencode_task`, `opencode_stop`, `opencode_status`
and `opencode_review`; standalone use also exposes `opencode_answer`. A task starts an `opencode acp`
child process in the chosen directory, sends one prompt asynchronously and returns at once. The turn
ends with `opencode.result` or `opencode.failed`. The result event carries the summary, changed files with line counts and the commands run;
`opencode_review` shows the old and new text of each change. The bot reviews the result and either
accepts it or resumes the same session with specific fixes. The World also tells the app to show the
small opencode avatar beside the pet (`onState` in `src/definition.ts`), which produces the boot,
work, wait, done and oops states.

## Tests

`pnpm run test:worlds` runs the suite against the framework pinned in `vendor/cortico`. The fake
ACP agent in `tests/fixtures` is the scripted model side; the World, child process, JSON-RPC line
protocol and temporary work directory are real, and the test host records the events it pushes.
