# pi-herdr-subagents

[Português (Brasil)](README.pt-BR.md)

Asynchronous pi subagents, visibly running in Herdr terminal panes.

**Status: implemented MVP, verified with pi 1.0.0 and Herdr 0.9.3 (protocol 22).**
Local-only repository: no remote, npm publication or automatic personal installation.
See the [verification report](docs/superpowers/plans/2026-10-03-verification.md) for coverage and limitations.

## Behavior

The principal reserves a task and continues working while a fresh pi TUI child starts.
Children use a configured model tier, an explicit model override, or inherit the principal's
model when no mappings exist. Thinking can be configured per tier or inherited from the
principal, subject to pi/model support.
Children receive only the supplied task/context and cannot invoke this package's delegation
tool. Optional specialization is appended to their system prompt.

The principal may delegate independent work autonomously without an explicit request for
subagents. User restrictions and approval boundaries still apply. Avoid delegation overhead
for trivial or strictly sequential work.

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
{"action":"spawn","tier":"medium","task":"Map authentication entry points. Do not modify files. Return relevant paths and risks.","instructions":"Act as a focused code investigator."}
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

## Model tiers and configuration

Create configuration deliberately, globally at `<pi-agent-dir>/herdr-subagents.json`
(normally `~/.pi/agent/herdr-subagents.json`, respecting `PI_CODING_AGENT_DIR`) and/or in
`<cwd>/.pi/herdr-subagents.json`. This package does not create these files automatically
or modify pi's `settings.json`.

```json
{
  "defaultTier": "medium",
  "models": {
    "low": { "model": "provider/fast-model", "thinking": null },
    "medium": { "model": "provider/general-model", "thinking": "medium" },
    "high": { "model": "provider/deep-model", "thinking": "high" }
  }
}
```

These are illustrative IDs: replace them with exact `provider/model-id` chat model IDs
configured in pi. The principal selects a tier based on the task; code resolves the model.
Tiers are user-defined profiles, not guaranteed prices or speeds.

| Tier | Examples |
|---|---|
| `low` | Execute a defined test suite and report results; locate references; check imports/formatting. |
| `medium` | Map and understand a use-case flow; implement a bounded change; diagnose ordinary test failures. |
| `high` | Deep review of a newly implemented class for logic errors, invariants and edge cases; concurrency/security analysis; difficult bugs. |

Choose the lowest adequate tier. Running tests is low; diagnosing their failures may need
medium or high. File size, test duration or calling something a review do not alone justify
high. Do trivial checks directly rather than spawning a child. There is no automatic
escalation or rerun on a more expensive model. See the skill for detailed examples.

Resolution rules:

1. Optional `model` on spawn selects an exact model when requested by the user; it is
   mutually exclusive with `tier`. Do not invent model IDs or prices autonomously.
2. Otherwise, select `tier` or the effective `defaultTier` (implicitly `medium`).
3. Project configuration overrides global configuration **per tier** and for defaultTier.
   Each project tier replaces the entire global entry, including thinking; no nested merge.
4. With no model mappings (including empty configuration), inherit the current principal
   model, even when tier is provided. **Choosing low alone does not reduce cost.**
5. With any mappings, a missing selected tier is an error, not an implicit fallback.

For a user-requested exact override:

```json
{"action":"spawn","model":"provider/model-id","task":"Perform the requested read-only investigation."}
```

Files are read on every spawn. Invalid/unreadable configuration, unknown fields/tiers,
invalid IDs and unknown chat models fail before task reservation or pane creation, including
when model is explicit. A configured/explicit model can be used without a principal model;
inheritance requires one. Providers, models and credentials must also be available in the
child process; principal-only in-memory registrations/credentials are not transferred.
Startup/authentication failures never trigger a model substitution. Because pi's CLI can
fuzzy-match models, new tasks also verify the child's actual model in its startup handshake
before sending the task. A mismatch/missing model retains the pane with a diagnostic and
sends no task; do not bypass it by manually prompting the child. Legacy tasks without
modelSource retain their original handshake contract. This check is not a lock against
manual model changes after startup.

`spawn`, `list`, `status`, `wait` and follow-ups expose the selected `model`, `tier` (unless
model was explicit), `modelSource` (`explicit`, `tier` or `inherited`) and requested `thinking`. Legacy records
may lack these fields. Selection is persisted at reservation: concurrent calls, reloads
and subsequent configuration changes do not change existing tasks. The selected startup
model is distinct from actual provider/model usage accounting.

### Thinking per tier

Each models entry accepts either the legacy model string or an object with mandatory `model`
and optional `thinking`. You can mix the formats; no migration is required.

- `thinking: null` means **off**, the same as `thinking: "off"`.
- Omitted thinking (including legacy strings) inherits the principal's current level;
  without a principal level, it requests off.
- Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `null`.
- Unknown values/fields or objects without a valid model fail before reservation/pane creation.
- A project entry omitting thinking does not retain global thinking for that tier: it inherits
  the principal instead. Explicit `model` on spawn also inherits the principal and ignores
  tier thinking, even when the model matches a configured tier.

Tier names describe task categories, **not literal thinking levels**. The example requests
off for simple evidence collection, medium for general tasks and high for deep analysis;
adjust to model support and your cost preferences. There is no thinking argument on spawn.

The resolved requested thinking is persisted at reservation, passed as `--thinking` and
exposed as `thinking` in results/status/follow-ups. pi/provider may adjust it to the levels
supported by the model; this field is **not a guarantee of the effective level**. In particular,
null/off cannot force reasoning off on a model that does not support disabling it. No
extension-side clamping or thinking-based startup rejection is added.

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

Deterministic tests include all 720 deletion orders, independent observers,
capacity, blocked/startup/cancellation failures, active branches, full responses,
follow-up admission, exactly-once accounting, resource discovery and tool schemas.
Model-tier/thinking coverage includes config precedence/validation, null/off/omission,
concurrent selections, legacy records and reloads, with temporary files and fake Herdr/model registries. Tier changes
have no new live-model verification; textual guidance checks are not LLM behavioral evals.

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

[Thinking specification](docs/superpowers/specs/2026-10-03-tier-thinking-design.md) ·
[Model-tier specification](docs/superpowers/specs/2026-10-03-model-tiers-design.md) ·
[Specification](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md) ·
[Plan](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md) ·
[Historical BSP checkpoint](docs/superpowers/plans/2026-10-03-layout-checkpoint.md)
