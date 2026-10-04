import test from "node:test";
import assert from "node:assert/strict";
import { Fake } from "./fake.ts";
import { HerdrError } from "../src/herdr.ts";
import { Layout, paneRef, type PaneRef } from "../src/layout.ts";
import { columns as layoutColumns, snapshot } from "../src/layout-geometry.ts";
function setup() { const fake = new Fake(); const layout = new Layout(fake, paneRef(fake.panes.get("principal")), async () => {}); return { fake, layout }; }
function check(fake: Fake, refs: PaneRef[]) {
  const data = fake.layout("original");
  const panes = data.panes as { pane_id: string; rect: { x: number; width: number; height: number } }[];
  assert.equal(panes.length, refs.length + 1);
  assert.equal(data.focused_pane_id, "principal");
  const main = panes.find(p => p.pane_id === "principal")!;
  assert.ok(Math.abs(main.rect.width - (refs.length ? 101.5 : 203)) <= 1); assert.equal(main.rect.height, 57);
  const columns = new Map<number, number[]>();
  for (const p of panes.filter(p => p.pane_id !== "principal")) columns.set(p.rect.x, [...(columns.get(p.rect.x) ?? []), p.rect.height]);
  assert.ok(columns.size >= Math.ceil(refs.length / 3) && columns.size <= Math.min(2, refs.length));
  for (const heights of columns.values()) { assert.ok(heights.length <= 3); assert.ok(Math.max(...heights) - Math.min(...heights) <= 1); }
  for (const ref of refs) assert.equal(fake.panes.get(ref.paneId)?.terminal_id, ref.terminalId);
  assert.equal(fake.tabs.size, 1, "no staging tabs left");
}
function* permutations(values: number[]): Generator<number[]> {
  if (!values.length) { yield []; return; }
  for (const value of values) for (const rest of permutations(values.filter(v => v !== value))) yield [value, ...rest];
}
test("BSP growth and all 720 deletion orders preserve identities and 50/50 geometry", async () => {
  for (const order of permutations([0, 1, 2, 3, 4, 5])) {
    const { fake, layout } = setup(), refs: PaneRef[] = [];
    for (let n = 0; n < 6; n++) { await layout.add(refs, "/test path", {}, async ref => { refs.push(ref); }); check(fake, refs); }
    const original = [...refs];
    for (const index of order) {
      const ref = original[index]; refs.splice(refs.indexOf(ref), 1);
      await layout.close(ref, refs); check(fake, refs);
    }
    assert.ok(fake.calls.every(a => !(a[0] === "layout" && a[1] === "apply")));
    assert.ok(fake.calls.filter(a => ["split", "move", "create"].includes(a[1])).every(a => a.includes("--no-focus")));
  }
});
test("refuse zoomed tab, principal replacement, moved or replaced children", async () => {
  const { fake, layout } = setup(); fake.zoomed = true;
  await assert.rejects(layout.add([], "/", {}, async () => {}), /Unzoom/);
  fake.zoomed = false;
  const refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
  fake.panes.get(refs[0].paneId)!.terminal_id = "replacement";
  await assert.rejects(layout.close(refs[0], []), /replaced/);
  assert.ok(fake.panes.has(refs[0].paneId));
  fake.panes.get("principal")!.terminal_id = "replacement";
  await assert.rejects(layout.checkTab([]), /Principal/);
});
test("mutating failure never falls back to layout.apply or closes workers", async () => {
  const { fake, layout } = setup(); const refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async r => { refs.push(r); });
  fake.afterError = args => args[1] === "split" ? new HerdrError("accepted mutation timeout", "cli_timeout", true) : undefined;
  await assert.rejects(layout.add(refs, "/", {}, async r => { refs.push(r); }), /timeout/);
  assert.equal(fake.panes.size, 3);
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0);
});

