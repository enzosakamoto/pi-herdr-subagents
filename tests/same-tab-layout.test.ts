import test from "node:test";
import assert from "node:assert/strict";
import { Fake } from "./fake.ts";
import { Layout, paneRef, type PaneRef } from "../src/layout.ts";
import { HerdrError } from "../src/herdr.ts";
import { snapshot, plan } from "../src/layout-geometry.ts";
import { journalPlan, type LayoutState, type LayoutStore } from "../src/layout-state.ts";
import type { Task } from "../src/tasks.ts";

const mutates = (a: string[]) => ["split", "swap", "close", "set_split_ratio"].includes(a[1]);
function harness() {
  const fake = new Fake(), refs: PaneRef[] = [];
  const user = fake.newPane("original");
  fake.tabs.set("original", { direction: "right", ratio: 0.2, left: { pane: user.pane_id }, right: { pane: "principal" } });
  fake.focus = user.pane_id;
  let durable: LayoutState | undefined;
  const store: LayoutStore = { owner: "test-session", taskIds: () => ["test-branch"], persist: async state => { durable = structuredClone(state); } };
  const create = () => new Layout(fake, paneRef(fake.panes.get("principal")), async () => {}, store);
  const layout = create();
  const own = async (ref: PaneRef) => { if (!refs.some(p => p.paneId === ref.paneId)) refs.push(ref); };
  const seed = async (n: number) => { for (let i = 0; i < n; i++) await layout.add(refs, "/explicit-cwd", {}, own); };
  const verify = () => {
    assert.equal(plan(snapshot(fake.layout("original")).tree, "principal", refs.map(p => p.paneId), "compact").length, 0);
    assert.equal(fake.panes.size, refs.length + 2); assert.equal(fake.focus, user.pane_id);
    for (const r of refs) assert.equal(fake.panes.get(r.paneId)!.terminal_id, r.terminalId);
    assert.ok(!fake.calls.some(a => ["move", "create", "swap", "apply"].includes(a[1])));
    for (const a of fake.calls.filter(mutates)) assert.ok(!a.includes(user.pane_id));
  };
  return { fake, refs, user, store, create, layout, own, seed, verify, saved: () => structuredClone(durable!) };
}

