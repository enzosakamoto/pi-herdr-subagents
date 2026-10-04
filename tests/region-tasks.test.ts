import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fake, eventually } from "./fake.ts";
import { paneRef } from "../src/layout.ts";
import { HerdrError } from "../src/herdr.ts";
import { Tasks, finished, type Task } from "../src/tasks.ts";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hs-region-tasks-")), fake = new Fake();
  const records: Task[] = [], notifications: { id: string; attention: boolean }[] = [];
  const hooks = {
    persist: async (task: Task) => { records.push(task); },
    notify: async (task: Task, attention: boolean) => { notifications.push({ id: task.taskId, attention }); }
  };
  const managers: Tasks[] = [];
  const create = () => {
    const manager = new Tasks(fake, paneRef(fake.panes.get("principal")), root, { cwd: "/", model: "test/test", thinking: "off", packagePath: process.cwd() }, hooks);
    managers.push(manager); return manager;
  };
  // Remove files only after stopping all managers and their filesystem observers.
  t.after(async () => { await Promise.all(managers.map(manager => manager.stop())); await rm(root, { recursive: true, force: true }); });
  const manager = create();
  const restore = async (tasks: Task[]) => {
    const restored = create();
    await restored.restore(tasks.map(task => records.filter(r => r.taskId === task.taskId).at(-1)!));
    return restored;
  };
  return { fake, manager, restore, notifications };
}
function userSibling(fake: Fake) {
  const p = fake.newPane("original"), id = String(p.pane_id);
  fake.tabs.set("original", { direction: "right", ratio: 0.2, left: { pane: id }, right: fake.tabs.get("original")! });
  fake.focus = id;
  const snapshot = () => ({ pane: { ...fake.panes.get(id) }, rect: fake.layout("original").panes.find(p => p.pane_id === id)!.rect });
  return { id, snapshot };
}
test("six children with an external pane survive reload and clean up without adopting user work", async t => {
  const { fake, manager, restore, notifications } = await setup(t);
  const user = userSibling(fake), before = user.snapshot();
  const tasks = await Promise.all(Array.from({ length: 6 }, (_, i) => manager.spawn("investigate " + i)));
  await eventually(() => tasks.every(task => !!fake.agents.get(task.agentName)?.prompt), 10000);
  assert.deepEqual(user.snapshot(), before); assert.equal(fake.focus, user.id);
  await manager.stop();
  const restored = await restore(tasks);
  for (const index of [2, 5, 0, 4, 1, 3]) {
    const task = tasks[index];
    await fake.complete(task.agentName);
    await eventually(() => finished(restored.task(task.taskId)));
    assert.deepEqual(user.snapshot(), before); assert.equal(fake.focus, user.id);
  }
  assert.equal(fake.panes.size, 2); assert.equal(fake.tabs.size, 1);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 6);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 6);
  assert.equal(notifications.filter(n => !n.attention).length, 6);
  assert.equal(fake.calls.filter(a => ["split", "move", "close", "send-keys"].includes(a[1]) && a[2] === user.id).length, 0);
});
test("reload reconciles owned same-tab helpers after failed compaction without touching external panes", async t => {
  const { fake, manager, restore } = await setup(t);
  const user = userSibling(fake), before = user.snapshot();
  const tasks = await Promise.all([manager.spawn("A"), manager.spawn("B"), manager.spawn("C")]);
  await eventually(() => tasks.every(task => !!fake.agents.get(task.agentName)?.prompt));
  fake.error = args => args[1] === "swap" ? new HerdrError("assembly failed", "swap_busy") : undefined;
  await fake.complete(tasks[2].agentName);
  await eventually(() => manager.task(tasks[2].taskId).state === "cleanup_pending");
  assert.equal(manager.task(tasks[2].taskId).pane, undefined);
  assert.ok(manager.layout.pending);
  assert.ok(tasks.slice(0, 2).every(task => manager.task(task.taskId).pane?.tabId === "original"));
  await manager.stop(); fake.error = undefined;
  const restored = await restore(tasks);
  await eventually(() => finished(restored.task(tasks[2].taskId)) && tasks.slice(0, 2).every(task => restored.task(task.taskId).pane?.tabId === "original"));
  assert.deepEqual(user.snapshot(), before); assert.equal(fake.focus, user.id);
  for (const task of tasks.slice(0, 2)) {
    await fake.complete(task.agentName);
    await eventually(() => finished(restored.task(task.taskId)));
  }
  assert.deepEqual(user.snapshot(), before); assert.equal(fake.panes.size, 2); assert.equal(fake.tabs.size, 1);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 3);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 3);
});
test("user insertion inside the owned subtree retains completed result and all panes", async t => {
  const { fake, manager } = await setup(t);
  const tasks = await Promise.all([manager.spawn("A"), manager.spawn("B")]);
  await eventually(() => tasks.every(task => !!fake.agents.get(task.agentName)?.prompt));
  const user = fake.newPane("original"), userId = String(user.pane_id);
  const child = manager.task(tasks[1].taskId).pane!.paneId;
  fake.tabs.set("original", fake.insert(fake.tabs.get("original")!, child, userId, "down", 0.5));
  const before = fake.layout("original"), closeCount = fake.calls.filter(a => a[1] === "close").length;
  await fake.complete(tasks[0].agentName);
  await eventually(() => manager.task(tasks[0].taskId).state === "cleanup_pending");
  const task = manager.task(tasks[0].taskId);
  assert.ok(task.resultPath); assert.ok(task.outcome); assert.ok(task.pane);
  assert.match(task.diagnostic!, /region|subtree/i);
  assert.deepEqual(fake.layout("original"), before);
  assert.equal(fake.calls.filter(a => a[1] === "close").length, closeCount);
});
