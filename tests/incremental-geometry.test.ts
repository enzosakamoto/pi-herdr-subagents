import test from "node:test";
import assert from "node:assert/strict";
import { plan, apply, columns, cells, remove, preflight, type Tree } from "../src/layout-geometry.ts";

function grow(tree: Tree, ids: string[], id: string) {
  const ops = plan(tree, "main", ids, "add", id);
  assert.equal(ops.filter(o => o.kind === "split").length, 1);
  preflight(tree, { x: 0, y: 0, width: 195, height: 60 }, ops, ["main", ...ids, id]);
  return ops.reduce(apply, tree);
}
function compact(tree: Tree, ids: string[]) { return plan(tree, "main", ids, "compact").reduce(apply, tree); }
function check(tree: Tree, ids: string[]) {
  const area = { x: 0, y: 0, width: 195, height: 60 }, rects = cells(tree, area), cs = columns(tree, "main", ids).columns;
  assert.ok(Math.abs(rects.get("main")!.width - area.width / (ids.length ? 2 : 1)) <= 1);
  for (const col of cs) {
    const heights = col.ids.map(id => rects.get(id)!.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1);
    assert.ok(col.ids.length <= 3);
  }
  assert.deepEqual([...rects.keys()].sort(), ["main", ...ids].sort());
}

test("incremental births reproduce alternating columns with one split per child", () => {
  let tree: Tree = { pane: "main" }; const ids: string[] = [];
  for (let i = 1; i <= 6; i++) { tree = grow(tree, ids, String(i)); ids.push(String(i)); check(tree, ids); }
  assert.deepEqual(columns(tree, "main", ids).columns.map(c => c.ids), [["1", "3", "5"], ["2", "4", "6"]]);
});
test("local removal preserves each column and reopening adds a new left column", () => {
  for (const empty of [["1", "3", "5"], ["2", "4", "6"]]) {
    let tree: Tree = { pane: "main" }, ids: string[] = [];
    for (let i = 1; i <= 6; i++) { tree = grow(tree, ids, String(i)); ids.push(String(i)); }
    for (const id of empty) { tree = remove(tree, id)!; ids = ids.filter(v => v !== id); tree = compact(tree, ids); check(tree, ids); }
    assert.equal(columns(tree, "main", ids).columns.length, 1);
    const existing = columns(tree, "main", ids).columns[0].ids;
    tree = grow(tree, ids, "7"); ids.push("7"); check(tree, ids);
    assert.deepEqual(columns(tree, "main", ids).columns.map(c => c.ids), [["7"], existing]);
    tree = grow(tree, ids, "8"); ids.push("8"); tree = grow(tree, ids, "9"); ids.push("9"); check(tree, ids);
    assert.deepEqual(columns(tree, "main", ids).columns.map(c => c.ids), [["7", "8", "9"], existing]);
  }
});
test("two columns remain two columns after partial removal even with only two children", () => {
  let tree: Tree = { pane: "main" }, ids: string[] = [];
  for (let i = 1; i <= 4; i++) { tree = grow(tree, ids, String(i)); ids.push(String(i)); }
  for (const id of ["1", "4"]) { tree = remove(tree, id)!; ids = ids.filter(v => v !== id); tree = compact(tree, ids); }
  check(tree, ids);
  assert.deepEqual(columns(tree, "main", ids).columns.map(c => c.ids), [["3"], ["2"]]);
});
test("ratio paths are confined to the owned subtree with external panes", () => {
  let local: Tree = { pane: "main" }; const ids: string[] = [];
  for (let i = 1; i <= 4; i++) { local = grow(local, ids, String(i)); ids.push(String(i)); }
  const tree: Tree = { direction: "down", ratio: 0.2, left: { pane: "user" }, right: local };
  const ops = plan(tree, "main", ids, "add", "5");
  assert.ok(ops.filter(o => o.kind === "ratio").every(o => o.kind === "ratio" && o.path[0] === true));
  assert.equal(cells(ops.reduce(apply, tree), { x: 0, y: 0, width: 195, height: 60 }).get("user")!.height, 12);
});
test("preflight balances before splitting a bottom row to avoid unnecessarily short panes", () => {
  let tree: Tree = { pane: "main" }; const ids: string[] = [];
  for (let i = 1; i <= 4; i++) { tree = grow(tree, ids, String(i)); ids.push(String(i)); }
  const ops = plan(tree, "main", ids, "add", "5");
  preflight(tree, { x: 0, y: 0, width: 100, height: 9 }, ops, ["main", ...ids, "5"]);
  assert.throws(() => preflight(tree, { x: 0, y: 0, width: 100, height: 8 }, ops, ["main", ...ids, "5"]), /too small/);
});
test("planner rejects invalid child topology, foreign membership and seventh children", () => {
  assert.throws(() => plan({ direction: "down", ratio: 0.5, left: { pane: "main" }, right: { pane: "1" } }, "main", ["1"], "add", "2"), /topology/);
  assert.throws(() => plan({ direction: "right", ratio: 0.5, left: { pane: "main" }, right: { pane: "user" } }, "main", ["1"], "compact"), /missing/);
  let tree: Tree = { pane: "main" }; const ids: string[] = [];
  for (let i = 1; i <= 6; i++) { tree = grow(tree, ids, String(i)); ids.push(String(i)); }
  assert.throws(() => plan(tree, "main", ids, "add", "7"), /six/);
});
