# Implementation plan — pi-herdr-subagents

## Authority and scope

The user approved autonomous asynchronous delegation, the layout and automatic pane closure, and explicitly requested this Git repository, bilingual READMEs, a usage skill and implementation by a new pi in a new Herdr Space. Implement the spec at `../specs/2026-10-03-herdr-subagents-design.md`. Do not restart brainstorming or ask again about decisions already recorded. Surface genuine protocol constraints rather than silently relaxing requirements.

This is currently a documentation-only repository. The READMEs and skill describe the target contract, not tested executable functionality. Update their status once implementation and verification succeed. `writing-plans` was unavailable; this plan was prepared directly.

## Target package structure

```text
package.json
src/extension.ts       # pi integration: tool, session lifecycle, notifications
src/herdr.ts           # CLI transport and response validation
src/layout.ts          # live layout operations, ownership checks, serialization
src/tasks.ts           # background task lifecycle and result persistence
src/results.ts         # structured session result extraction
# Combine files if responsibilities remain small; no generic framework.
tests/                 # node tests with mocked Herdr, plus opt-in live tests
skills/pi-herdr-subagents/SKILL.md
README.md
README.pt-BR.md
docs/superpowers/specs/...
docs/superpowers/plans/...
```

Use TypeScript directly as Pi supports it. Declare `pi.extensions: ["./src/extension.ts"]`, `pi.skills: ["./skills/pi-herdr-subagents"]`, `keywords: ["pi-package"]` and only required host peer dependencies with `"*"`. Keep test/build dependencies in devDependencies. Use Node's test runner and the smallest TypeScript test setup compatible with installed Node; add deterministic `npm test` and `npm run check` scripts. Do not add a runtime framework or choose a publication license on behalf of the user.

## Model-facing contract

Use one tool named `herdr_subagent`, with a discriminated action schema:

- `spawn`: `{ action: "spawn", task: string, instructions?: string }`
- `list`: `{ action: "list" }`
- `status`: `{ action: "status", taskId: string }`
- `wait`: `{ action: "wait", taskId: string, timeoutMs?: number }` (default 120000 ms; positive bounded timeout)
- `cancel`: `{ action: "cancel", taskId: string }`

Return both readable `content` and structured data suitable for other tools; declare an output schema and `structuredContent`. Task data includes `taskId`, actual state, optional live `paneId`/agent name, and result/diagnostic information when available. `spawn` returns after local reservation, before child startup/model work completes. Do not hide a terminal-only API behind this tool.

States should distinguish starting, working, blocked, collecting, completed, failed, cancelled, and collection/cleanup failures where needed. Derive the minimal representation from tests. Closed panes are not live targets. Finished results remain consultable. No queue: reject a seventh active child. Only idle/settled state plus a correctly correlated result proves completion; `unknown` is never success.

## Step 1 — Read installed contracts and establish feasibility

Read the complete relevant installed Pi docs and examples before coding. On this machine their root is `/Users/enzo/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent`:

- `docs/extensions.md`, `docs/packages.md`, `docs/cli.md`, `docs/skills.md`.
- `docs/session-format.md`, `docs/message-types.md`, `docs/sdk.md`, `docs/tui.md` as needed for result parsing and integration.
- `examples/extensions/subagent/{README.md,index.ts,agents.ts}` and a minimal tool/message example.
- Exported declarations in `dist/core/extensions/types.d.ts` and `dist/core/session-manager.d.ts`.

Read `herdr --skill`, verify `HERDR_ENV=1`, then inspect `herdr --help`, relevant command groups, `herdr status` and `herdr api schema --json`. The installed binary is authoritative. Website references: https://herdr.dev/docs/agent-automation/, https://herdr.dev/docs/socket-api/ and https://herdr.dev/docs/integrations/.

