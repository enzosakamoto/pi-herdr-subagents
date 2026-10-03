---
name: pi-herdr-subagents
description: Coordinate asynchronous pi subagents in Herdr panes with the herdr_subagent tool. Use when this package is available and the user requests parallel investigations, delegated implementation, background reviews, or management of its child tasks. Do not use for generic terminal management or when the tool is unavailable.
compatibility: Requires pi, the pi-herdr-subagents extension, Herdr, HERDR_ENV=1, and Herdr's pi lifecycle integration.
---

# Asynchronous Herdr subagents

## Availability

This skill describes the planned `herdr_subagent` contract. During bootstrap the tool may not exist yet. Check the actual available tool/schema before invoking it; if unavailable, explain that the extension must be implemented/loaded. Do not invent tool calls or silently replace delegation with raw pane automation.

The main pi must run inside Herdr. The initial tab must contain only the principal; user-owned panes are not adopted or closed. Delegate only after the user authorizes delegation, including standing authorization for autonomous work. This package's agreed workflow permits autonomous delegation when that authorization is present.

## Choose independent work

Delegate focused work with a clear deliverable: task, relevant context, permitted files, write ownership and dependencies. Send only necessary context, not the entire main conversation. Use read-only investigations when parallel writes would overlap.

Useful tasks include independent codebase investigations, focused reviews, and implementations in disjoint files. Do not dispatch tests against unfinished shared changes and present their result as a stable validation. Each child has its own conversation but the same filesystem/OS permissions; panes are not sandboxes.

## Dispatch and continue

Use the tool's actual schema. The planned interface is:

```json
{"action":"spawn","task":"Find all authentication entry points. Do not modify files. Return relevant paths, a concise flow description and actionable risks.","instructions":"Act as a focused code investigator."}
```

Save the returned `taskId`. Spawn returns immediately while startup/model work continues. Work on an independent part of the user's task instead of repeatedly checking status.

Use the following actions when needed:

```json
{"action":"list"}
{"action":"status","taskId":"RETURNED_TASK_ID"}
{"action":"wait","taskId":"RETURNED_TASK_ID","timeoutMs":120000}
{"action":"cancel","taskId":"RETURNED_TASK_ID"}
```

Use `wait` at a real dependency boundary, or when there is no other useful work. Interrupting a wait or the principal's turn does not cancel the child. Use `cancel` for deliberate cancellation, not as routine completion cleanup.

## Completion and attention

Completion arrives as a task-tagged follow-up, without steering current work. Review the collected result and any diagnostics before incorporating findings. Results remain available after automatic pane closure; consult task status/result rather than addressing a closed pane.

- A wait timeout does not prove the prompt was undelivered. Inspect task state; do not spawn a duplicate blindly.
- `blocked` means an approval/question needs attention. Inform the user and keep the pane available. Do not answer approvals automatically.
- `idle`/`done` means available, not necessarily successful. `unknown` is not completion.
- Collection failure retains the pane to avoid discarding the response. Report the issue and follow the tool's recovery instructions; do not close it manually.
- If an occupant changes, do not send input to that pane as though it were still your child.

The extension owns lifecycle and cleanup. Do not race it with raw Herdr commands or close unrelated panes. If the user explicitly asks for manual Herdr control, first read the Herdr skill (`herdr --skill`) and follow its context/identity checks.

## Capacity and layout

There are at most six active children, no implicit queue and no recursive delegation. If all slots are occupied, continue independent work or wait for an existing task. Do not create a seventh agent by bypassing the tool.

The principal keeps the left half. Children share the right half: one column for up to three, two columns for four to six, at most three rows per column. Focus stays with the user. Results are persisted before owned panes close and the layout compacts.

## Examples

**Independent investigation:** launch a read-only authentication investigator and a read-only data-model investigator, then implement an unrelated API change. Combine their results once delivered.

**Dependency:** launch tests owned by a child only after the input code is stable; work on documentation, then wait for the test task before claiming verification passed.

**Blocked child:** tell the user which task needs a decision. Continue safe independent work. Do not approve, cancel or duplicate the blocked task unless directed.

## Report

Summarize each delegated task's outcome, actionable findings, changed files when relevant, and any unverified or blocked work. Treat results as evidence to evaluate, not as an automatic guarantee of correctness.
