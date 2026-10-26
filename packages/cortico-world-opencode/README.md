# cortico-world-opencode

The opencode World, declared in `src/definition.ts` and run by `src/world.ts`.

Coo can hand a coding task to a local `opencode` through the Agent Client Protocol. opencode works
inside the directories the person allowed; every file write and command it wants to run arrives as
a permission request, which Coo relays to the person with the original command unchanged. Results
come back as World events.

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

`opencode` must be signed in already (`opencode auth login`). The World never passes `--auto` and
never answers a permission request on the person's behalf.

## Behavior

The World exposes `opencode_task`, `opencode_answer`, `opencode_stop`, `opencode_status` and `opencode_review`. A task
starts an `opencode acp` child process in the chosen directory, sends one prompt asynchronously and
returns at once. Progress that needs a decision arrives as `opencode.permission`; the turn ends with
`opencode.result` or `opencode.failed`. The result event carries the summary, changed files with line counts and the commands run;
`opencode_review` shows the old and new text of each change. The bot reviews the result and either
accepts it or resumes the same session with specific fixes. The World also tells the app to show the
small opencode avatar beside the pet (`onState` in `src/definition.ts`), which produces the boot,
work, wait, done and oops states.

## Tests

`pnpm run test:worlds` runs the suite against the framework pinned in `vendor/cortico`. The fake
ACP agent in `tests/fixtures` is the scripted model side; the World, child process, JSON-RPC line
protocol and temporary work directory are real, and the test host records the events it pushes.
