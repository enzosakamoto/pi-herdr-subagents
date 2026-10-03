import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fake, eventually } from "./fake.ts";
import { paneRef } from "../src/layout.ts";
import { Tasks, finished, type Task } from "../src/tasks.ts";
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hs-tasks-"));
  const fake = new Fake(), notifications: { id: string; attention: boolean }[] = [], records: Task[] = [];
  const manager = new Tasks(fake, paneRef(fake.panes.get("principal")), root, { cwd: "/", model: "test/test", thinking: "off", packagePath: process.cwd() }, {
    persist: async task => { records.push(task); },
    notify: async (task, attention) => {
      if (!attention) { assert.ok(task.resultPath); assert.ok((await readFile(task.resultPath, "utf8")).includes("stopReason")); }
      notifications.push({ id: task.taskId, attention });
    }
  });
  t.after(async () => { await manager.stop(); await rm(root, { recursive: true, force: true }); });
  return { fake, manager, notifications, records, root };
}
test("spawn returns before delayed startup; reservation enforces six concurrent calls without queue", async t => {
  const { fake, manager } = await setup(t);
  let release!: () => void;
  fake.delayStart = new Promise<void>(r => { release = r; });
  const spawned = await Promise.all(Array.from({ length: 6 }, () => manager.spawn("read-only")));
  assert.equal(spawned.length, 6);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 0);
  await assert.rejects(manager.spawn("seventh"), /Six active/);
  release();
  await eventually(() => [...manager.tasks.values()].every(task => task.submitted));
  assert.equal(fake.agents.size, 6);
});
test("two children work concurrently, persist before close and notify exactly once", async t => {
  const { fake, manager, notifications } = await setup(t);
  const tasks = await Promise.all([manager.spawn("investigate A"), manager.spawn("investigate B")]);
  await eventually(() => tasks.every(task => manager.task(task.taskId).submitted && fake.agents.get(task.agentName)?.prompt !== undefined));
  assert.equal([...fake.agents.values()].filter(a => fake.panes.get(a.pane)?.agent_status === "working").length, 2);
  for (const task of tasks) await fake.complete(task.agentName, "stop", "response ".repeat(10000));
  await eventually(() => tasks.every(task => finished(manager.task(task.taskId))));
  for (const task of tasks) {
    const status = await manager.status(task.taskId);
    assert.equal(status.state, "completed"); assert.equal(status.paneId, undefined); assert.ok(status.result?.truncated);
    assert.ok((await readFile(status.resultPath!, "utf8")).length > 12000);
    await manager.wait(task.taskId, 1); await manager.status(task.taskId);
  }
  assert.equal(notifications.filter(n => !n.attention).length, 2);
});
test("wait timeout and observer abort do not cancel or resubmit", async t => {
  const { fake, manager } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  assert.equal((await manager.wait(task.taskId, 1)).timedOut, true);
  const controller = new AbortController(); const waiting = manager.wait(task.taskId, 1000, controller.signal); controller.abort();
  await assert.rejects(waiting, /child is still owned/);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 1);
  assert.equal(fake.calls.filter(a => a[1] === "send-keys" || a[1] === "close").length, 0);
  assert.equal(manager.task(task.taskId).state, "working");
});
test("blocked retains pane, announces once and never approves; completion after intervention is collected", async t => {
  const { fake, manager, notifications } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  fake.block(task.agentName);
  await eventually(() => manager.task(task.taskId).state === "blocked" && !!manager.task(task.taskId).attentionSent);
  await manager.wait(task.taskId, 10); await manager.status(task.taskId);
  assert.equal(notifications.filter(n => n.attention).length, 1);
  assert.equal(fake.calls.filter(a => a[1] === "send-keys" || a[1] === "close").length, 0);
  await fake.complete(task.agentName);
  await eventually(() => finished(manager.task(task.taskId)));
});
test("explicit cancel uses escape and only closes after quiescent correlated diagnostics", async t => {
  const { fake, manager } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await manager.cancel(task.taskId);
  await eventually(() => finished(manager.task(task.taskId)));
  assert.equal(manager.task(task.taskId).state, "cancelled");
  assert.ok(fake.calls.some(a => a[1] === "send-keys" && a[3] === "esc"));
});
test("result save failure preserves the only live copy", async t => {
  const { fake, manager, notifications } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await mkdir(join(manager.task(task.taskId).directory, "result.json"));
  await fake.complete(task.agentName);
  await eventually(() => manager.task(task.taskId).state === "collection_failed");
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0);
  assert.equal(notifications.filter(n => !n.attention).length, 0);
  assert.ok(manager.task(task.taskId).pane);
});
test("agent replacement is never interrupted or closed", async t => {
  const { fake, manager } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  fake.panes.get(fake.agents.get(task.agentName)!.pane)!.name = "someone-else";
  await assert.rejects(manager.cancel(task.taskId), /identity changed/);
  assert.equal(fake.calls.filter(a => a[1] === "send-keys" || a[1] === "close").length, 0);
});
test("shutdown/resume observes existing child without launching/submitting again", async t => {
  const { fake, manager, root, records, notifications } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await manager.stop();
  const restored = new Tasks(fake, paneRef(fake.panes.get("principal")), root, manager.defaults, {
    persist: async record => { records.push(record); }, notify: async (record, attention) => { notifications.push({ id: record.taskId, attention }); }
  });
  t.after(() => restored.stop());
  await restored.restore([records.filter(r => r.taskId === task.taskId).at(-1)!]);
  await fake.complete(task.agentName);
  await eventually(() => finished(restored.task(task.taskId)) && restored.pending.size === 0);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 1);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 1);
  assert.equal(notifications.filter(n => !n.attention).length, 1);
});
test("unknown is not completion, even with a settlement file", async t => {
  const { fake, manager } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await fake.complete(task.agentName);
  fake.panes.get(fake.agents.get(task.agentName)!.pane)!.agent_status = "unknown";
  await eventually(() => manager.task(task.taskId).state === "collection_failed");
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0);
});
