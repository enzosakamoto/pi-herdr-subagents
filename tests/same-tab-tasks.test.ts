import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fake, eventually } from "./fake.ts";
import { paneRef } from "../src/layout.ts";
import { HerdrError } from "../src/herdr.ts";
import { Tasks, finished, type Task } from "../src/tasks.ts";
import type { LayoutState } from "../src/layout-state.ts";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hs-same-tab-tasks-")), fake = new Fake();
  const records = new Map<string, Task>(), layouts: LayoutState[] = [], managers: Tasks[] = [];
  const hooks = { persist: async (task: Task) => { records.set(task.taskId, task); },
    persistLayout: async (state: LayoutState) => { layouts.push(state); }, notify: async () => true as boolean };
  const create = () => {
    const m = new Tasks(fake, paneRef(fake.panes.get("principal")), root, { cwd: "/", model: "test/model", thinking: "off", packagePath: process.cwd() }, hooks);
    managers.push(m); return m;
  };
  t.after(async () => { await Promise.all(managers.map(m => m.stop())); await rm(root, { recursive: true, force: true }); });
  return { root, fake, records, layouts, hooks, create, manager: create() };
}
const mutations = (fake: Fake) => fake.calls.filter(a => ["split", "swap", "close", "move", "create"].includes(a[1])).length;

test("restore before reservation birth persists the new owner without launching or resubmitting", async t => {
  const h = await setup(t), a = await h.manager.spawn("A");
  await eventually(() => !!h.fake.agents.get(a.agentName)?.prompt);
  const identity = structuredClone(h.manager.task(a.taskId).pane);
  h.fake.error = args => args[1] === "split" ? new HerdrError("pre-birth rejection", "pane_busy") : undefined;
  const b = await h.manager.spawn("B"); await eventually(() => h.manager.task(b.taskId).state === "failed");
  assert.equal(h.manager.task(b.taskId).pane, undefined); assert.ok(h.manager.layout.pending);
  await assert.rejects(h.manager.spawn("C"), /recovery pending/i);
  const branch = h.layouts.at(-1)!; await h.manager.stop(); h.fake.error = undefined;
  const restored = h.create(); await restored.restore([...h.records.values()], branch);
  await eventually(() => restored.task(b.taskId).state === "collection_failed" && !!restored.task(b.taskId).pane);
  assert.equal(restored.layout.pending, false); assert.deepEqual(restored.task(a.taskId).pane, identity);
  assert.equal(h.fake.calls.filter(a => a[1] === "start").length, 1); assert.equal(h.fake.calls.filter(a => a[1] === "prompt").length, 1);
  assert.equal((await stat(join(h.root, "layout.json"))).mode & 0o777, 0o600);
  await restored.cancel(b.taskId); assert.ok(finished(restored.task(b.taskId))); assert.equal(h.fake.panes.size, 2);
  await h.fake.complete(a.agentName); await eventually(() => finished(restored.task(a.taskId)));
});
test("disk birth recorded before a failed branch callback reconnects only its reserved task", async t => {
  const h = await setup(t), a = await h.manager.spawn("A"); await eventually(() => !!h.fake.agents.get(a.agentName)?.prompt);
  let interrupted = false;
  const persist = h.hooks.persistLayout;
  h.hooks.persistLayout = async state => {
    if (!interrupted && state.record?.newTaskId && state.record.slots.at(-1)) { interrupted = true; throw new Error("branch callback interrupted after durable birth"); }
    await persist(state);
  };
  const b = await h.manager.spawn("B"); await eventually(() => h.manager.task(b.taskId).state === "failed");
  assert.ok(interrupted); assert.equal(h.manager.task(b.taskId).pane, undefined);
  const branch = h.layouts.at(-1)!; await h.manager.stop(); h.hooks.persistLayout = persist;
  const restored = h.create(); await restored.restore([...h.records.values()], branch);
  await eventually(() => restored.task(b.taskId).state === "collection_failed" && !!restored.task(b.taskId).pane);
  assert.equal(h.fake.calls.filter(a => a[1] === "start").length, 1); assert.equal(h.fake.calls.filter(a => a[1] === "prompt").length, 1);
  await restored.cancel(b.taskId); assert.ok(finished(restored.task(b.taskId))); assert.equal(h.fake.panes.size, 2);
});
test("a branch without the transaction cannot adopt its on-disk auxiliary shells", async t => {
  const h = await setup(t), a = await h.manager.spawn("A"); await eventually(() => !!h.fake.agents.get(a.agentName)?.prompt);
  h.fake.error = args => args[1] === "swap" ? new HerdrError("rejection", "pane_busy") : undefined;
  const b = await h.manager.spawn("B"); await eventually(() => h.manager.task(b.taskId).state === "collection_failed");
  await h.manager.stop(); h.fake.error = undefined;
  const before = mutations(h.fake), old = h.fake.layout("original"), restored = h.create();
  await restored.restore([h.records.get(a.taskId)!], null); assert.equal(restored.layout.pending, false);
  assert.equal(mutations(h.fake), before); assert.deepEqual(h.fake.layout("original"), old);
  const c = await restored.spawn("C"); await eventually(() => restored.task(c.taskId).state === "failed");
  assert.match(restored.task(c.taskId).diagnostic!, /subtree/); assert.equal(mutations(h.fake), before);
});
test("failed-growth shell cancellation still waits for follow-up admission", async t => {
  const h = await setup(t), a = await h.manager.spawn("A"); await eventually(() => !!h.fake.agents.get(a.agentName)?.prompt);
  h.fake.error = args => args[1] === "swap" ? new HerdrError("rejection", "pane_busy") : undefined;
  const b = await h.manager.spawn("B"); await eventually(() => h.manager.task(b.taskId).state === "collection_failed");
  h.fake.error = undefined; await h.manager.status(b.taskId); h.hooks.notify = async () => false;
  await h.manager.cancel(b.taskId);
  const pane = h.manager.task(b.taskId).pane!; assert.ok(pane); assert.ok(h.manager.task(b.taskId).resultPath);
  assert.equal(h.manager.task(b.taskId).notified, false);
  h.manager.acknowledge(b.taskId); await eventually(() => finished(h.manager.task(b.taskId)));
  assert.ok(!h.fake.panes.has(pane.paneId)); assert.equal(h.fake.calls.filter(a => a[1] === "start").length, 1);
  assert.equal(h.fake.calls.filter(a => a[1] === "prompt").length, 1);
});