test("every incremental mutation can explicitly fail and resume from its durable journal", async () => {
  for (const failing of [0, 1]) {
    const h = harness(); await h.seed(5); let index = 0;
    h.fake.error = a => mutates(a) && index++ === failing ? new HerdrError("explicit rejection", "pane_busy") : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /explicit rejection/);
    const saved = h.saved(); assert.ok(saved.record); assert.ok(h.layout.needsRecovery);
    h.fake.error = undefined;
    const restored = h.create(); restored.load(saved); await restored.recover(h.refs, false, h.own);
    assert.equal(restored.pending, false); assert.equal(h.refs.length, 6); h.verify();
  }
});
test("lost ratio acknowledgements are observed and never sent twice", async () => {
  for (const offlineAfter of [false, true]) {
    const h = harness(); await h.seed(4); let failed = false, offline = false;
    h.fake.afterError = a => {
      if (a[1] !== "set_split_ratio" || failed) return;
      failed = true; offline = offlineAfter; return new HerdrError("lost ratio response", "socket_timeout", true);
    };
    h.fake.error = a => offline && a[1] === "layout" ? new HerdrError("offline", "cli_timeout", true) : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /lost ratio/);
    const count = h.fake.calls.filter(a => a[1] === "set_split_ratio").length, saved = h.saved();
    h.fake.afterError = undefined; h.fake.error = undefined;
    const restored = h.create(); restored.load(saved); await restored.recover(h.refs, false, h.own);
    assert.equal(h.fake.calls.filter(a => a[1] === "set_split_ratio").length, count); h.verify();
  }
});
test("a completed close with lost acknowledgement is not repeated during compaction", async () => {
  const h = harness(); await h.seed(5); const [closed] = h.refs.splice(1, 1);
  h.fake.afterError = a => a[1] === "close" ? new HerdrError("lost close response", "cli_timeout", true) : undefined;
  await assert.rejects(h.layout.close(closed, h.refs), /lost close/);
  h.fake.afterError = undefined; await h.layout.compact(h.refs);
  assert.equal(h.fake.calls.filter(a => a[1] === "close" && a[2] === closed.paneId).length, 1); h.verify();
});
test("a lost split ID and an uncertain unapplied ratio stay pending without adoption/resend", async () => {
  for (const kind of ["split", "set_split_ratio"]) {
    const h = harness(); await h.seed(kind === "split" ? 1 : 4);
    if (kind === "split") h.fake.afterError = a => a[1] === kind ? new HerdrError("lost split ID", "cli_timeout", true) : undefined;
    else h.fake.error = a => a[1] === kind ? new HerdrError("unconfirmed ratio", "socket_timeout", true) : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own));
    const before = h.fake.layout("original"), count = h.fake.calls.filter(mutates).length, saved = h.saved();
    h.fake.afterError = undefined; h.fake.error = undefined;
    const restored = h.create(); restored.load(saved);
    await assert.rejects(restored.recover(h.refs, false, h.own), /subtree|uncertain|Uncertain/);
    assert.equal(h.fake.calls.filter(mutates).length, count); assert.deepEqual(h.fake.layout("original"), before); assert.ok(restored.pending);
  }
});
test("an acknowledged ratio that did not apply is not accepted as success", async () => {
  const h = harness(); await h.seed(4);
  h.fake.setSplitRatio = async () => ({ changed: false });
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /Uncertain/);
  assert.ok(h.layout.pending); assert.equal(h.refs.length, 4);
});
test("ratio-only compaction preserves every initial focus without transient selections", async () => {
  const h = harness(); await h.seed(4);
  for (const focused of ["principal", h.user.pane_id, ...h.refs.map(p => p.paneId)]) {
    h.fake.focus = focused; h.fake.focusHistory = [];
    const root = h.fake.tabs.get("original")!;
    if ("pane" in root || "pane" in root.right) throw new Error("missing region");
    root.right.ratio = 0.55;
    await h.layout.compact(h.refs);
    assert.equal(h.fake.focus, focused); assert.deepEqual(h.fake.focusHistory, []);
  }
});
test("an observed external focus selection pauses remaining mutations and is not overwritten", async () => {
  const h = harness(); await h.seed(4); h.fake.focus = "principal";
  h.fake.afterError = a => { if (a[1] === "set_split_ratio") h.fake.focus = h.user.pane_id; return undefined; };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /Focus changed externally/);
  assert.equal(h.fake.focus, h.user.pane_id); assert.ok(h.layout.pending);
  h.fake.afterError = undefined; await h.layout.recover(h.refs, true, h.own); h.verify();
});
test("too-small transition refuses before a split; shrink during birth retains its journal", async () => {
  const h = harness(); await h.seed(3); h.fake.area.width = 12;
  const before = h.fake.calls.filter(mutates).length;
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /too small/);
  assert.equal(h.fake.calls.filter(mutates).length, before); assert.equal(h.layout.pending, false);
  h.fake.area.width = 203;
  h.fake.afterError = a => { if (a[1] === "split") h.fake.area.width = 12; return undefined; };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /too small/);
  assert.ok(h.layout.pending); assert.equal(h.fake.calls.filter(mutates).length, before + 1);
  h.fake.afterError = undefined; h.fake.area.width = 203;
  await h.layout.recover(h.refs, false, h.own); h.verify();
});
test("a new reserve occupied or replaced after a crash never permits another mutation", async () => {
  for (const changed of ["terminal", "agent", "foreground", "shellExec"]) {
    const h = harness(); await h.seed(1);
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, async () => { throw new Error("attachment interrupted"); }));
    const saved = h.saved(), reserve = saved.record!.reserve!;
    if (changed === "terminal") h.fake.panes.get(reserve.paneId)!.terminal_id = "replacement";
    if (changed === "agent") h.fake.panes.get(reserve.paneId)!.agent = "pi";
    if (changed === "foreground") h.fake.error = a => a[1] === "process-info" && a.includes(reserve.paneId) ? new HerdrError("foreground changed", "process_changed") : undefined;
    if (changed === "shellExec") h.fake.processInfo = id => ({ shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: id === reserve.paneId ? "zsh" : "bash", argv0: "/bin/bash", argv: ["/bin/bash"] }] });
    const count = h.fake.calls.filter(mutates).length, restored = h.create(); restored.load(saved);
    await assert.rejects(restored.recover(h.refs, false, h.own));
    assert.equal(h.fake.calls.filter(mutates).length, count); assert.ok(h.fake.panes.has(reserve.paneId));
  }
});
test("journal provenance, active branch, v1 and deterministic history fail closed", async () => {
  const h = harness(); await h.seed(4);
  h.fake.error = a => a[1] === "split" ? new HerdrError("refused", "pane_busy") : undefined;
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own)); h.fake.error = undefined;
  const saved = h.saved(), count = h.fake.calls.filter(mutates).length;
  for (const corrupt of ["owner", "principal", "history", "existingShell", "version"]) {
    const state = structuredClone(saved), r = state.record!;
    if (corrupt === "owner") r.owner = "other-session";
    if (corrupt === "principal") r.principal.terminalId = "another-terminal";
    if (corrupt === "history") r.next = 0;
    if (corrupt === "existingShell") r.reserve = paneRef(h.fake.panes.get(h.user.pane_id));
    if (corrupt === "version") (r as { version: number }).version = 1;
    assert.throws(() => h.create().load(state));
  }
  const other = new Layout(h.fake, paneRef(h.fake.panes.get("principal")), async () => {}, { ...h.store, taskIds: () => ["other-branch"] });
  assert.throws(() => other.load(saved), /active branch/); assert.equal(h.fake.calls.filter(mutates).length, count);
});
test("tab-created sidebar hooks and pre-existing staging sidebars remain untouched", async () => {
  const h = harness(); h.fake.sidebarOnTabCreation = true;
  const old = h.fake.newPane("legacy-staging"); h.fake.tabs.set("legacy-staging", { pane: old.pane_id });
  const before = h.fake.layout("legacy-staging"); await h.seed(6);
  while (h.refs.length) { const ref = h.refs.pop()!; await h.layout.close(ref, h.refs); }
  assert.equal(h.fake.tabCreatedHooks, 0); assert.equal(h.fake.tabs.size, 2); assert.deepEqual(h.fake.layout("legacy-staging"), before);
  assert.ok(!h.fake.calls.some(a => mutates(a) && a.includes(old.pane_id)));
});
test("an external matching ratio during intent persistence is not adopted or resent", async () => {
  const h = harness(); await h.seed(4); const persist = h.store.persist; let changed = false;
  h.store.persist = async state => {
    await persist(state); const r = state.record;
    if (!changed && r?.intent) {
      const op = journalPlan(r)[r.next];
      if (op.kind === "ratio") { changed = true; await h.fake.setSplitRatio("original", op.path, op.ratio); }
    }
  };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /before the recorded command was sent/);
  assert.equal(h.fake.calls.filter(a => a[1] === "set_split_ratio").length, 1);
  const restored = h.create(); restored.load(h.saved());
  await assert.rejects(restored.recover(h.refs, false, h.own), /after a rejected operation/);
  assert.equal(h.fake.calls.filter(a => a[1] === "set_split_ratio").length, 1); assert.ok(restored.pending);
});
test("external single-pane tab focus is preserved without creating a tab", async () => {
  const h = harness(); await h.seed(1);
  const p = h.fake.newPane("external-tab"); h.fake.tabs.set("external-tab", { pane: p.pane_id }); h.fake.focus = p.pane_id;
  const before = h.fake.layout("external-tab"); await h.layout.add(h.refs, "/explicit-cwd", {}, h.own);
  assert.equal(h.fake.focus, p.pane_id); assert.deepEqual(h.fake.layout("external-tab"), before); assert.equal(h.fake.tabCreatedHooks, 0);
});
test("plugin insertion during a ratio change halts without controlling the new pane", async () => {
  const h = harness(); await h.seed(4); let inserted: string | undefined;
  h.fake.afterError = a => {
    if (a[1] === "set_split_ratio" && !inserted) {
      inserted = h.fake.newPane("original").pane_id;
      h.fake.tabs.set("original", h.fake.insert(h.fake.tabs.get("original")!, "principal", inserted!, "down", 0.5));
    }
    return undefined;
  };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /subtree|topology/);
  assert.ok(h.layout.pending); assert.ok(h.fake.panes.has(inserted!));
  assert.ok(!h.fake.calls.some(a => mutates(a) && a.includes(inserted!)));
});
test("a selected completed child falls back to principal if native close selects a survivor", async () => {
  const h = harness(); await h.seed(3); const closed = h.refs.pop()!; h.fake.focus = closed.paneId;
  h.fake.afterError = a => { if (a[1] === "close") h.fake.focus = h.refs[0].paneId; return undefined; };
  await h.layout.close(closed, h.refs); assert.equal(h.fake.focus, "principal"); assert.ok(!h.fake.panes.has(closed.paneId));
  h.fake.focus = h.user.pane_id; h.verify();
});
test("legacy cross-tab children are preserved and never moved", async () => {
  const h = harness(); await h.seed(1); const ref = h.refs[0];
  h.fake.tabs.set("original", h.fake.remove(h.fake.tabs.get("original")!, ref.paneId)!);
  h.fake.tabs.set("legacy-staging", { pane: ref.paneId }); h.fake.panes.get(ref.paneId)!.tab_id = "legacy-staging"; ref.tabId = "legacy-staging"; ref.staging = true;
  const count = h.fake.calls.filter(mutates).length;
  await assert.rejects(h.layout.compact(h.refs), /Legacy staging/); assert.equal(h.fake.calls.filter(mutates).length, count);
});
test("close revalidates a target replaced during durable intent persistence", async () => {
  const h = harness(); await h.seed(2); const closed = h.refs.pop()!;
  const count = h.fake.calls.filter(a => a[1] === "close").length;
  await assert.rejects(h.layout.close(closed, h.refs, async () => {}, async () => {}, async attempted => {
    if (attempted) h.fake.panes.get(closed.paneId)!.terminal_id = "replacement";
  }), /replaced/);
  assert.equal(h.fake.calls.filter(a => a[1] === "close").length, count); assert.ok(h.fake.panes.has(closed.paneId));
});
test("close does not overwrite a survivor selected during intent persistence", async () => {
  const h = harness(); await h.seed(2); const closed = h.refs.pop()!; h.fake.focus = closed.paneId;
  await h.layout.close(closed, h.refs, async () => {}, async () => {}, async attempted => {
    if (attempted) h.fake.focus = h.refs[0].paneId;
  });
  assert.equal(h.fake.focus, h.refs[0].paneId); assert.deepEqual(h.fake.focusHistory, []);
});
test("acknowledged split remains recoverable after a certain shell-inspection error", async () => {
  const h = harness();
  h.fake.error = a => a[1] === "process-info" ? new HerdrError("inspection unavailable", "process_info_unavailable") : undefined;
  await assert.rejects(h.layout.add(h.refs, "/", {}, h.own), /inspection unavailable/);
  const saved = h.saved(); assert.notEqual(saved.record!.intent?.rejected, true); assert.ok(saved.record!.reserve);
  h.fake.error = undefined; const restored = h.create(); restored.load(saved); await restored.recover(h.refs, false, h.own);
  assert.equal(h.fake.calls.filter(a => a[1] === "split").length, 1); h.verify();
});
test("a fresh split response from the wrong branch is not attached to a task", async () => {
  const h = harness(); await h.seed(1); const json = h.fake.json.bind(h.fake);
  h.fake.json = async (a, signal) => {
    const result = await json(a, signal);
    if (a[1] === "split") {
      const foreign = h.fake.newPane("original");
      h.fake.tabs.set("original", h.fake.insert(h.fake.tabs.get("original")!, "principal", foreign.pane_id, "down", 0.5));
      return { pane: foreign };
    }
    return result;
  };
  await assert.rejects(h.layout.add(h.refs, "/", {}, h.own), /subtree|topology/);
  assert.equal(h.refs.length, 1); assert.ok(h.layout.pending);
});
test("splitting beside a working agent does not require or probe its shell foreground", async () => {
  const h = harness(); await h.seed(1); const ref = h.refs[0];
  Object.assign(ref, { agentName: "worker", sessionPath: "/own-session" });
  Object.assign(h.fake.panes.get(ref.paneId)!, { agent: "pi", name: "worker", agent_status: "working", agent_session: { kind: "path", value: "/own-session" } });
  h.fake.agents.set("worker", { pane: ref.paneId, task: {} as Task }); h.fake.processInfoQueries.clear();
  await h.layout.add(h.refs, "/explicit-cwd", {}, h.own);
  assert.equal(h.fake.processInfoQueries.get(ref.paneId), undefined); assert.equal(h.fake.panes.get(ref.paneId)!.agent_status, "working"); h.verify();
});
