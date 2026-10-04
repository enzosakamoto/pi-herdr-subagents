---
name: pi-herdr-subagents
description: Autonomously coordinate asynchronous pi subagents in Herdr panes with herdr_subagent. Use when a task benefits from independent investigations, focused reviews, disjoint-file implementation, or background validation, even without an explicit request for subagents. Also use to manage existing child tasks and choose economical low/medium/high model tiers. Respect user restrictions; avoid delegation for trivial or strictly sequential work. Do not use for generic terminal management or when the tool is unavailable.
compatibility: Requires pi, the pi-herdr-subagents extension, Herdr, HERDR_ENV=1, and Herdr's pi lifecycle integration.
---

# Asynchronous Herdr subagents

## Availability

This package implements `herdr_subagent` with actions spawn/list/status/wait/cancel. Check the actual available tool/schema before invoking it; if unavailable, explain that the package must be loaded (for example with `pi -e /path/to/pi-herdr-subagents`). Do not invent tool calls or silently replace delegation with raw pane automation.

The main pi must run inside Herdr, in an unzoomed tab. Existing user-owned panes are allowed and are never adopted, moved or closed. Layout uses only the invoking principal pane's available region, not the whole tab. Delegate autonomously when independent work benefits the user's task; no explicit subagent request or prior general delegation authorization is required. Respect user restrictions and approval boundaries: delegation does not expand the requested scope or authorize otherwise restricted actions. Discussing subagents or editing this package is not itself a reason to spawn children.

## Choose independent work

Delegate focused work with a clear deliverable: task, relevant context, permitted files, write ownership and dependencies. Send only necessary context, not the entire main conversation. Use read-only investigations when parallel writes would overlap.

Useful tasks include independent codebase investigations, focused reviews, and implementations in disjoint files. Do not dispatch tests against unfinished shared changes and present their result as a stable validation. Each child has its own conversation but the same filesystem/OS permissions; panes are not sandboxes.

## Choose an economical model tier

Choose the lowest adequate `tier`; the extension resolves it to a user-configured model. These are user-defined profiles, not verified prices, speed guarantees or thinking levels. Do not infer model IDs or prices.

| Tier | Use for | Keep the scope bounded |
|---|---|---|
| `low` | Run a defined test suite and report results; locate references; collect logs; check mechanical changes. | Collect evidence or execute clear steps, not open-ended diagnosis or unsolicited fixes. |
| `medium` | Map and understand a use-case flow from entry point to persistence; explain dependencies/business rules; implement a bounded change; diagnose ordinary failures. | General-purpose default, including when there is no evidence of high complexity. |
| `high` | Deep correctness review of a newly implemented class for logic, invariants and edge cases; concurrency/security analysis; difficult bugs or consequential architectural trade-offs. | Require depth or meaningful risk, not just a large file or the word review. |

Examples and contrasts:

- **Run tests and report results — low:** “Run npm test and summarize failures.” Start only once the code under test is stable. Long test duration does not justify high.
- **Understand a use-case flow — medium:** “Map and explain order creation from its API entry to persistence.”
- **Review a newly implemented class — high:** “Review this class for logic errors, invariants and edge cases.” Report findings; do not implement fixes unless requested.
- **Formatting/import review — low:** “Check names, imports and formatting.” Do it directly in the principal if trivial.
- **Diagnose test failures — medium:** distinct from merely running tests; choose high only when the task actually requires difficult analysis such as race conditions.

Do not delegate trivial/sequential work just to use a cheaper tier, duplicate investigations without purpose, or fill all six slots by default. Never automatically escalate or rerun failed/incomplete work on a more expensive model. Evaluate the evidence and the user's scope before deciding a next step.

### Configuration and fallback

Configuration lives in `<pi-agent-dir>/herdr-subagents.json` (normally `~/.pi/agent/herdr-subagents.json`) and `<cwd>/.pi/herdr-subagents.json`. Project entries replace the entire global entry per tier (model and thinking, no nested merge); project defaultTier overrides global defaultTier. Files are read on each spawn. Do not write personal configuration or change configured models without a user request.

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

Replace these illustrative IDs with exact chat model IDs configured in pi and accessible to child processes. The principal chooses a tier, not an arbitrary model. Use `model: "provider/model-id"` only for a specific model requested by the user; `model` and `tier` are mutually exclusive.

Without tier, use configured defaultTier (otherwise medium). Without any model mappings, inherit the principal model even if tier is specified: **low alone does not make the child cheaper**. If mappings exist but the chosen tier is missing, report the error; do not silently switch tier/model. Invalid configuration or unknown models fail before reserving/opening a pane. No automatic model fallback is performed after startup/authentication failures. New tasks verify the child's actual startup model before submission; a missing/mismatched handshake model retains the pane without sending work. Report the diagnostic rather than bypassing this check with manual prompts.

The result/status includes `model`, `tier` (unless model was explicit), `modelSource` (`explicit`, `tier` or `inherited`) and requested `thinking`. Check these before claiming a cheaper model was used. Model and requested thinking are frozen at reservation; config changes affect only future tasks. Credentials/providers registered only in the principal's memory may not be available in the child.

### Nullable thinking

