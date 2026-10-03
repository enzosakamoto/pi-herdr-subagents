# pi-herdr-subagents

[Português (Brasil)](README.pt-BR.md)

Asynchronous pi subagents, visibly running in Herdr terminal panes.

**Status: implemented MVP, verified with pi 1.0.0 and Herdr 0.9.3 (protocol 22).**
Local-only repository: no remote, npm publication or automatic personal installation.
See the [verification report](docs/superpowers/plans/2026-10-03-verification.md) for coverage and limitations.

## Behavior

The principal reserves a task and continues working while a fresh pi TUI child starts.
Children inherit the selected model/thinking level, receive only the supplied task/context,
and cannot invoke this package's delegation tool. Optional specialization is appended to
their system prompt.

- Six reserved/active children maximum; no capacity queue or recursive delegation.
- Same cwd and final tab as the principal.
- Initially the tab must contain only the principal and must not be zoomed.
- With 1–3 children: principal left 50%, one child column right 50%.
- With 4–6: principal left 50%, two child columns of 25%, at most three balanced rows each.
- After completion: persist the full result, deliver a task-tagged **follow-up**, then close
  only the matching owned pane and compact survivors. With no children, restore the principal.
- A result queued behind busy principal work is not delivery: its pane stays until the
  follow-up is actually admitted to the principal transcript.
- Blocked/uncertain results stay visible. No approvals are sent automatically.

### Authorized BSP adaptation

Herdr cannot reparent a pane within its own tab. Layout changes use a temporary
`hs-staging` tab **in the same workspace**, moving the same live terminals out and back
with `--no-focus`. No `layout.apply`, terminal recreation or worker restart.
Staging tabs disappear when empty. Geometry is temporarily transitional during mutations.
Final geometry/process continuity and principal/selected-child focus were tested live.
A selected surviving child is restored if focus fell back to the principal; if the user
selected another pane/tab/workspace during the mutation, the extension does not steal it.

## Requirements and installation

- pi with the installed extension/structured-tool contracts (tested: 1.0.0).
- Compatible Herdr server/CLI (tested: 0.9.3, protocol 22).
- Principal inside Herdr: `HERDR_ENV=1` and a managed caller pane.
- Working Herdr pi lifecycle integration; tested with v9. Check with
  `herdr integration status`. Install/update separately if needed; this package never
  changes `herdr-agent-state.ts` or your settings.
- Model credentials usable by child pi sessions. Conversations are isolated, **files,
  credentials and OS permissions are not**. Assign disjoint write ownership.

Try without saving personal settings:

```bash
pi -e /absolute/path/to/pi-herdr-subagents
```

To install deliberately:

```bash
pi install /absolute/path/to/pi-herdr-subagents
# Then /reload in pi.
```

After creating your own remote (none exists here), Git installation uses
`pi install git:github.com/OWNER/pi-herdr-subagents`; replace OWNER with a real repository.
No npm license/publication decision is made by this package.

## Tool: herdr_subagent

Arguments are model tool calls, not shell commands:

```json
{"action":"spawn","task":"Map authentication entry points. Do not modify files. Return relevant paths and risks.","instructions":"Act as a focused code investigator."}
{"action":"list"}
{"action":"status","taskId":"RETURNED_TASK_ID"}
{"action":"wait","taskId":"RETURNED_TASK_ID","timeoutMs":120000}
{"action":"cancel","taskId":"RETURNED_TASK_ID"}
```

`spawn` returns after durable reservation, before startup/model completion; the initial
response may have no pane ID yet. Use the returned taskId. `instructions` is optional.
`wait` defaults to 120000 ms; allowed range is 1–3600000. Timeout/observer abort does
not cancel a child, imply failed delivery, or cause a prompt resend.

Responses have readable `content`, `details` and schema-validated `structuredContent`.
States: `starting`, `working`, `blocked`, `collecting`, `completed`, `failed`,
`cancelled`, `collection_failed`, `cleanup_pending`.
Task results expose bounded text (12000 characters), stop reason, usage, diagnostics
and a `resultPath` for the complete JSON outcome. Finished results remain consultable.
`list` is local; `status` reconciles live identity and may finish collection, resume
one **never-submitted** task after a startup block is cleared, or retry pending cleanup.

Explicit cancellation sends pi's Escape and waits for quiescence. Busy/unknown
cancellation is not proof of safe closure. `idle`/`done` alone is not success.

Load the bundled guidance with `/skill:pi-herdr-subagents`.

## Persistence and recovery

Task state is persisted in custom entries on the principal's active session branch and
private runtime files under `<pi-agent-dir>/herdr-subagents/<principal-session-id>/`.
Child sessions and complete `result.json` files are outside the repository. The child
extension records its authoritative session path/active leaf at `agent_settled`;
collection follows that branch and correlates the unique task user message. Terminal
screens are diagnostics, never a substitute for guaranteed full output.

Shutdown/reload stops local observers, not children. Resume validates terminal, agent
name and session identity before control; it never starts another worker or resends an
attempted prompt. A launch interrupted before its handshake requires intervention.
Pane moves/replacements are refused, not adopted. Forks/copied history do not adopt
another principal session\'s tasks; consult their durable references or resume the original.
Use only one principal per pi session. Lost panes are diagnosed on lifecycle
reconciliation, `status` or resume; there is no perpetual remote polling loop.

Follow-ups are deduplicated using persisted branch messages and task tags; stale/duplicate
outbox content is filtered from model context. Abrupt crashes/branch changes can leave a
queued notification unacknowledged; durable results are recovered rather than discarded.
Detached usage is attributed once to the **next principal tool result** (the public
ExtensionAPI has no appendUsage); totals can lag until that tool result. Provider/model
buckets are retained where known; unattributed nested usage is explicitly marked unknown.

A layout/close failure preserves the result and a cleanup-pending record. `status` or
resume can reconcile owned survivors. Never repair by killing/restarting workers or
closing user panes. Do not race the extension with raw pane control.

## Verification

Development requires Node 24+ (native TypeScript tests) and npm:

```bash
npm ci
npm test
npm run check
git diff --check
```

Thirty-five deterministic tests include all 720 deletion orders, independent observers,
capacity, blocked/startup/cancellation failures, active branches, full responses,
follow-up admission, exactly-once accounting, resource discovery and tool schemas.

Opt-in live tests require an **already running isolated named Herdr test server**.
They never start/stop/upgrade a server or use the implementation/reference tabs:

```bash
HERDR_LIVE_TEST=1 HERDR_TEST_SESSION=your-test-session npm run test:live
HERDR_LIVE_TEST=1 HERDR_TEST_SESSION=your-test-session npm run test:live-tasks
HERDR_LIVE_TEST=1 HERDR_TEST_SESSION=your-test-session npm run test:live-extension
```

The latter two make model calls. Test workspaces are owned/cleaned by the test; failed
runs retain panes/evidence for diagnosis. Live layout, two child TUI tasks, explicit Escape cancellation and a real
principal receiving follow-ups/accounting passed. Reload/branch/block edge cases
have deterministic coverage, not a claim of exhaustive live fault-injection coverage.

[Specification](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md) ·
[Plan](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md) ·
[Historical BSP checkpoint](docs/superpowers/plans/2026-10-03-layout-checkpoint.md)