**Feasibility checkpoint before layout implementation:** Herdr uses a BSP layout. A right split of one row is not a new full-height sibling column. Its documented `pane.move` to the same tab can be a no-op, and `layout.apply` recreates terminals. Prove how to create the fourth child's full-height column and compact arbitrary completion orders using supported commands while preserving live processes, focus and the 50/50 allocation. Do not use `layout.apply` to rebuild running agents. If this requires a temporary staging tab or a raw-socket layout operation beyond the agreed CLI surface, explain the exact minimum change and ask the user before changing topology/architecture. This is a real feasibility question, not permission to skip compaction or kill/restart workers.

Verification: record capabilities used and test the algorithm against actual schema; do not implement imaginary commands or claim mocked tests prove real protocol behavior.

## Step 2 — Package and CLI transport

1. Add manifest and development scripts with minimal dependencies.
2. Implement argument-array process execution without shell interpolation. Prefer `HERDR_BIN_PATH` with PATH fallback for this same session.
3. Parse normal JSON success, stderr JSON errors (exit 1), syntax failures (exit 2), and text output from `agent read`/`pane read`. Include bounded diagnostics.
4. Always target explicit resolved IDs/names; do not rely on the focused pane. Verify Herdr environment on each control entry point. Handle server incompatibility without upgrading/stopping it.
5. Separate turn abort signals from background task ownership. Aborting a `wait` only stops that observer. Terminating a local CLI wait is not proof that a remote mutation did not happen.

Verification: mocked CLI tests for JSON/text response shapes, malformed/error output, environment rejection, argument quoting and timeout after accepted mutation. `npm run check` passes.

## Step 3 — Layout controller with ownership checks

1. Serialize complete layout mutations and slot reservations to handle concurrent tool calls/completions.
2. Discover calling pane/tab using caller context and authoritative responses. Resolve its current ID, including moves. Before first spawn, require an unzoomed tab containing only the principal; report a helpful error for user-owned panes or incompatible layout.
3. Create children with explicit cwd and `--no-focus`. First child: 50/50 right split. Add second/third with balanced down splits. Add fourth as a second full-height column inside the child half using the proven Step 1 algorithm. Keep fifth/sixth balanced.
4. Reconcile after creation/closure and reshape for remaining counts. Root principal/child split stays at 0.5 while children exist. Exact cell rounding is allowed.
5. Track only panes actually returned by our creates; validate current occupant identity before any input or closure. Do not adopt existing panes or overwrite managed Herdr environment variables.

Verification: tests for growth 0→6, seventh spawn rejection, every deletion position and completion order, one-column compaction, zero-child restoration, geometry rounding, focus preservation, manual closure/move/replacement and mutation failure. Live tests await topology authorization as described below.

## Step 4 — Detached task lifecycle

1. On spawn, reserve capacity and persist task identity, then launch background work. Carry plain session identity, not stale context after replacement/reload.
2. Initialize a fresh pi session with inherited provider/model/thinking and optional appended specialization instructions. Pass arguments after Herdr `--`. Disable this package's delegation capability in children while keeping the Herdr lifecycle integration enabled; use a narrowly scoped child marker supplied at pane creation, not `--no-extensions` that would silently disable reporting.
3. Start a uniquely named agent and wait for readiness. Retain blocked startup panes for the user. Submit one correlated prompt with `agent prompt --wait`.
4. Follow lifecycle without an indefinite repeated polling loop. Prefer a Herdr CLI wait; use bounded retries/reconciliation when needed. Timeout/stalled delivery: inspect state and never resubmit automatically.
5. Expose list/status/wait/cancel. Track transitions and return meaningful diagnostics. A child reaching a block generates one attention message, not automatic approval.
6. Cancellation is explicit. Check occupant identity, send the documented interrupt for pi, await quiescence and collect diagnostics. If it remains busy/unknown, do not close as if safely cancelled.

Verification: two launches overlap, spawn returns before a delayed child initializes, independent principal-turn cancellation, blocked/readiness errors, delivery stall, wait timeout, explicit cancel, limit enforcement under concurrent calls, stale occupant refusal.

## Step 5 — Reliable result collection and cleanup

