# Incremental Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the user's incremental 1–6 layout and local cleanup without swaps, auxiliary panes or staging.

**Architecture:** Read permitted column topologies from the live BSP snapshot. A pure planner projects one new split plus native ratio adjustments, or ratio-only compaction. A v2 journal validates deterministic replay and protects ownership/recovery; the controller retains task/launch/foreground safeguards. Exact ratio changes use a narrowly scoped, session-bound socket operation.

**Tech Stack:** TypeScript on Node 24, node:test, Herdr 0.9.3 CLI and JSON-lines Unix socket API, pi extension lifecycle and branch entries.

---

Approved specification: `docs/superpowers/specs/2026-10-04-incremental-layout-design.md`.
Baseline: 100 tests pass and `npm run check` passes. Executed in this session with a disjoint-file transport worker and an independent correctness review; no changes to user panes.

**Completed:** 123 tests pass with `PI_HERDR_SUBAGENT` unset, TypeScript and diff checks pass. Isolated live verification covered 11 births, 22 geometry/focus checkpoints and 11 closes without swaps/auxiliary panes. The owned test server/workspaces were cleaned up. See `2026-10-04-incremental-layout-verification.md` for evidence and limits.

### Task 1: Session-bound ratio transport

**Files:** `src/herdr.ts`, `tests/herdr.test.ts` (delegated ownership).

- [x] Add a native, narrow control method:

```ts
setSplitRatio(tabId: string, path: boolean[], ratio: number, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>>;
```

Its JSON-lines request is `{ id, method: "layout.set_split_ratio", params: { tab_id: tabId, path, ratio } }`. Require `HERDR_ENV=1` and a socket endpoint, preserve response-ID matching, server rejection, bounded output and timeout/abort uncertainty. A prefixed CLI used for isolated sessions requires an explicit socket constructor argument; never inherit the user's socket for a different selected session.

- [x] Use temporary Unix socket servers in tests for successful framing, rejection, malformed/lost response, timeout/abort and explicit endpoint isolation. Run `node --test tests/herdr.test.ts`; expect all transport tests to pass.

### Task 2: Pure incremental planner and geometry regression

**Files:** `src/layout-geometry.ts`, new `tests/incremental-geometry.test.ts`, `tests/fake.ts`.

- [x] Add tests that project the initial birth sequence and verify columns:

```ts
assert.deepEqual(columns.map(c => c.ids), [["1", "3", "5"], ["2", "4", "6"]]);
```

Also assert one split per addition, a maximum of three rows/column, original leaf identities, balanced row heights, and ratio-only cleanup.

- [x] Implement subtree paths, ratio replacement and recognition of the two allowed two-column forms: principal / (left-column / right-column), and (principal / left-column) / right-column. A lone column is principal / column. Column internals contain only down splits. Reject duplicate/missing/external leaves and any other shape.
- [x] Derive a deterministic plan from the initial tree and mode (`add` or `compact`). Choose the shorter column, tie left; append below its bottom leaf. For a lone stack of 2–3, set its enclosing ratio to .75 then split principal in 2/3. For compact, balance ratios by descendant row counts and normalize horizontal ratios to .5 or .75 and 2/3.
- [x] Preflight every projected operation with the existing f32 geometry and minimum 3×3 check. The new-pane placeholder is internal planning data, never proof of a real pane identity.
- [x] Add `Fake.setSplitRatio` applying the requested explicit path, recording a mutation and supporting before/after fault injection. Run `node --test tests/incremental-geometry.test.ts`; expect planner regressions to pass.

### Task 3: Versioned journal and incremental controller

**Files:** `src/layout-state.ts`, `src/layout.ts`, necessary integration in `src/tasks.ts`/`src/extension.ts`; `tests/same-tab-layout.test.ts`, `tests/same-tab-tasks.test.ts`.

- [x] Replace the v1 slot/reconstruction journal for new operations with v2: owner, principal, task IDs, workers, mode, base tree, current tree, new reserve, phase and before/after intent. Preserve externally consumed `reservedPane`, `reservedTaskId`, `state`, `recover`, `add`, `compact` and `close` interfaces.
- [x] Validate by recomputing and replaying the plan from the base tree. Accept only the split-returned new reserve, tied to the new task; reject persisted arbitrary commands/foreign panes. Keep v1 pending records fail-closed and preserved for manual reconciliation.
- [x] Execute serially: proof → preflight → durable intent → reproof → split/ratio → durable identity → confirm. Apply no-focus to splits; validate a live split target without requiring it to be a shell. Await proven shell foreground only for the newborn reservation before launch.
- [x] Keep uncertain split IDs blocked; confirm uncertain ratio changes only from exact before/after trees; retry only proven rejection. Reinvoke the ownership callback safely for recovery if durable identity exists but task attachment was interrupted.
- [x] Close only the completed child after the existing task gates. Persist close intent and retain the task cleanup recovery path for a lost acknowledgement. Compact only surviving ratios; retain result and pending journal on failure.
- [x] Test accepted/rejected/lost split and ratio replies, persistence failure, malformed branch state, focus changes, shell readiness and legacy refusal. Run `node --test tests/same-tab-layout.test.ts tests/same-tab-tasks.test.ts`; expect no forbidden operations.

### Task 4: Lifecycle and full regression

**Files:** `tests/layout.test.ts`, `tests/tasks.test.ts`, `tests/region-tasks.test.ts`, `tests/shell-startup.test.ts`, `tests/extension.test.ts`, other tests whose old expectations encode reconstruction.

- [x] Replace count-based column expectations with actual permitted topology. Assert zero swaps/moves/staging/auxiliary shells, one split per spawn and preserved order within each column.
- [x] Exercise all 720 close permutations, mixed birth/close histories, left/right column exhaustion and reopening with 2–3 survivors. Assert external pane IDs/rectangles are unaffected and final zero-child region is restored.
- [x] Retain deferred notification, one-time usage accounting, branch/disk provenance, idempotent launch and foreground reconciliation tests. Faults formerly injected at obsolete swaps must be replaced with the corresponding incremental split/ratio failure, not dropped without replacement.
- [x] Run `npm test` and `npm run check`; expect all tests and TypeScript to pass.

### Task 5: Isolated live verification and documentation

**Files:** `tests/live.ts`, live harness setup when required; `README.md`, `README.pt-BR.md`, `skills/pi-herdr-subagents/SKILL.md`, `src/extension.ts` tool description; new verification record under `docs/superpowers/plans/`.

- [x] Use an isolated named Herdr session with an explicit matching socket endpoint. Discover IDs from replies. Create only owned test workspaces/panes, never select or mutate user panes, and never restart/stop the user's server.
- [x] Verify real ratio path semantics, 0–6 birth order, local arbitrary close and column reopen. Use bound supported-agent identities or the existing live test shim to keep foreground processes alive and verify PIDs/terminal IDs through mutations. Verify main/child/external focus and a sidebar-like external pane's geometry.
- [x] Clean only proven owned test resources. Preserve failing test evidence rather than closing unproven resources.
- [x] Update docs to incremental history-dependent columns, exact ratio API, no swaps/auxiliaries/staging, and manual pending-v1 reconciliation. Document exact live commands and observed outcomes, distinguishing simulated coverage from real evidence.
- [x] Run final `npm test`, `npm run check`, `git diff --check` and review the complete diff. Commit only changes owned by this task.
