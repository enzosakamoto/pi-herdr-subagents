# pi-herdr-subagents

[Português (Brasil)](README.pt-BR.md)

Asynchronous pi subagents, running visibly in Herdr terminal panes.

> **Status: layout checkpoint awaiting authorization.** Read-only inspection of Herdr 0.9.3 confirmed that the literal BSP algorithm needs a topology adaptation. [Evidence and proposed temporary staging tab](docs/superpowers/plans/2026-10-03-layout-checkpoint.md). The tool examples below remain the intended API; executable extension code is not implemented yet.

## What it does

The main pi delegates independent tasks to other pi processes without waiting for them to finish. Each child gets its own conversation and terminal pane. The main agent can continue working, check progress, wait when a dependency matters, or explicitly cancel a child.

Completed results are saved and delivered to the main agent before the corresponding panes close. Blocked agents and results that could not be safely collected remain visible for intervention.

### Layout

```text
┌──────────────────┬─────────┬─────────┐
│                  │ Child 1 │ Child 4 │
│                  ├─────────┼─────────┤
│     Main pi      │ Child 2 │ Child 5 │
│                  ├─────────┼─────────┤
│                  │ Child 3 │ Child 6 │
└──────────────────┴─────────┴─────────┘
        50%            25%       25%
```

- One to three children: one column occupying the right half.
- Four to six children: two columns sharing the right half.
- Up to three evenly stacked children per column; six active children maximum.
- Background operations preserve the user's focus.
- After collection, close owned child panes and compact the layout.
- No children: the main pane regains its space.
- MVP requires a tab initially containing only the main pane. Existing user panes are not adopted or closed.

## Requirements

- pi with TypeScript extension and Pi package support. Development targets pi 1.0.0.
- Herdr installed and running; development targets Herdr 0.9.3. The required layout capabilities must be verified during implementation.
- Run the main pi inside a Herdr-managed pane (`HERDR_ENV=1`).
- Herdr's pi integration installed for the same user/agent directory:

  ```bash
  herdr integration install pi
  ```

- Usable pi model credentials. Child sessions inherit the main model and thinking level.

Installing this package does not install Herdr, grant project trust, or automatically update Herdr's integration.

## Installation

**These commands become functional after the extension and package manifest are implemented.** No remote repository has been created yet.

Local checkout:

```bash
pi install /absolute/path/to/pi-herdr-subagents
```

After publishing your own Git repository, replace `OWNER`:

```bash
pi install git:github.com/OWNER/pi-herdr-subagents
# Optional: pin a published tag.
pi install git:github.com/OWNER/pi-herdr-subagents@v0.1.0
```

Reload pi after installation with `/reload`. To try a package without adding it to personal settings:

```bash
pi -e /absolute/path/to/pi-herdr-subagents
```

Manage packages with `pi list`, `pi update --extensions`, and `pi remove <source>`.

## Usage

Ask the main agent in natural language:

> Investigate the authentication flow in a child agent while you work on the API. Do not change the same files. Incorporate the findings when they are ready.

Or explicitly load the packaged skill:

```text
/skill:pi-herdr-subagents investigate the authentication flow in parallel
```

### Planned tool: `herdr_subagent`

Examples are model-callable tool arguments, not shell commands:

```json
{"action":"spawn","task":"Map the authentication flow. Report relevant files and risks without changing code.","instructions":"You are a focused code investigator."}
```

Spawn returns a task identifier immediately, before model work completes. Use the returned ID rather than guessing IDs or pane names:

```json
{"action":"list"}
{"action":"status","taskId":"RETURNED_TASK_ID"}
{"action":"wait","taskId":"RETURNED_TASK_ID","timeoutMs":120000}
{"action":"cancel","taskId":"RETURNED_TASK_ID"}
```

Results remain consultable after their panes close. Completion messages are queued as follow-ups instead of interrupting current work.

## Operational boundaries

- A seventh active child is rejected; no task queue or recursive delegation.
- Interrupting the main agent's turn does not automatically cancel independent children.
- A wait timeout does not cancel a child and does not mean its prompt was not delivered.
- Approval/question blocks require deliberate human intervention; never auto-approve.
- `idle`/`done` means ready for input, not necessarily successful work. `unknown` is not completion.
- Reload/shutdown releases local observers, not live children. Resumption reconciles task identity before control.
- Close only extension-created panes whose matching results have been safely persisted.
- Panes isolate conversations, **not files, credentials or OS permissions**. Define disjoint write ownership. Worktrees and sandboxing are not provided by this MVP.

## Development

- [Specification](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md) (Portuguese).
- [Implementation plan](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md).
- [Usage skill](skills/pi-herdr-subagents/SKILL.md).

The implementation will add `package.json`, a `pi.extensions`/`pi.skills` manifest, source and automated tests. Planned checks are `npm test`, `npm run check`, package loading and isolated live layout verification. They are not available/passed yet.

A key implementation checkpoint is preserving live workers while reshaping Herdr's BSP layout. Do not rebuild running terminals with `layout.apply`; verify supported movement/split operations before promising arbitrary compaction.
