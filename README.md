# omp-modellog

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [omp](https://github.com/oh-my-pi) (`@oh-my-pi/pi-coding-agent`) extension
that answers one question: **which model roles did this session actually
use, in what order, and what did each cost?**

```
/modellog
Models used: plan -> claude-opus-5, task -> vCode, default -> gpt-5.6-luna

role     model           calls  in     out   cache r  cache w  cost     time    origin
-------  --------------  -----  -----  ----  -------  -------  -------  ------  --------
plan     claude-opus-5   4      16.6k  440   15.9k    0        $0.0038  10.8s
task     vCode           2      3.2k   1.4k  16.9k    0        $0.0028  27.2s   subagent: sonic (completed)
default  gpt-5.6-luna    11     28.1k  3.1k  74.8k    0        $0.0112  66.2s
-------  --------------  -----  -----  ----  -------  -------  -------  ------  --------
total                    17     47.9k  4.9k  107.6k   0        $0.0178  104.2s
```

![omp-modellog running in a live session, showing role, model, tokens, cost, time, and a still-running subagent](docs/screenshot.png)

*(In that screenshot, `task -> unknown` is caught mid-flight: the `pm-worker`
subagent hadn't resolved its model via the async `hub` handshake yet at the
moment `/modellog` ran — see [below](#the-async-task--hub-handshake-the-one-non-obvious-part).
It resolves once the subagent settles.)*

It also writes the same summary to a log file when the session ends, so you
don't have to remember to ask.

## Install

Clone it, then symlink it into omp's global extensions directory
(auto-discovered, hot-reloadable with `/restart`):

```bash
git clone https://github.com/barelyworkingcode/omp-modellog.git
ln -s "$(pwd)/omp-modellog" ~/.omp/agent/extensions/omp-modellog
```

Verify it loaded:

```bash
omp -p "/modellog"
# Models used: (none yet)
```

Alternatives:

- **Per-invocation (for testing):** `omp -e /path/to/omp-modellog/src/index.ts`
- **Declarative:** add the absolute path to the `"extensions"` array in `~/.omp/agent/settings.json`
- **Project-only:** symlink or copy into `<project>/.omp/extensions/`
- **Disable without uninstalling:** add `omp-modellog` to `disabledExtensions` in `~/.omp/agent/config.yml`

No build step and no runtime dependencies — omp loads the TypeScript
directly. `bun install` is only needed for local typecheck/tests
(`@oh-my-pi/pi-coding-agent` is a `devDependency` used purely for
`import type`, which is erased at load time).

## Commands

- `/modellog` — a table: role, model, call count, token breakdown, cost, time spent, origin.
- `/modellog roles` — just the headline.
- `/modellog json` — machine-readable, same data.

A live one-line summary also shows in the status bar as the session runs.

## How it decides "role"

omp already records which role produced each turn — this extension mostly
*replays* that, it doesn't infer much:

- Every model switch is a `model_change` session entry carrying `role` (e.g.
  `"plan"`, `"smol"`). Per omp's own source comment, an **undefined** role
  means the default model, so that's labeled `default`.
- `"fallback"` is a real sentinel (a retry silently swapped in a fallback
  model) and is shown as its own role, not folded into anything else.
- `"temporary"` means an explicit `/model` pick made outside the role system
  (not persisted to a role). This extension tries to match that model back
  to whichever configured role currently points at it (`ctx.models.resolve("@<role>")`
  for each of the nine built-in roles); if none match, it's labeled `custom`.
  Such rows are marked with a trailing `*` and footnoted, since the label is
  inferred rather than structurally recorded.
- Background/auxiliary model calls (`model_usage` entries, e.g. auto-thinking)
  show up as their own `aux`-origin rows, labeled by role or purpose.
- `task`-tool sub-agent runs are labeled by the role/agent the task tool
  itself declared (`modelRole` on the tool result), not the parent turn's role.

Rows are inserted into an order-preserving map the first time a
(role, model) pair appears, and **never re-sorted** — that's what makes the
headline reflect true call order.

## The async `task` → `hub` handshake (the one non-obvious part)

This build's `task` tool spawns asynchronously by default. The `task` tool
result recorded at call time is a placeholder — `results: []` and a
`progress: [{ status: "pending", ... }]` entry with **no resolved model and
all-zero counters**. The actual outcome (resolved model, duration, final
status) arrives later through a *separate* `hub` tool result (`hub jobs` /
`hub wait`), keyed by the same job id.

This was discovered empirically against a live session, not from the
extension docs — a naive implementation that only reads `task` results
would show `unknown` forever for any subagent launched this way. This
extension tracks subagent rows by job id across both tool results and
reconciles the `hub` completion into the row the `task` placeholder created,
including a de-dupe guard so re-polling an already-settled job doesn't
double-count its duration.

**Known limitation:** the `hub` completion snapshot carries duration and
resolved model, but no token/cost usage. A subagent's tokens/cost are only
available when its `task` result eventually reports a populated `results[]`
entry with `usage` — if a subagent is reaped purely through `hub` without
ever getting a completed `task`-side result, its row shows real duration but
`-` for cost.

## Why not `~/.omp/stats.db`

There's an internal sqlite analytics store at `~/.omp/stats.db` with
per-message tokens/cost/duration. It was deliberately **not** used:

- It has no `role` column — it can't answer the actual question.
- Everything useful in it (duration, usage, cost) is already on the session
  entries this extension reads directly.
- It's populated by a background sync worker, so it lags the live session —
  exactly wrong for an end-of-session report.
- It's undocumented and not part of the extension API surface, so its shape
  could change under this extension without notice.

## End-of-session log

On `session_shutdown` (and on `session_before_switch` for `/new`, `/resume`,
`/fork`), a summary is appended to:

- `~/.omp/agent/modellog/sessions.jsonl` — one JSON record per session
- `~/.omp/agent/modellog/sessions.log` — one human-readable line per session

The TUI is not paintable by the time `session_shutdown` fires (omp explicitly
avoids a final render during teardown), so this is a **file write**, not a
UI notification. It's synchronous on purpose — `session_shutdown` handlers
get a hard ~2s budget, and a sync `fs.appendFileSync` can't be cut short by
that timeout the way an `await` could.

Overrides:

- `OMP_MODELLOG_DIR=/path` — write the log elsewhere.
- `OMP_MODELLOG_QUIET=1` — disable the end-of-session write entirely (the
  `/modellog` command still works).

A sub-agent (task tool) run reloads this same extension inside itself; a
`session_init` entry is the one reliable signal that a session is a
sub-agent, and every command/hook here checks it first so nothing is
double-registered or double-logged inside a sub-agent.

## Development

```bash
bun install   # devDependency only, for typecheck/tests
bun test      # collect/roles/format are pure and fully unit tested
tsc --noEmit -p tsconfig.json
```

`src/collect.ts`, `src/roles.ts`, and `src/format.ts` have no omp import at
all — they take plain data in and plain data out, which is what makes them
testable without a running TUI. `src/index.ts` is the only file that touches
the real `ExtensionAPI`.

Manual smoke test against the real binary:

```bash
mkdir -p /tmp/modellog-scratch && cd /tmp/modellog-scratch
omp -p "hi" -e /path/to/omp-modellog/src/index.ts --mode text   # loads without error
omp -p "/modellog" -c -e /path/to/omp-modellog/src/index.ts --mode text   # replays the session
```

## License

[MIT](LICENSE)
