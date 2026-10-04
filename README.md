# pi-herdr-subagents

[Português (Brasil)](README.pt-BR.md)

Asynchronous pi subagents, visibly running in Herdr terminal panes. Delegate independent work, keep working while fresh pi sessions run in parallel, and receive each result as a follow-up in the principal session.

![Demo](./assets/demo.gif)

## Quick start

Requirements: pi, a compatible Herdr server/CLI, the pi lifecycle integration, and model credentials available to child sessions. The tested versions and operational constraints are listed below.

Try from a local checkout without saving personal settings:

```bash
pi -e /absolute/path/to/pi-herdr-subagents
```

In pi, delegate an independent task, for example: “Inspect the authentication flow. Do not modify files; report relevant paths and risks.” The child opens in a Herdr pane; the principal can continue working and receives a tagged follow-up when the result is ready. For model configuration, recovery behavior, and test instructions, use the sections below.

## Contents

- [Behavior and limits](#behavior-and-limits)
- [Requirements and installation](#requirements-and-installation)
- [Tool: `herdr_subagent`](#tool-herdr_subagent)
- [Model tiers and configuration](#model-tiers-and-configuration)
- [Persistence and recovery](#persistence-and-recovery)
- [Verification](#verification)

## Behavior and limits

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
- The tab must not be zoomed. Existing user panes are allowed; they are never adopted, moved or closed.
- Layout proportions use only the invoking principal pane's available region, not the whole tab.
- With 1–3 children: principal left 50% of that region, one child column right 50%.
- With 4–6: principal left 50%, two child columns of 25%, at most three balanced rows each.
- After completion: persist the full result, deliver a task-tagged **follow-up**, then close
  only the matching owned pane and compact survivors. With no children, restore the principal
  to the whole local region, leaving external panes intact.
- A result queued behind busy principal work is not delivery: its pane stays until the
  follow-up is actually admitted to the principal transcript.
- Blocked/uncertain results stay visible. No approvals are sent automatically.

Principal and children must remain in a dedicated BSP subtree. External panes outside it
are allowed, including panes added later. If a user pane is inserted inside the owned subtree
or a child is relocated outside it, layout control stops for reconciliation rather than
reorganizing user work. Pre-existing panes, even empty shells, are not reused automatically.
Relative splits follow the current window/region size; dimensions are not frozen at first spawn.

### Authorized BSP adaptation

Layout changes use **same-tab auxiliary shells and explicit swaps**. Live children keep
their pane, terminal, agent and session identities. No staging tabs, cross-tab moves,
`layout.apply`, terminal recreation or worker restart. Auxiliary shells are not tasks
and never receive pi launches or prompts; only proven owned shells are closed.
Foreground shell PID/name/arguments are checked; unrecognized custom shells require
intervention rather than being treated as safely idle. Short-lived foreground jobs or
unavailable process metadata receive bounded waits; explicit identity changes still stop
control. `status`/reload remove missing unstarted reservation links only after a definitive
`pane_not_found`, without adopting replacements or physically closing other panes.

Geometry is transitional: the principal/new grid temporarily share the principal leaf
before recovering their settled local 50/50 region. Preflight requires **3×3 cells per
owned pane at every step**, including temporary slots. Enlarge the region if it fails;
there is no staging fallback.

Herdr 0.9.3 swaps **temporarily focus the surviving source child**. Initial focus is
restored when its occupant remains valid and the current selection still matches an
extension-caused effect. Observed external focus changes pause further mutations; no
atomic focus guarantee is possible. Selected completed children fall back to the principal.

A private, versioned transaction journal and branch entries support safe recovery.
`status` reconciles proven state without relaunching agents or resending prompts.
Unknown split IDs, unproven swap outcomes, changed occupants/topology and foreign branch
journals are not adopted or blindly retried. Unstarted owned shell reservations can be
cancelled explicitly. Legacy cross-tab children require manual reconciliation; existing
`hs-staging` tabs/plugin sidebars are never automatically cleaned up.
This same-tab implementation has deterministic tests, **not new live validation**.

## Requirements and installation

| Component | Requirement / tested version |
|---|---|
| pi | Installed extension and structured-tool contracts; tested with 1.0.0 |
| Herdr server/CLI | Compatible version; tested with 0.9.3 (protocol 22) |
| Lifecycle integration | Working pi integration; tested with v9 (`herdr integration status`) |
| Runtime for development tests | Node 24+ and npm |

Additional operating constraints: run the principal inside Herdr (`HERDR_ENV=1` with a managed caller pane), and provide model credentials usable by child pi processes. Sessions are separate, but **files, credentials, and OS permissions are shared**; assign disjoint write ownership. The tab must not be zoomed; existing user panes are permitted outside the principal/children subtree. See [Behavior and limits](#behavior-and-limits).
The lifecycle integration is installed/updated separately; this package never changes `herdr-agent-state.ts` or your settings.

Try without saving personal settings:

```bash
pi -e /absolute/path/to/pi-herdr-subagents
```

To install deliberately:

```bash
pi install /absolute/path/to/pi-herdr-subagents
# Then /reload in pi.
```

Install from the GitHub repository with:

```bash
pi install git:github.com/enzosakamoto/pi-herdr-subagents
# Then /reload in pi.
```

This package is not published on npm.

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

See the [verification report](docs/superpowers/plans/2026-10-03-verification.md) for coverage and limitations.

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
[Local-region layout coverage](docs/superpowers/plans/2026-10-03-principal-region-layout-verification.md)
includes external panes in all directions, the eight-pane reference layout, resizing,
external/child focus and historical staging recovery.
[Same-tab coverage](docs/superpowers/plans/2026-10-03-same-tab-layout-verification.md)
adds durable recovery at every mutation, lost responses, minimum geometry, focus changes,
plugin hooks and branch provenance. Same-tab splits/swaps/process continuity still require
separately authorized live validation in an isolated environment.
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

[Principal-region layout specification](docs/superpowers/specs/2026-10-03-principal-region-layout-design.md) ·
[Thinking specification](docs/superpowers/specs/2026-10-03-tier-thinking-design.md) ·
[Model-tier specification](docs/superpowers/specs/2026-10-03-model-tiers-design.md) ·
[Specification](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md) ·
[Plan](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md) ·
[Historical BSP checkpoint](docs/superpowers/plans/2026-10-03-layout-checkpoint.md)
