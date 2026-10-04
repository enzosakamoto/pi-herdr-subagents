import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fake, eventually } from "./fake.ts";
import { Layout, paneRef } from "../src/layout.ts";
import { Tasks, type Task } from "../src/tasks.ts";
import { HerdrError } from "../src/herdr.ts";

const idle = () => ({ shell_pid: 1, foreground_process_group_id: 1,
  foreground_processes: [{ pid: 1, name: "bash", argv0: "/bin/bash", argv: ["/bin/bash"] }] });
const busy = () => ({ ...idle(), foreground_processes: [...idle().foreground_processes, { pid: 77, name: "herdr", argv0: "herdr", argv: ["herdr"] }] });
function shellSetup() {
  const fake = new Fake(), p = fake.newPane("original");
  fake.tabs.set("original", { direction: "right", ratio: 0.5, left: { pane: "principal" }, right: { pane: p.pane_id } });
  return { fake, ref: paneRef(p), layout: new Layout(fake, paneRef(fake.panes.get("principal")), async () => {}) };
}
test("a known shell with a temporary foreground job waits before one agent start", async () => {
  const { fake, ref, layout } = shellSetup(); await layout.awaitShell(ref);
  fake.processInfo = (_id, n) => n === 2 ? busy() : idle();
  const json = fake.json.bind(fake); let sends = 0, intents = 0;
  fake.json = async (a, s) => { if (a[0] === "agent" && a[1] === "start") { sends++; return {}; } return json(a, s); };
  await layout.startAgent(ref, ["agent", "start", "test"], async () => { intents++; });
  assert.equal(sends, 1); assert.equal(intents, 1); assert.ok(fake.processInfoQueries.get(ref.paneId)! >= 3);
});
test("missing optional arguments of a known shell wait, not success or identity change", async () => {
  const { fake, ref, layout } = shellSetup(); await layout.awaitShell(ref);
  fake.processInfo = (_id, n) => n === 2 ? { ...idle(), foreground_processes: [{ pid: 1, name: "bash" }] } : idle();
  const original = structuredClone(ref.shell); await layout.validate(ref);
  assert.deepEqual(ref.shell, original); assert.ok(fake.processInfoQueries.get(ref.paneId)! >= 3);
});
test("temporarily unknown shell PID/group/processes wait for another complete snapshot", async () => {
  for (const shell_pid of [null, 0]) {
    const { fake, ref, layout } = shellSetup(); await layout.awaitShell(ref);
    fake.processInfo = (_id, n) => n === 2 ? { shell_pid, foreground_process_group_id: null, foreground_processes: [] } : idle();
    const original = structuredClone(ref.shell); await layout.validate(ref);
    assert.deepEqual(ref.shell, original); assert.ok(fake.processInfoQueries.get(ref.paneId)! >= 3);
  }
});
test("arguments appearing after initial unavailable data do not replace the original fingerprint", async () => {
  const { fake, ref, layout } = shellSetup();
  fake.processInfo = (_id, n) => n === 1 ? { ...idle(), foreground_processes: [{ pid: 1, name: "bash" }] } : idle();
  await layout.awaitShell(ref); const original = structuredClone(ref.shell);
  await layout.validate(ref); assert.deepEqual(ref.shell, original);
});
test("permanent busy foreground times out without a launch intent or command", async () => {
  const { fake, ref, layout } = shellSetup(); await layout.awaitShell(ref);
  fake.processInfo = () => busy(); let intent = false;
  await assert.rejects(layout.startAgent(ref, ["agent", "start", "test"], async () => { intent = true; }), /foreground|shell/i);
  assert.equal(intent, false); assert.ok(fake.processInfoQueries.get(ref.paneId)! > 2);
  assert.ok(!fake.calls.some(a => ["start", "prompt", "split", "swap", "close"].includes(a[1])));
});
test("explicit PID/name/argument changes are immediate rejection, even with the same PID", async () => {
  for (const field of ["pid", "name", "argv0", "argv"]) {
    const { fake, ref, layout } = shellSetup(); await layout.awaitShell(ref);
    fake.processInfo = () => {
      const info = idle();
      if (field === "pid") info.shell_pid = 2;
      if (field === "name") info.foreground_processes[0].name = "zsh";
      if (field === "argv0") info.foreground_processes[0].argv0 = "/bin/zsh";
      if (field === "argv") info.foreground_processes[0].argv = ["/bin/bash", "-c", "user work"];
      return info;
    };
    await assert.rejects(layout.awaitShell(ref), /identity changed/);
    assert.equal(fake.processInfoQueries.get(ref.paneId), 2);
  }
});
test("pane replacement and an unexpected agent are not foreground-wait conditions", async () => {
  for (const kind of ["terminal", "agent"]) {
    const { fake, ref, layout } = shellSetup(); await layout.awaitShell(ref);
    fake.panes.get(ref.paneId)![kind === "terminal" ? "terminal_id" : "agent"] = kind === "terminal" ? "replacement" : "pi";
    await assert.rejects(layout.awaitShell(ref), /replaced|Unexpected agent/);
    assert.equal(fake.processInfoQueries.get(ref.paneId), 1);
  }
});