Model entries may be legacy strings or objects with mandatory `model` and optional `thinking`; formats can be mixed. **thinking null means off**, exactly like the string `"off"`. Omitted thinking (including legacy strings) inherits the principal's snapshot, or requests off if no principal level is available. Do not treat null as inheritance.

Valid thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `null`. A project tier object omitting thinking replaces global thinking, so it inherits the principal rather than the global profile. An explicit model on spawn also inherits the principal and ignores all tier thinking. There is no thinking argument on spawn; do not change the user's profiles to increase reasoning without a request.

Tier labels describe task categories, not literal reasoning levels. For cost-conscious profiles, the example requests off for running tests/reporting, medium for understanding flows and high for deep analysis. pi/provider may adjust requested thinking to model support: `thinking` in status is the requested startup level, **not proof of the effective level**. In particular, null/off cannot force reasoning off on a model that does not support disabling it. The extension does not clamp thinking or reject startup based on it.

## Dispatch and continue

Use the tool's actual schema. The implemented interface is:

```json
{"action":"spawn","tier":"medium","task":"Find all authentication entry points. Do not modify files. Return relevant paths, a concise flow description and actionable risks.","instructions":"Act as a focused code investigator."}
```

Save the returned `taskId`. Spawn returns after durable reservation while startup/model work continues; a live paneId may not exist yet. `instructions` is optional system specialization, not a substitute for the task; wait defaults to 120000 ms and permits 1–3600000 ms. Work on an independent part of the user's task instead of repeatedly checking status.

Use the following actions when needed:

```json
{"action":"list"}
{"action":"status","taskId":"RETURNED_TASK_ID"}
{"action":"wait","taskId":"RETURNED_TASK_ID","timeoutMs":120000}
{"action":"cancel","taskId":"RETURNED_TASK_ID"}
```

Use `wait` at a real dependency boundary, or when there is no other useful work. Interrupting a wait or the principal's turn does not cancel the child. Use `cancel` for deliberate cancellation, not as routine completion cleanup.

## Completion and attention

Completion arrives as a task-tagged follow-up, without steering current work. A queued result keeps its pane until the follow-up enters the principal transcript. Tool summaries are bounded to 12000 characters; read `resultPath` for the complete JSON outcome. Detached usage is attributed once to the next principal tool result. Review the collected result and any diagnostics before incorporating findings. Results remain available after automatic pane closure; consult task status/result rather than addressing a closed pane.

- A wait timeout does not prove the prompt was undelivered. Inspect task state; do not spawn a duplicate blindly.
- `blocked` means an approval/question needs attention. Inform the user and keep the pane available. Do not answer approvals automatically. After the user clears a startup block, `status` can initiate the one task that was never submitted; it never resends an attempted prompt.
- `idle`/`done` means available, not necessarily successful. `unknown` is not completion.
- Collection failure retains the pane to avoid discarding the response. Report the issue and follow the tool's recovery instructions; do not close it manually.
- `cleanup_pending` preserves the result; `status` or resume may reconcile safe owned cleanup. Do not kill/restart workers to make the layout look correct.
- If an occupant changes, do not send input to that pane as though it were still your child.

The extension owns lifecycle and cleanup. Do not race it with raw Herdr commands or close unrelated panes. If the user explicitly asks for manual Herdr control, first read the Herdr skill (`herdr --skill`) and follow its context/identity checks.

## Capacity and layout

There are at most six active children, no implicit queue and no recursive delegation. If all slots are occupied, continue independent work or wait for an existing task. Do not create a seventh agent by bypassing the tool.

The principal keeps the left half of its local region in the settled layout. Children share the right half of that region: one column for up to three, two columns for four to six, at most three rows per column. When all children close, the principal recovers the whole local region; external panes stay intact. Relative splits follow the current region/window size. Do not reuse pre-existing shells or reference panes as children. Principal and children must form a dedicated BSP subtree; a user pane inserted inside it or a child moved outside it requires reconciliation before layout control can continue. Reassembly uses owned auxiliary shells and explicit swaps in the same tab, without creating staging tabs, moving across tabs or restarting workers. Auxiliary shells are not tasks and receive no pi launches/prompts. Preflight requires at least 3×3 cells per owned pane throughout the transition; enlarge the region instead of using staging. Native Herdr 0.9.3 swaps temporarily focus a surviving source child; the extension restores initial focus only when its identity and the last extension-caused selection remain valid. Observed external focus changes pause mutations; no atomic focus guarantee exists. A durable branch/session-bound journal supports status recovery without blind swap retries or adoption of unknown split results. Cancel unstarted owned shell reservations explicitly. Legacy cross-tab children require manual reconciliation; never manipulate old `hs-staging` tabs/plugin sidebars for this extension. Results are persisted and delivered before owned panes close and the layout compacts. Panes moved/replaced externally require reconciliation, not adoption.

## Examples

**Independent investigation:** launch a read-only authentication investigator and a read-only data-model investigator, then work on an independent API change within the user's request. Combine their results once delivered.

**Dependency:** launch tests owned by a child only after the input code is stable; work on documentation, then wait for the test task before claiming verification passed.

**Blocked child:** tell the user which task needs a decision. Continue safe independent work. Do not approve, cancel or duplicate the blocked task unless directed.

## Report

Summarize each delegated task's outcome, actionable findings, changed files when relevant, and any unverified or blocked work. Treat results as evidence to evaluate, not as an automatic guarantee of correctness.
