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
import { atomicJson, readJson } from "../src/results.ts";

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
const mutations = (fake: Fake) => fake.calls.filter(a => ["split", "swap", "close", "move", "create", "set_split_ratio"].includes(a[1])).length;

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
    if (!interrupted && state.record?.newTaskId && state.record.reserve) { interrupted = true; throw new Error("branch callback interrupted after durable birth"); }
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
test("a branch without the transaction cannot adopt its on-disk reservation", async t => {
  const h = await setup(t), a = await h.manager.spawn("A"); await eventually(() => !!h.fake.agents.get(a.agentName)?.prompt);
  const persist = h.hooks.persist; let interrupted = false;
  h.hooks.persist = async task => { await persist(task); if (!interrupted && task.task === "B" && task.pane) { interrupted = true; throw new Error("attachment interrupted"); } };
  const b = await h.manager.spawn("B"); await eventually(() => h.manager.task(b.taskId).state === "collection_failed");
  await h.manager.stop(); h.fake.error = undefined;
  const before = mutations(h.fake), old = h.fake.layout("original"), restored = h.create();
  await restored.restore([h.records.get(a.taskId)!], null); assert.equal(restored.layout.pending, false);
  assert.equal(mutations(h.fake), before); assert.deepEqual(h.fake.layout("original"), old);
  const c = await restored.spawn("C"); await eventually(() => restored.task(c.taskId).state === "failed");
  assert.match(restored.task(c.taskId).diagnostic!, /subtree/); assert.equal(mutations(h.fake), before);
});
test("omitted/completed branch transactions cannot execute an unlinked/stale disk journal", async t => {
  for (const completed of [false, true]) {
    const h = await setup(t), principal = paneRef(h.fake.panes.get("principal")), taskId = crypto.randomUUID();
    const task: Task = { taskId, task: "interrupted startup", state: "starting", created: new Date().toISOString(), agentName: "worker", sessionId: "session", directory: join(h.root, taskId), submitted: false, cancelRequested: false };
    const transactionId = crypto.randomUUID(), baseTree = { pane: principal.paneId };
    const state: LayoutState = { transactionId, record: { version: 2, id: transactionId, owner: h.root, principal, taskIds: [taskId], workers: [], mode: "add", cwd: "/", env: {}, newTaskId: taskId, next: 0, baseTree, tree: baseTree, focus: { ...principal, occupant: "{}" } } };
    await atomicJson(join(h.root, "layout.json"), state);
    await h.manager.restore([task], completed ? { transactionId, record: null } : undefined);
    assert.equal(h.fake.calls.filter(a => a[1] === "split").length, 0); assert.equal(h.manager.task(taskId).pane, undefined);
    assert.deepEqual(await readJson(join(h.root, "layout.json")), state);
  }
});
test("cancelled reserve with lost close acknowledgement reaches cleanup recovery", async t => {
  const h = await setup(t), p = h.fake.newPane("original"), taskId = crypto.randomUUID();
  h.fake.tabs.set("original", h.fake.insert(h.fake.tabs.get("original")!, "principal", p.pane_id, "right", 0.5));
  const task: Task = { taskId, task: "unstarted", state: "collection_failed", created: new Date().toISOString(), agentName: "worker", sessionId: "session", directory: join(h.root, taskId), submitted: false, cancelRequested: false, pane: paneRef(p) };
  h.manager.tasks.set(taskId, task);
  h.fake.afterError = a => a[1] === "close" ? new HerdrError("lost close acknowledgement", "cli_timeout", true) : undefined;
  await assert.rejects(h.manager.cancel(taskId), /lost close/); assert.equal(task.state, "cleanup_pending");
  h.fake.afterError = undefined; const status = await h.manager.status(taskId);
  assert.equal(status.state, "cancelled"); assert.equal(status.paneId, undefined);
  assert.equal(h.fake.calls.filter(a => a[1] === "close").length, 1);
});
test("failed-growth shell cancellation still waits for follow-up admission", async t => {
  const h = await setup(t), a = await h.manager.spawn("A"); await eventually(() => !!h.fake.agents.get(a.agentName)?.prompt);
  const persist = h.hooks.persist; let interrupted = false;
  h.hooks.persist = async task => { await persist(task); if (!interrupted && task.task === "B" && task.pane) { interrupted = true; throw new Error("attachment interrupted"); } };
  const b = await h.manager.spawn("B"); await eventually(() => h.manager.task(b.taskId).state === "collection_failed");
  h.fake.error = undefined; await h.manager.status(b.taskId); h.hooks.notify = async () => false;
  await h.manager.cancel(b.taskId);
  const pane = h.manager.task(b.taskId).pane!; assert.ok(pane); assert.ok(h.manager.task(b.taskId).resultPath);
  assert.equal(h.manager.task(b.taskId).notified, false);
  h.manager.acknowledge(b.taskId); await eventually(() => finished(h.manager.task(b.taskId)));
  assert.ok(!h.fake.panes.has(pane.paneId)); assert.equal(h.fake.calls.filter(a => a[1] === "start").length, 1);
  assert.equal(h.fake.calls.filter(a => a[1] === "prompt").length, 1);
});
