import test from "node:test";
import assert from "node:assert/strict";
import { Fake } from "./fake.ts";
import { Layout, paneRef, type PaneRef } from "../src/layout.ts";
import { HerdrError } from "../src/herdr.ts";
import { snapshot, region, equalTree, settled, operations } from "../src/layout-geometry.ts";
import type { LayoutState, LayoutStore } from "../src/layout-state.ts";

const mutates = (a: string[]) => a[0] === "pane" && ["split", "swap", "close"].includes(a[1]);
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
    const s = snapshot(fake.layout("original"));
    assert.ok(equalTree(region(s.tree, ["principal", ...refs.map(p => p.paneId)], s.area).tree, settled("principal", refs.map(p => p.paneId))));
    assert.equal(fake.panes.size, refs.length + 2); assert.equal(fake.focus, user.pane_id);
    for (const r of refs) assert.equal(fake.panes.get(r.paneId)!.terminal_id, r.terminalId);
    assert.ok(!fake.calls.some(a => a[1] === "move" || a[1] === "create" || a[0] === "layout"));
    for (const a of fake.calls.filter(mutates)) assert.ok(!a.includes(user.pane_id));
  };
  return { fake, refs, user, store, create, layout, own, seed, verify, saved: () => structuredClone(durable!) };
}

