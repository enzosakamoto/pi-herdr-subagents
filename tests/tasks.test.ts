import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fake, eventually } from "./fake.ts";
import { HerdrError } from "../src/herdr.ts";
import { atomicJson } from "../src/results.ts";
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
test("model/thinking are captured at reservation, not read from a later principal selection", async t => {
  const { fake, manager } = await setup(t);
  manager.defaults.model = "first/model"; manager.defaults.thinking = "high";
  const first = manager.spawn("A");
  manager.defaults.model = "second/model"; manager.defaults.thinking = "low";
  const second = manager.spawn("B");
  const [a, b] = await Promise.all([first, second]);
  await eventually(() => !!fake.agents.get(a.agentName)?.prompt && !!fake.agents.get(b.agentName)?.prompt);
  for (const [task, model, thinking] of [[a, "first/model", "high"], [b, "second/model", "low"]] as const) {
    const args = fake.calls.find(args => args[1] === "start" && args[2] === task.agentName)!;
    assert.equal(args[args.indexOf("--model") + 1], model);
    assert.equal(args[args.indexOf("--thinking") + 1], thinking);
  }
});
test("per-call model selections are copied before await and never mutate shared defaults", async t => {
  const { fake, manager } = await setup(t);
  const options = { model: "p/cheap", tier: "low" as const, modelSource: "tier" as const, thinking: "low" };
  const pending = manager.spawn("tests", undefined, options);
  options.model = "p/mutated"; options.thinking = "high";
  const defaultPending = manager.spawn("legacy defaults");
  const [a, b] = await Promise.all([pending, defaultPending]);
  assert.equal(a.model, "p/cheap"); assert.equal(a.thinking, "low");
  assert.equal(b.model, "test/test"); assert.equal(b.thinking, "off");
  assert.equal(manager.defaults.model, "test/test");
  await eventually(() => !!fake.agents.get(a.agentName)?.prompt && !!fake.agents.get(b.agentName)?.prompt);
  const args = fake.calls.find(args => args[1] === "start" && args[2] === a.agentName)!;
  assert.equal(args[args.indexOf("--model") + 1], "p/cheap");
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
  const legacy = structuredClone(records.filter(r => r.taskId === task.taskId).at(-1)!);
  delete legacy.tier; delete legacy.modelSource; delete legacy.model; delete legacy.thinking;
  await atomicJson(join(legacy.directory, "task.json"), legacy);
  await restored.restore([legacy]);
  assert.equal(restored.list()[0].model, undefined, "legacy metadata is not invented on restore");
  assert.equal(restored.list()[0].tier, undefined);
  assert.equal(restored.list()[0].modelSource, undefined);
  assert.equal(restored.list()[0].thinking, undefined);
  await fake.complete(task.agentName);
  await eventually(() => finished(restored.task(task.taskId)) && restored.pending.size === 0);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 1);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 1);
  assert.equal(notifications.filter(n => !n.attention).length, 1);
});
test("copied history from another principal session never adopts its live children", async t => {
  const { fake, manager, root, records } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  const calls = fake.calls.length;
  const foreign = new Tasks(fake, paneRef(fake.panes.get("principal")), join(root, "another-principal"), manager.defaults,
    { persist: async () => { throw new Error("foreign state write"); }, notify: async () => { throw new Error("foreign notification"); } });
  t.after(() => foreign.stop());
  await foreign.restore([records.filter(r => r.taskId === task.taskId).at(-1)!]);
  assert.deepEqual(foreign.list(), []);
  assert.equal(fake.calls.length, calls);
  assert.ok(fake.panes.has(fake.agents.get(task.agentName)!.pane));
});
test("unknown is not completion, even with a settlement file", async t => {
  const { fake, manager } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await fake.complete(task.agentName);
  fake.panes.get(fake.agents.get(task.agentName)!.pane)!.agent_status = "unknown";
  await eventually(() => manager.task(task.taskId).state === "collection_failed");
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0);
});
test("only explicit pre-launch busy rejection is retried, never an uncertain launch", async t => {
  const { fake, manager } = await setup(t);
  let starts = 0;
  fake.error = args => args[1] === "start" && starts++ === 0 ? new HerdrError("shell not rendered", "agent_pane_busy") : undefined;
  const task = await manager.spawn("work", "focused specialization");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 2);
  assert.equal(fake.agents.size, 1);
  fake.error = args => args[1] === "start" ? new HerdrError("accepted mutation timeout", "cli_timeout", true) : undefined;
  const uncertain = await manager.spawn("other work");
  await eventually(() => !!manager.task(uncertain.taskId).attentionSent);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 3);
  assert.equal(fake.agents.size, 1);
});
test("mismatched or unreported startup models never receive the task or silently resume", async t => {
  for (const startupModel of ["other/expensive", null]) {
    const { fake, manager } = await setup(t);
    fake.startupModel = startupModel;
    const task = await manager.spawn("run tests", undefined, { model: "test/cheap", tier: "low", modelSource: "tier", thinking: "off" });
    await eventually(() => !!manager.task(task.taskId).attentionSent);
    assert.match(manager.task(task.taskId).diagnostic!, /Child model mismatch/);
    assert.equal(manager.task(task.taskId).submitted, false);
    assert.equal(manager.task(task.taskId).state, "collection_failed");
    const status = await manager.status(task.taskId);
    await eventually(() => manager.pending.size === 0);
    assert.equal(status.model, "test/cheap"); assert.equal(status.modelSource, "tier");
    assert.equal(manager.task(task.taskId).submitted, false);
    assert.equal(fake.calls.filter(args => args[1] === "prompt").length, 0);
    assert.equal(fake.calls.filter(args => args[1] === "start").length, 1);
    assert.equal(fake.calls.filter(args => args[1] === "close").length, 0);
    const args = fake.calls.find(args => args[1] === "start")!;
    assert.equal(args[args.indexOf("--provider") + 1], "test");
    await manager.cancel(task.taskId);
    await eventually(() => finished(manager.task(task.taskId)));
    assert.equal(manager.task(task.taskId).state, "cancelled");
  }
});