type Rect = { x: number; y: number; width: number; height: number };
type Tree = { pane: string } | { direction: string; ratio: number; left: Tree; right: Tree };
const arrangements = ["left", "right", "above", "below", "surrounded"] as const;
function externalSetup(arrangement: typeof arrangements[number]) {
  const { fake, layout } = setup();
  const external: string[] = [];
  const user = (): Tree => {
    const p = fake.newPane("original"), id = String(p.pane_id);
    external.push(id); return { pane: id };
  };
  const split = (direction: string, left: Tree, right: Tree, ratio = 0.3): Tree => ({ direction, ratio, left, right });
  let root: Tree = { pane: "principal" };
  if (arrangement === "left" || arrangement === "surrounded") root = split("right", user(), root);
  if (arrangement === "above" || arrangement === "surrounded") root = split("down", user(), root);
  if (arrangement === "right" || arrangement === "surrounded") root = split("right", root, user(), 0.7);
  if (arrangement === "below" || arrangement === "surrounded") root = split("down", root, user(), 0.7);
  fake.tabs.set("original", root);
  return { fake, layout, external };
}
function externalSnapshot(fake: Fake, external: string[]) {
  return external.map(id => ({ pane: { ...fake.panes.get(id) }, rect: fake.layout("original").panes.find(p => p.pane_id === id)!.rect }));
}
function regionCheck(fake: Fake, refs: PaneRef[], region: Rect, external: string[]) {
  const data = fake.layout("original"), main = data.panes.find(p => p.pane_id === "principal")!;
  assert.equal(data.panes.length, refs.length + external.length + 1);
  assert.equal(main.rect.x, region.x); assert.equal(main.rect.y, region.y);
  assert.equal(main.rect.height, region.height);
  assert.ok(Math.abs(main.rect.width - region.width / (refs.length ? 2 : 1)) <= 1);
  const columns = new Map<number, Rect[]>();
  for (const ref of refs) {
    const r = data.panes.find(p => p.pane_id === ref.paneId)!.rect;
    assert.equal(fake.panes.get(ref.paneId)?.terminal_id, ref.terminalId);
    assert.ok(r.x >= main.rect.x + main.rect.width);
    assert.ok(r.x + r.width <= region.x + region.width);
    columns.set(r.x, [...(columns.get(r.x) ?? []), r]);
  }
  assert.ok(columns.size >= Math.ceil(refs.length / 3) && columns.size <= Math.min(2, refs.length));
  for (const rows of columns.values()) {
    assert.ok(rows.length <= 3);
    assert.ok(Math.max(...rows.map(r => r.height)) - Math.min(...rows.map(r => r.height)) <= 1);
    assert.equal(Math.min(...rows.map(r => r.y)), region.y);
    assert.equal(rows.reduce((sum, r) => sum + r.height, 0), region.height);
    for (const r of rows) assert.ok(Math.abs(r.width - region.width / (columns.size * 2)) <= 1);
  }
  assert.equal(fake.tabs.size, 1, "staging disappears after assembly");
  assert.ok(fake.calls.every(a => !["split", "move", "close", "resize", "swap", "focus"].includes(a[1]) || !external.includes(a[2])), "no mutations target external panes");
}
test("existing user panes in any direction remain intact through local growth and deletion", async () => {
  for (const arrangement of arrangements) for (const order of [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [2, 5, 0, 4, 1, 3]]) {
    const { fake, layout, external } = externalSetup(arrangement), refs: PaneRef[] = [];
    const region = fake.layout("original").panes.find(p => p.pane_id === "principal")!.rect;
    const before = externalSnapshot(fake, external);
    for (let n = 0; n < 6; n++) {
      await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
      regionCheck(fake, refs, region, external); assert.deepEqual(externalSnapshot(fake, external), before);
    }
    const original = [...refs];
    for (const index of order) {
      const ref = original[index]; refs.splice(refs.indexOf(ref), 1);
      await layout.close(ref, refs);
      regionCheck(fake, refs, region, external); assert.deepEqual(externalSnapshot(fake, external), before);
    }
  }
});
test("the user's sidebar and six reference panes are not included in the principal's region", async () => {
  const { fake, layout } = setup(), refs: PaneRef[] = [], external: string[] = [];
  fake.area = { x: 0, y: 0, width: 185, height: 58 };
  const user = (): Tree => {
    const id = String(fake.newPane("original").pane_id); external.push(id); return { pane: id };
  };
  const split = (direction: string, ratio: number, left: Tree, right: Tree): Tree => ({ direction, ratio, left, right });
  const column = () => split("down", 0.65, split("down", 0.5, user(), user()), user());
  fake.tabs.set("original", split("right", 32 / 185, user(), split("right", 0.55, { pane: "principal" }, split("right", 0.5, column(), column()))));
  const region = fake.layout("original").panes.find(p => p.pane_id === "principal")!.rect;
  assert.deepEqual(region, { x: 32, y: 0, width: 84, height: 58 });
  const before = externalSnapshot(fake, external);
  for (let n = 0; n < 6; n++) {
    await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    regionCheck(fake, refs, region, external); assert.deepEqual(externalSnapshot(fake, external), before);
  }
  while (refs.length) {
    const [ref] = refs.splice(Math.floor(refs.length / 2), 1);
    await layout.close(ref, refs);
    regionCheck(fake, refs, region, external); assert.deepEqual(externalSnapshot(fake, external), before);
  }
});
test("local layout follows window resizing instead of frozen dimensions", async () => {
  const { fake, layout, external } = externalSetup("surrounded"), refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
  // Measure the expected local region from the same external BSP with no children.
  const expected = externalSetup("surrounded").fake;
  for (const area of [{ x: 4, y: 2, width: 317, height: 101 }, { x: 0, y: 0, width: 187, height: 73 }]) {
    fake.area = area; expected.area = area;
    const region = expected.layout("original").panes.find(p => p.pane_id === "principal")!.rect;
    const before = externalSnapshot(fake, external);
    await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    await layout.compact(refs);
    regionCheck(fake, refs, region, external); assert.deepEqual(externalSnapshot(fake, external), before);
  }
});
test("preserve principal, selected child and external focus during reassembly", async () => {
  for (const selection of ["principal", "child", "external"]) {
    const { fake, layout, external } = externalSetup("left"), refs: PaneRef[] = [];
    await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    fake.focus = selection === "child" ? refs[0].paneId : selection === "external" ? external[0] : "principal";
    const saved = fake.focus;
    await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    assert.equal(fake.focus, saved);
    await layout.compact(refs); assert.equal(fake.focus, saved);
  }
});
function mutations(fake: Fake) { return fake.calls.filter(a => ["split", "move", "create", "close", "resize", "swap", "set_split_ratio"].includes(a[1])); }
test("reject external panes inside the owned subtree before any mutation", async () => {
  for (const action of ["add", "compact", "close"]) {
    const { fake, layout } = setup(), refs: PaneRef[] = [];
    await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    const user = fake.newPane("original");
    fake.tabs.set("original", fake.insert(fake.tabs.get("original")!, refs[0].paneId, String(user.pane_id), "down", 0.5));
    const before = mutations(fake).length;
    await assert.rejects(action === "add" ? layout.add(refs, "/", {}, async () => {}) :
      action === "compact" ? layout.compact(refs) : layout.close(refs[0], []), /region|subtree/i);
    assert.equal(mutations(fake).length, before); assert.equal(fake.panes.size, 3);
  }
});
test("allow a new external sibling but reject a child relocated outside the owned region", async () => {
  const { fake, layout } = setup(), refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
  const user = fake.newPane("original"), id = String(user.pane_id);
  fake.tabs.set("original", { direction: "down", ratio: 0.7, left: fake.tabs.get("original")!, right: { pane: id } });
  await layout.compact(refs);
  const root = fake.remove(fake.tabs.get("original")!, refs[0].paneId)!;
  fake.tabs.set("original", fake.insert(root, id, refs[0].paneId, "right", 0.5));
  const before = mutations(fake).length;
  await assert.rejects(layout.compact(refs), /region|subtree/i);
  assert.equal(mutations(fake).length, before);
});
test("a rectangular union across separate user-owned subtrees is not a dedicated subtree", async () => {
  const { fake, layout } = setup(), refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
  const a = String(fake.newPane("original").pane_id), b = String(fake.newPane("original").pane_id);
  fake.tabs.set("original", { direction: "right", ratio: 0.5,
    left: { direction: "down", ratio: 0.5, left: { pane: a }, right: { pane: "principal" } },
    right: { direction: "down", ratio: 0.5, left: { pane: b }, right: { pane: refs[0].paneId } } });
  // The two bottom panes tile a rectangle with no foreign pane inside, but
  // staging the child would expand the user pane above it. No split owns that row.
  const before = fake.layout("original"), count = mutations(fake).length;
  await assert.rejects(layout.compact(refs), /dedicated BSP subtree/);
  assert.deepEqual(fake.layout("original"), before); assert.equal(mutations(fake).length, count);
});
test("owned same-tab recovery tolerates unrelated panes and keeps terminal identities", async () => {
  for (const mutationBeforeFailure of [0, 1]) {
    const { fake, layout, external } = externalSetup("left"), refs: PaneRef[] = [];
    for (let i = 0; i < 4; i++) await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    const before = externalSnapshot(fake, external);
    let mutating = 0;
    fake.error = args => ["split", "set_split_ratio"].includes(args[1]) && mutating++ === mutationBeforeFailure ? new HerdrError("interrupted birth", "pane_busy") : undefined;
    await assert.rejects(layout.add(refs, "/", {}, async ref => { refs.push(ref); }), /interrupted/);
    assert.ok(refs.every(ref => ref.tabId === "original" && !ref.staging));
    const saved = layout.state!;
    fake.error = undefined;
    const restored = new Layout(fake, paneRef(fake.panes.get("principal")), async () => {});
    restored.load(saved); await restored.recover(refs, false, async ref => { refs.push(ref); });
    assert.deepEqual(externalSnapshot(fake, external), before);
    for (const ref of refs) { assert.equal(ref.tabId, "original"); await layout.validate(ref); }
    assert.equal(fake.tabs.size, 1);
  }
});
test("mixed birth/close histories preserve column order and external panes without swaps", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { fake, layout, external } = externalSetup("surrounded"), refs: PaneRef[] = [];
    let random = seed, births = 0;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
    const current = () => layoutColumns(snapshot(fake.layout("original")).tree, "principal", refs.map(r => r.paneId)).columns.map(c => c.ids);
    for (let step = 0; step < 40; step++) {
      const before = current(), user = externalSnapshot(fake, external);
      let expected: string[][];
      if (!refs.length || refs.length < 6 && next() % 3 !== 0) {
        const ref = await layout.add(refs, "/test path", {}, async r => { refs.push(r); }); births++;
        if (!before.length) expected = [[ref.paneId]];
        else if (before.length === 1) expected = before[0].length === 1 ? [before[0], [ref.paneId]] : [[ref.paneId], before[0]];
        else {
          expected = before.map(col => [...col]);
          expected[before[0].length <= before[1].length ? 0 : 1].push(ref.paneId);
        }
      } else {
        const [ref] = refs.splice(next() % refs.length, 1);
        await layout.close(ref, refs);
        expected = before.map(col => col.filter(id => id !== ref.paneId)).filter(col => col.length);
      }
      assert.deepEqual(current(), expected); assert.deepEqual(externalSnapshot(fake, external), user);
      const region = layoutColumns(snapshot(fake.layout("original")).tree, "principal", refs.map(r => r.paneId));
      assert.ok(region.columns.every(col => col.ids.length <= 3));
      for (const ref of refs) assert.equal(fake.panes.get(ref.paneId)!.terminal_id, ref.terminalId);
    }
    assert.equal(fake.calls.filter(a => a[1] === "split").length, births);
    assert.ok(!fake.calls.some(a => ["swap", "move", "apply", "create"].includes(a[1])));
    while (refs.length) { const ref = refs.pop()!; await layout.close(ref, refs); }
  }
});
test("inconsistent layout responses fail closed before creating or moving panes", async () => {
  for (const corrupt of ["wrongTab", "wrongWorkspace", "missingPrincipal", "duplicate", "badRect", "missingChild", "missingSplits", "notSubtree", "overlap", "hole"]) {
    const { fake, layout } = setup(), refs: PaneRef[] = [];
    if (["missingChild", "missingSplits", "notSubtree", "overlap", "hole"].includes(corrupt)) await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
    const json = fake.json.bind(fake);
    fake.json = async (args, signal) => {
      const response = await json(args, signal);
      if (args[1] !== "layout") return response;
      const data = response.layout as ReturnType<Fake["layout"]>;
      if (corrupt === "wrongTab") data.tab_id = "other-tab";
      if (corrupt === "wrongWorkspace") data.workspace_id = "other-workspace";
      if (corrupt === "missingPrincipal") data.panes = data.panes.filter(p => p.pane_id !== "principal");
      if (corrupt === "duplicate") data.panes.push(data.panes[0]);
      if (corrupt === "badRect") data.panes[0].rect.width = NaN;
      if (corrupt === "missingChild") data.panes = data.panes.filter(p => p.pane_id !== refs[0].paneId);
      if (corrupt === "missingSplits") delete (data as { splits?: unknown }).splits;
      if (corrupt === "notSubtree") data.splits = [];
      if (corrupt === "overlap") data.panes[1].rect.x--;
      if (corrupt === "hole") data.panes[1].rect.width--;
      return response;
    };
    const before = mutations(fake).length;
    await assert.rejects(layout.add(refs, "/", {}, async () => {}), /layout|region|subtree/i);
    assert.equal(mutations(fake).length, before);
  }
});
