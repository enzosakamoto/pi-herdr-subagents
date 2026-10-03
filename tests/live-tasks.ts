import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/herdr.ts";
import { paneRef } from "../src/layout.ts";
import { Tasks, finished } from "../src/tasks.ts";
if (process.env.HERDR_LIVE_TEST !== "1") throw new Error("Opt-in only; uses two real pi TUI children and model calls.");
const session = process.env.HERDR_TEST_SESSION ?? "pi-herdr-subagents-test-20261003";
const cli = new Herdr(process.env, undefined, ["--session", session]);
const created = await cli.json(["workspace", "create", "--label", "hs-task-verification", "--cwd", process.cwd(), "--no-focus"]);
const principal = paneRef(created.root_pane), root = await mkdtemp(join(tmpdir(), "hs-live-tasks-"));
const manager = new Tasks(cli, principal, root, { cwd: process.cwd(), model: (process.env.PI_PROVIDER ?? "openai-codex") + "/" + (process.env.PI_MODEL ?? "gpt-6.1-sol"),
  thinking: process.env.PI_REASONING_LEVEL ?? "high", packagePath: process.cwd() }, {
  persist: async task => { await appendFile(join(root, "events.jsonl"), JSON.stringify({ taskId: task.taskId, state: task.state, pane: task.pane, diagnostic: task.diagnostic }) + "\n", { mode: 0o600 }); },
  notify: async (task, attention) => {
    await appendFile(join(root, "notifications.jsonl"), JSON.stringify({ taskId: task.taskId, attention, resultPath: task.resultPath, diagnostic: task.diagnostic }) + "\n", { mode: 0o600 });
    console.log(attention ? "ATTENTION" : "RESULT", task.taskId, task.diagnostic ?? task.resultPath);
  }
});
let success = false;
try {
  const started = Date.now();
  const tasks = await Promise.all(["HS-LIVE-A", "HS-LIVE-B"].map(token => manager.spawn(
    "Live orchestration verification. Do not read or modify project files. Use bash once to run sleep 8. Then reply with exactly " + token + ". Do not delegate.")));
  console.log("Spawn reservations returned in", Date.now() - started, "ms; principal remains free.");
  let overlap = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && (!tasks.every(task => finished(manager.task(task.taskId))) || manager.pending.size > 0)) {
    const current = tasks.map(task => manager.task(task.taskId));
    if (current.every(task => task.state === "working" && task.pane)) overlap = true;
    const failure = current.find(task => ["blocked", "collection_failed", "cleanup_pending", "failed"].includes(task.state));
    if (failure) throw new Error(failure.state + ": " + failure.diagnostic);
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(overlap, "two pi children performed work concurrently");
  for (const [index, task] of tasks.entries()) {
    const current = manager.task(task.taskId);
    assert.ok(finished(current)); assert.equal(current.state, "completed");
    assert.equal(current.outcome?.text.trim(), index === 0 ? "HS-LIVE-A" : "HS-LIVE-B");
    assert.ok(current.resultPath); assert.equal(current.pane, undefined);
  }
  const cancelled = await manager.spawn("Cancellation verification. Do not read or modify project files. Use bash to run sleep 30, then say SHOULD-NOT-COMPLETE.");
  while (!manager.task(cancelled.taskId).submitted && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  await manager.cancel(cancelled.taskId);
  while ((!finished(manager.task(cancelled.taskId)) || manager.pending.size > 0) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.ok(finished(manager.task(cancelled.taskId)));
  assert.equal(manager.task(cancelled.taskId).state, "cancelled");
  assert.equal(manager.task(cancelled.taskId).outcome?.stopReason, "aborted");
  console.log("Live explicit Escape cancellation PASS; correlated diagnostics persisted before cleanup.");
  success = true;
  console.log("Live pi lifecycle PASS: two TUI children, one prompt each, overlap, structured persisted results, owned pane cleanup.");
} finally {
  await manager.stop();
  if (success) await cli.json(["workspace", "close", principal.workspaceId]);
  else console.log("Preserved test workspace for diagnosis:", principal.workspaceId);
  console.log("Evidence directory (outside repository):", root);
}