test("blocked startup never auto-approves/relaunches; status resumes one unsent task after intervention", async t => {
  const { fake, manager } = await setup(t); fake.startBlocked = true;
  const task = await manager.spawn("work");
  await eventually(() => manager.task(task.taskId).state === "blocked" && !!manager.task(task.taskId).attentionSent);
  assert.equal(fake.calls.filter(a => a[1] === "prompt" || a[1] === "send-keys").length, 0);
  fake.panes.get(fake.agents.get(task.agentName)!.pane)!.agent_status = "idle"; // Explicit user intervention.
  await Promise.all([manager.status(task.taskId), manager.status(task.taskId), manager.status(task.taskId)]);
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  assert.equal(fake.calls.filter(a => a[1] === "start").length, 1);
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 1);
  await fake.complete(task.agentName);
  await eventually(() => finished(manager.task(task.taskId)));
});
test("cancel during delayed startup collects diagnostics without submitting the task", async t => {
  const { fake, manager } = await setup(t);
  let release!: () => void; fake.delayStart = new Promise<void>(r => { release = r; });
  const task = await manager.spawn("work");
  await eventually(() => fake.calls.some(a => a[1] === "start"));
  await manager.cancel(task.taskId); release();
  await eventually(() => finished(manager.task(task.taskId)));
  assert.equal(manager.task(task.taskId).state, "cancelled");
  assert.equal(fake.calls.filter(a => a[1] === "prompt").length, 0);
});
test("manual closure is diagnosed; a closed pane is not a live task target", async t => {
  const { fake, manager } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await fake.json(["pane", "close", fake.agents.get(task.agentName)!.pane]);
  const status = await manager.status(task.taskId);
  assert.equal(status.state, "failed"); assert.equal(status.paneId, undefined);
  assert.match(status.diagnostic!, /Lost or changed/);
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 1);
});
test("compaction failure preserves results and marks cleanup pending, status reconciles survivors", async t => {
  const { fake, manager } = await setup(t);
  const [a, b] = await Promise.all([manager.spawn("A"), manager.spawn("B")]);
  await eventually(() => !!fake.agents.get(a.agentName)?.prompt && !!fake.agents.get(b.agentName)?.prompt);
  fake.error = args => args[1] === "move" ? new HerdrError("layout mutation timeout", "cli_timeout", true) : undefined;
  await fake.complete(a.agentName);
  await eventually(() => manager.task(a.taskId).state === "cleanup_pending");
  assert.ok(manager.task(a.taskId).outcome); assert.equal(manager.task(a.taskId).pane, undefined);
  fake.error = undefined;
  const status = await manager.status(a.taskId);
  assert.equal(status.state, "completed"); assert.ok(status.resultPath);
  assert.equal(fake.panes.size, 2);
});
test("stopped observer suppresses stale completion and notification callbacks", async t => {
  const { fake, manager, notifications } = await setup(t), task = await manager.spawn("work");
  await eventually(() => !!fake.agents.get(task.agentName)?.prompt);
  await manager.stop(); await fake.complete(task.agentName);
  assert.equal(notifications.length, 0);
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0);
});
test("UI sidecar reports blocked even after a CLI lifecycle observer is invalidated by staging", async t => {
  const { fake, manager, notifications } = await setup(t);
  fake.error = args => args[1] === "prompt" ? new HerdrError("target relocated after submission", "agent_not_running") : undefined;
  const task = await manager.spawn("work");
  await eventually(() => !!manager.task(task.taskId).pane?.agentName && manager.task(task.taskId).submitted);
  const current = manager.task(task.taskId);
  await atomicJson(join(current.directory, "blocked.json"), { taskId: task.taskId, sessionId: task.sessionId,
    sessionPath: current.pane!.sessionPath, active: true, title: "Confirm test operation" });
  await eventually(() => current.state === "blocked" && !!current.attentionSent);
  assert.equal(notifications.filter(n => n.attention).length, 1);
  assert.equal(fake.calls.filter(a => a[1] === "send-keys" || a[1] === "close").length, 0);
});