1. Use each fresh persisted pi session as the structured source. Get its authoritative path from Herdr or a known explicit session selection supported by Pi. Correlate to the task's user message; select the active branch using Pi SessionManager APIs where practical rather than flattening the file. Read only finalized entries.
2. Join text blocks of the final task response, preserve stopReason/error information, count child model/tool usage once, and handle partial JSONL writes safely. Do not pick an older assistant's text just because the child looks idle.
3. Persist the complete outcome before closure. Avoid writing runtime transcripts/secrets inside tracked repository files. Return a bounded model-facing summary with a durable reference to the complete result. Include child usage in session accounting once, not on each status/wait call; verify the installed Pi API for one-time attribution.
4. If structured collection fails, inspect terminal output. If completeness remains uncertain, report collection failure and preserve the pane. The documented Markdown-file fallback is for recovery, not the initial task prompt. Never treat truncated screen output as a guaranteed complete result.
5. Notify the principal via a task-tagged follow-up message, without steering. Ensure idle principal resumes and busy principal consumes the result after its current work. Avoid duplicate notifications across reload/branch changes.
6. After durable collection, close only the matching owned pane and compact survivors. Keep a clear cleanup-pending record on close/layout failure.

Verification: final response longer than viewport, multiple assistant text blocks, tree branches, tool turns, error/aborted stop reasons, missing final output, result availability after closure, save failure prevents closure, exactly-once notification/accounting, cancellation races.

## Step 6 — Persistence and extension integration

1. Reconstruct task state from the active session branch, not abandoned history; use custom entries/tool details according to installed Pi contracts.
2. On session_start/reload/retomada, reconcile agent/session identity before restarting observation. Do not start sockets/timers/processes in the extension factory.
3. On shutdown/reload/session switch, stop local observers idempotently; leave working children alive. Ignore stale callbacks to avoid sending results into another session.
4. Register only the minimal tool and compact UI status. TUI rendering is optional; non-TUI modes still report meaningful results/errors without dialogs.
5. Detect missing/outdated Herdr integration and explain remediation. Do not modify `~/.pi/agent/extensions/herdr-agent-state.ts` or personal settings automatically.

Verification: reload with active child, principal shutdown then resume, session/branch switch, stale callback suppression, already-closed pane and restarted/replaced agent, no unrelated pane closure, non-TUI loading.

## Step 7 — Documentation, skill and verification

1. Make README.md and README.pt-BR.md consistent with implemented behavior. Include requirements, Git/local install, no-remote-yet status, tool schemas, layout, timeout/block behavior, cancellation, isolation limitations and verification commands. Do not imply code is released before it works.
2. Update `skills/pi-herdr-subagents/SKILL.md` to match the actual schema. Preserve task scoping, asynchronous ownership, safe collection and conflict avoidance. Add lightweight skill examples/tests for independent investigations, a dependency requiring wait, and a blocked task; model evals are optional, not a reason to run costly unrelated batches during implementation.
3. Run `npm test`, `npm run check`, package resource discovery/load tests and `git diff --check`. Test manifest paths and skill frontmatter. Ensure the package doesn't bundle host Pi packages.
4. Test through an explicit `pi -e <package-directory>` invocation before modifying personal package settings. Check startup diagnostics and model-callable tool availability; don't make a paid model call just to validate loading.
5. Live layout/task verification must use a separate named test session, not this implementation Space or the user's original tab. The user has authorized the implementation Space, but not a separate test topology or stopping a server. Ask for that isolated live-test permission before creating it; never stop/upgrade the active Herdr server. Only clean up test panes you created, after results are captured.
6. If permission isn't available, complete deterministic tests and report live verification as outstanding, not passed. Report the Step 1 layout capability blocker honestly if still unresolved.
7. Commit small, verified changes locally when appropriate. No remote creation, push, npm publication, global integration updates or install into the user's personal Pi settings without a separate request.

## Completion report

List implementation status, test commands/results, known limitations, unresolved layout capability questions, actual install command (local until a remote exists), and any live test still requiring permission. Keep docs and skill truthful. Leave the new Space and implementation pi available for the user.