async function managerSetup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hs-shell-startup-")), fake = new Fake(), managers: Tasks[] = [];
  const create = () => {
    const m = new Tasks(fake, paneRef(fake.panes.get("principal")), root,
      { cwd: "/", model: "test/model", thinking: "off", packagePath: process.cwd() }, { persist: async () => {}, notify: async () => true });
    managers.push(m); return m;
  };
  t.after(async () => { await Promise.all(managers.map(m => m.stop())); await rm(root, { recursive: true, force: true }); });
  const reservation = (m: Tasks, launchAttempted = true) => {
    const p = fake.newPane("original"), taskId = crypto.randomUUID();
    fake.tabs.set("original", fake.insert(fake.tabs.get("original")!, "principal", p.pane_id, "right", 0.5));
    const task: Task = { taskId, task: "read only", state: "collection_failed", created: new Date().toISOString(),
      agentName: "hs-" + taskId, sessionId: "hs-" + taskId, directory: join(root, taskId),
      pane: paneRef(p), submitted: false, cancelRequested: false, launchAttempted, model: "test/model" };
    m.tasks.set(taskId, task); return task;
  };
  const remove = (task: Task) => {
    const id = task.pane!.paneId; fake.panes.delete(id); fake.tabs.set("original", fake.remove(fake.tabs.get("original")!, id)!);
  };
  return { fake, create, reservation, remove };
}
test("temporary foreground during slot confirmation no longer strands five concurrent reservations", async t => {
  const h = await managerSetup(t), m = h.create();
  h.fake.processInfo = (_id, n) => n === 2 ? busy() : idle();
  const tasks = await Promise.all(Array.from({ length: 5 }, (_, i) => m.spawn("read only " + i)));
  await eventually(() => tasks.every(task => m.task(task.taskId).submitted && !!h.fake.agents.get(task.agentName)?.prompt));
  assert.equal(h.fake.calls.filter(a => a[1] === "start").length, 5); assert.equal(h.fake.calls.filter(a => a[1] === "prompt").length, 5);
  assert.equal(m.layout.pending, false); assert.equal(h.fake.panes.size, 6);
});
test("status clears only a definitively missing reservation and the next spawn succeeds", async t => {
  const h = await managerSetup(t), m = h.create(), task = h.reservation(m); h.remove(task);
  const before = h.fake.calls.length, status = await m.status(task.taskId);
  assert.equal(status.state, "failed"); assert.equal(status.paneId, undefined);
  assert.ok(h.fake.calls.slice(before).some(a => a[1] === "get"));
  assert.ok(!h.fake.calls.slice(before).some(a => ["close", "move", "split", "swap", "start", "prompt"].includes(a[1])));
  const next = await m.spawn("new read only"); await eventually(() => m.task(next.taskId).submitted);
  assert.equal(h.fake.calls.filter(a => a[1] === "start").length, 1);
});
test("restore probes missing launch-intent reservations before reading their absent handshake", async t => {
  const h = await managerSetup(t), old = h.create(), task = h.reservation(old); h.remove(task);
  await old.stop(); const restored = h.create(); await restored.restore([structuredClone(task)], null);
  assert.equal(restored.task(task.taskId).state, "failed"); assert.equal(restored.task(task.taskId).pane, undefined);
  assert.ok(!h.fake.calls.some(a => ["start", "prompt", "close", "swap"].includes(a[1])));
});
test("replacement/moved/uncertain reservations are retained without adopting or controlling another occupant", async t => {
  for (const changed of ["terminal", "tab", "timeout", "uncertain-not-found"]) {
    const h = await managerSetup(t), m = h.create(), task = h.reservation(m), ref = structuredClone(task.pane);
    if (changed === "terminal") h.fake.panes.get(ref!.paneId)!.terminal_id = "replacement";
    if (changed === "tab") h.fake.panes.get(ref!.paneId)!.tab_id = "user-tab";
    if (changed === "timeout" || changed === "uncertain-not-found") h.fake.error = a => a[1] === "get" ? new HerdrError("uncertain", changed === "timeout" ? "cli_timeout" : "pane_not_found", true) : undefined;
    await m.status(task.taskId); assert.deepEqual(task.pane, ref);
    assert.equal(task.state, "collection_failed"); assert.ok(!h.fake.calls.some(a => ["close", "swap", "start", "prompt"].includes(a[1])));
  }
});
test("stop during foreground waiting prevents launch intent and further CLI requests", async t => {
  const h = await managerSetup(t), m = h.create(), task = h.reservation(m), ref = task.pane!;
  await m.layout.awaitShell(ref); h.fake.processInfo = () => busy(); let intent = false;
  const waiting = assert.rejects(m.layout.startAgent(ref, ["agent", "start", "never-sent"], async () => { intent = true; }), /Observer stopped/);
  await new Promise(r => setTimeout(r, 20)); await m.stop(); const count = h.fake.calls.length;
  await waiting; assert.equal(intent, false); assert.equal(h.fake.calls.length, count);
});
test("a missing worker in a pending frame is retained for explicit transaction reconciliation", async t => {
  const h = await managerSetup(t), m = h.create(), source = h.reservation(m);
  const persist = m.hooks.persist; let interrupted = false;
  m.hooks.persist = async task => { await persist(task); if (!interrupted && task.pane) { interrupted = true; throw new Error("attachment interrupted"); } };
  const b = await m.spawn("read only"); await eventually(() => m.task(b.taskId).state === "collection_failed");
  assert.ok(m.layout.pending); const id = source.pane!.paneId; h.remove(source); h.fake.error = undefined;
  const before = h.fake.calls.filter(a => ["split", "swap", "close", "start", "prompt"].includes(a[1])).length;
  const status = await m.status(source.taskId); assert.equal(status.paneId, id); assert.ok(m.layout.pending);
  assert.equal(h.fake.calls.filter(a => ["split", "swap", "close", "start", "prompt"].includes(a[1])).length, before);
});