test("every reconstruction mutation can explicitly fail and resume from its durable journal", async () => {
  for (let failing = 0; failing < operations(6, 5).length; failing++) {
    const h = harness(); await h.seed(5);
    let index = 0;
    h.fake.error = a => mutates(a) && index++ === failing ? new HerdrError("explicit rejection", "pane_busy") : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /explicit rejection/);
    const saved = h.saved(); assert.ok(saved.record); assert.ok(h.layout.needsRecovery);
    h.fake.error = undefined;
    const restored = h.create(); restored.load(saved); await restored.recover(h.refs, false, h.own);
    assert.equal(restored.pending, false); assert.equal(h.refs.length, 6); h.verify();
  }
});
test("lost swap acknowledgements are observed and never reversed by another swap", async () => {
  for (const crashBeforeObservation of [false, true]) {
    const h = harness(); await h.seed(2);
    let failedSource: string | undefined, offline = false;
    h.fake.afterError = a => {
      if (a[1] !== "swap" || failedSource) return;
      failedSource = a[a.indexOf("--source-pane") + 1]; offline = crashBeforeObservation;
      return new HerdrError("lost swap response", "cli_timeout", true);
    };
    h.fake.error = a => offline && a[1] === "layout" ? new HerdrError("offline", "cli_timeout", true) : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /lost swap/);
    const before = h.fake.calls.filter(a => a[1] === "swap" && a.includes(failedSource!)).length;
    const saved = h.saved(); h.fake.afterError = undefined; h.fake.error = undefined;
    const restored = h.create(); restored.load(saved); await restored.recover(h.refs, false, h.own);
    assert.equal(h.fake.calls.filter(a => a[1] === "swap" && a.includes(failedSource!)).length, before);
    h.verify();
  }
});
test("an auxiliary close accepted without its response is confirmed, never repeated", async () => {
  const h = harness(); await h.seed(3); let closed: string | undefined, offline = false;
  h.fake.afterError = a => {
    if (a[1] !== "close" || closed) return;
    closed = a[2]; offline = true; return new HerdrError("lost close response", "cli_timeout", true);
  };
  h.fake.error = a => offline && a[1] === "layout" ? new HerdrError("offline", "cli_timeout", true) : undefined;
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /lost close/);
  const saved = h.saved(); h.fake.afterError = undefined; h.fake.error = undefined;
  const restored = h.create(); restored.load(saved); await restored.recover(h.refs, false, h.own);
  assert.equal(h.fake.calls.filter(a => a[1] === "close" && a[2] === closed).length, 1); h.verify();
});
test("a lost split ID and an uncertain unapplied swap stay pending without adoption/resend", async () => {
  for (const kind of ["split", "swap"]) {
    const h = harness(); await h.seed(1);
    if (kind === "split") h.fake.afterError = a => a[1] === kind ? new HerdrError("lost split ID", "cli_timeout", true) : undefined;
    else h.fake.error = a => a[1] === kind ? new HerdrError("unconfirmed swap", "cli_timeout", true) : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own));
    const before = h.fake.layout("original"), count = h.fake.calls.filter(mutates).length;
    const saved = h.saved(); h.fake.afterError = undefined; h.fake.error = undefined;
    const restored = h.create(); restored.load(saved);
    await assert.rejects(restored.recover(h.refs, false, h.own), /subtree|uncertain|Uncertain/);
    assert.equal(h.fake.calls.filter(mutates).length, count); assert.deepEqual(h.fake.layout("original"), before);
    assert.ok(restored.pending);
  }
});
test("changed:false is rejection, not a successful transfer", async () => {
  const h = harness(); await h.seed(1); h.fake.swapChangedFalse = true;
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /Swap did not apply/);
  assert.ok(h.saved().record?.intent?.rejected); assert.ok(h.layout.pending);
  h.fake.swapChangedFalse = false; await h.layout.recover(h.refs); h.verify();
});
test("native swaps transiently select surviving children and restore each initial selection", async () => {
  const h = harness(); await h.seed(4);
  for (const focused of ["principal", h.user.pane_id, ...h.refs.map(p => p.paneId)]) {
    h.fake.focus = focused; h.fake.focusHistory = [];
    // A fresh compaction from a deliberately uneven but still owned tree.
    const root = h.fake.tabs.get("original")!;
    if ("pane" in root || "pane" in root.right) throw new Error("missing region");
    root.right.ratio = 0.55;
    await h.layout.compact(h.refs);
    assert.equal(h.fake.focus, focused);
    assert.ok(h.refs.every(p => h.fake.focusHistory.includes(p.paneId)));
    assert.equal(h.fake.focusHistory.at(-1), focused);
  }
});
test("an observed external focus selection pauses mutations and is not overwritten", async () => {
  const h = harness(); await h.seed(2);
  h.fake.focus = "principal";
  let once = false;
  h.fake.afterError = a => { if (a[1] === "swap" && !once) { once = true; h.fake.focus = h.user.pane_id; } return undefined; };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /Focus changed externally/);
  assert.equal(h.fake.focus, h.user.pane_id); assert.ok(h.layout.pending);
  h.fake.afterError = undefined; await h.layout.recover(h.refs, true); h.verify();
});
test("too-small transition refuses before a split; a shrink during assembly preserves pending panes", async () => {
  const h = harness(); await h.seed(3); h.fake.area.width = 24;
  const before = h.fake.calls.filter(mutates).length;
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /too small/);
  assert.equal(h.fake.calls.filter(mutates).length, before); assert.equal(h.layout.pending, false);
  h.fake.area.width = 203;
  let once = false;
  h.fake.afterError = a => { if (a[1] === "split" && !once) { once = true; h.fake.area.width = 24; } return undefined; };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /too small/);
  assert.ok(h.layout.pending); assert.equal(h.fake.calls.filter(mutates).length, before + 1);
  h.fake.afterError = undefined; h.fake.area.width = 203;
  await h.layout.recover(h.refs, false, h.own); h.verify();
});
test("an auxiliary occupied or replaced after a crash is never closed", async () => {
  for (const changed of ["terminal", "agent", "foreground", "shellExec"]) {
    const h = harness(); await h.seed(2);
    h.fake.error = a => a[1] === "close" ? new HerdrError("refused", "pane_busy") : undefined;
    await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own));
    const saved = h.saved(), helper = saved.record!.slots[0]!;
    h.fake.error = undefined;
    if (changed === "terminal") h.fake.panes.get(helper.paneId)!.terminal_id = "replacement";
    if (changed === "agent") h.fake.panes.get(helper.paneId)!.agent = "pi";
    if (changed === "foreground") h.fake.error = a => a[1] === "process-info" && a.includes(helper.paneId) ? new HerdrError("foreground changed", "process_changed") : undefined;
    if (changed === "shellExec") {
      const json = h.fake.json.bind(h.fake);
      h.fake.json = async (a, signal) => {
        const r = await json(a, signal);
        if (a[1] === "process-info" && a.includes(helper.paneId)) (r.process_info as { foreground_processes: { name: string }[] }).foreground_processes[0].name = "zsh";
        return r;
      };
    }
    const before = h.fake.calls.filter(mutates).length, restored = h.create(); restored.load(saved);
    await assert.rejects(restored.recover(h.refs));
    assert.equal(h.fake.calls.filter(mutates).length, before); assert.ok(h.fake.panes.has(helper.paneId));
  }
});
test("journal provenance, active branch and deterministic operation history fail closed", async () => {
  const h = harness(); await h.seed(1);
  h.fake.error = a => a[1] === "swap" ? new HerdrError("refused", "pane_busy") : undefined;
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own)); h.fake.error = undefined;
  const saved = h.saved(), count = h.fake.calls.filter(mutates).length;
  for (const corrupt of ["owner", "principal", "history", "existingShell", "version"]) {
    const state = structuredClone(saved), r = state.record!;
    if (corrupt === "owner") r.owner = "other-session";
    if (corrupt === "principal") r.principal.terminalId = "another-terminal";
    if (corrupt === "history") r.next = 0;
    if (corrupt === "existingShell") r.slots[0] = paneRef(h.fake.panes.get(h.user.pane_id));
    if (corrupt === "version") (r as { version: number }).version = 2;
    assert.throws(() => h.create().load(state));
  }
  const otherBranch = new Layout(h.fake, paneRef(h.fake.panes.get("principal")), async () => {}, { ...h.store, taskIds: () => ["other-branch"] });
  assert.throws(() => otherBranch.load(saved), /active branch/);
  assert.equal(h.fake.calls.filter(mutates).length, count);
});
test("tab-created sidebar hooks and pre-existing sidebar-only staging tabs stay untouched", async () => {
  const h = harness(); h.fake.sidebarOnTabCreation = true;
  const oldSidebar = h.fake.newPane("legacy-staging"); h.fake.tabs.set("legacy-staging", { pane: oldSidebar.pane_id });
  const before = h.fake.layout("legacy-staging"); await h.seed(6);
  while (h.refs.length) { const ref = h.refs.pop()!; await h.layout.close(ref, h.refs); }
  assert.equal(h.fake.tabCreatedHooks, 0); assert.equal(h.fake.tabs.size, 2);
  assert.deepEqual(h.fake.layout("legacy-staging"), before);
  assert.ok(!h.fake.calls.some(a => mutates(a) && a.includes(oldSidebar.pane_id)));
});
test("an external matching swap during intent persistence is neither reversed nor adopted as our success", async () => {
  const h = harness(); await h.seed(1); const persist = h.store.persist; let changed = false;
  h.store.persist = async state => {
    await persist(state);
    const r = state.record;
    if (!changed && r?.intent && operations(r.count, r.workers.length)[r.next]?.kind === "swap") {
      changed = true;
      await h.fake.json(["pane", "swap", "--source-pane", r.workers[0].paneId, "--target-pane", r.slots[0]!.paneId]);
    }
  };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /before the recorded command was sent/);
  assert.equal(h.fake.calls.filter(a => a[1] === "swap").length, 1);
  const restored = h.create(); restored.load(h.saved());
  await assert.rejects(restored.recover(h.refs), /after a rejected operation/);
  assert.equal(h.fake.calls.filter(a => a[1] === "swap").length, 1); assert.ok(restored.pending);
});
test("initial focus in an external single-pane tab is restored without creating any tab", async () => {
  const h = harness(); await h.seed(1);
  const p = h.fake.newPane("external-tab"); h.fake.tabs.set("external-tab", { pane: p.pane_id }); h.fake.focus = p.pane_id;
  const before = h.fake.layout("external-tab"); await h.layout.add(h.refs, "/explicit-cwd", {}, h.own);
  assert.equal(h.fake.focus, p.pane_id); assert.deepEqual(h.fake.layout("external-tab"), before);
  assert.equal(h.fake.tabCreatedHooks, 0); assert.ok(!h.fake.calls.some(a => mutates(a) && a.includes(p.pane_id)));
});
test("plugin insertion during a swap halts without controlling the new pane", async () => {
  const h = harness(); await h.seed(2); let inserted: string | undefined;
  h.fake.afterError = a => {
    if (a[1] === "swap" && !inserted) {
      const p = h.fake.newPane("original"); inserted = p.pane_id;
      h.fake.tabs.set("original", h.fake.insert(h.fake.tabs.get("original")!, "principal", inserted, "down", 0.5));
    }
    return undefined;
  };
  await assert.rejects(h.layout.add(h.refs, "/explicit-cwd", {}, h.own), /subtree|topology|Unexpected swap response/);
  assert.ok(h.layout.pending); assert.ok(h.fake.panes.has(inserted!));
  assert.ok(!h.fake.calls.some(a => mutates(a) && a.includes(inserted!)));
});
test("a selected completed child falls back to principal even if native close selects another survivor", async () => {
  const h = harness(); await h.seed(3); const closed = h.refs.pop()!;
  h.fake.focus = closed.paneId;
  h.fake.afterError = a => { if (a[1] === "close" && a[2] === closed.paneId) h.fake.focus = h.refs[0].paneId; return undefined; };
  await h.layout.close(closed, h.refs);
  assert.equal(h.fake.focus, "principal"); assert.ok(!h.fake.panes.has(closed.paneId));
  h.fake.focus = h.user.pane_id; h.verify();
});
test("legacy cross-tab child records are preserved, never moved into the principal tab", async () => {
  const h = harness(); await h.seed(1); const ref = h.refs[0];
  h.fake.tabs.set("original", h.fake.remove(h.fake.tabs.get("original")!, ref.paneId)!);
  h.fake.tabs.set("legacy-staging", { pane: ref.paneId });
  h.fake.panes.get(ref.paneId)!.tab_id = "legacy-staging"; ref.tabId = "legacy-staging"; ref.staging = true;
  const count = h.fake.calls.filter(mutates).length;
  await assert.rejects(h.layout.compact(h.refs), /Legacy staging/);
  assert.equal(h.fake.calls.filter(mutates).length, count); assert.ok(h.fake.panes.has(ref.paneId));
});
