import test from "node:test";
import assert from "node:assert/strict";
import { Fake } from "./fake.ts";
import { Layout, paneRef, type PaneRef } from "../src/layout.ts";
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
  assert.equal(columns.size, refs.length > 3 ? 2 : refs.length ? 1 : 0);
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
test("refuse unmanaged/zoomed tab, principal replacement, moved or replaced children", async () => {
  const { fake, layout } = setup(); fake.zoomed = true;
  await assert.rejects(layout.add([], "/", {}, async () => {}), /Unzoom/);
  fake.zoomed = false;
  const refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async ref => { refs.push(ref); });
  await assert.rejects(layout.add([], "/", {}, async () => {}), /unmanaged/);
  fake.panes.get(refs[0].paneId)!.terminal_id = "replacement";
  await assert.rejects(layout.close(refs[0], []), /replaced/);
  assert.ok(fake.panes.has(refs[0].paneId));
  fake.panes.get("principal")!.terminal_id = "replacement";
  await assert.rejects(layout.checkTab([]), /Principal/);
});
test("mutating failure never falls back to layout.apply or closes workers", async () => {
  const { fake, layout } = setup(); const refs: PaneRef[] = [];
  await layout.add(refs, "/", {}, async r => { refs.push(r); });
  fake.error = args => args[1] === "move" ? new Error("accepted mutation timeout") : undefined;
  await assert.rejects(layout.add(refs, "/", {}, async r => { refs.push(r); }), /timeout/);
  assert.equal(fake.panes.size, 3);
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0);
});
