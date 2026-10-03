import assert from "node:assert/strict";
import { Herdr, object } from "../src/herdr.ts";
import { Layout, paneRef, type PaneRef } from "../src/layout.ts";

if (process.env.HERDR_LIVE_TEST !== "1") throw new Error("Opt-in only: HERDR_LIVE_TEST=1 npm run test:live. Creates an isolated named server/session.");
const session = process.env.HERDR_TEST_SESSION ?? "pi-herdr-subagents-test-20261003";
const cli = new Herdr(process.env, undefined, ["--session", session]);
// This session must already be running; tests never start/stop/upgrade a server.
const created = await cli.json(["workspace", "create", "--label", "hs-layout-verification", "--cwd", process.cwd(), "--no-focus"]);
const principal = paneRef(created.root_pane);
const layout = new Layout(cli, principal, async () => {});
const refs: PaneRef[] = [];
const pids = new Map<string, number>();
async function geometry(n: number) {
  const snapshot = object((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout, "layout");
  assert.equal(snapshot.zoomed, false);
  assert.equal(snapshot.focused_pane_id, principal.paneId);
  const area = object(snapshot.area, "area");
  const panes = (snapshot.panes as Record<string, unknown>[]).map(p => ({ id: p.pane_id, rect: object(p.rect, "rect") }));
  const main = panes.find(p => p.id === principal.paneId)!;
  assert.equal(panes.length, n + 1);
  assert.ok(Math.abs(Number(main.rect.width) - Number(area.width) / (n ? 2 : 1)) <= 1);
  assert.equal(main.rect.height, area.height);
  const children = panes.filter(p => p.id !== principal.paneId);
  const columns = new Map<number, typeof children>();
  for (const p of children) { const x = Number(p.rect.x); columns.set(x, [...(columns.get(x) ?? []), p]); }
  assert.equal(columns.size, n ? n > 3 ? 2 : 1 : 0);
  for (const col of columns.values()) {
    assert.ok(col.length <= 3);
    assert.ok(Math.max(...col.map(p => Number(p.rect.height))) - Math.min(...col.map(p => Number(p.rect.height))) <= 1);
  }
  for (const ref of refs) {
    await layout.validate(ref);
    const pid = pids.get(ref.terminalId);
    if (pid) { process.kill(pid, 0); const text = await cli.text(["pane", "read", ref.paneId, "--source", "recent-unwrapped", "--lines", "20"]); assert.ok(text.includes("HS_PID:" + pid)); }
  }
}
try {
  for (let n = 1; n <= 6; n++) {
    await layout.serial.run(async () => { await layout.add(refs, process.cwd(), {}, async ref => { refs.push(ref); }); });
    const ref = refs.at(-1)!;
    await cli.text(["pane", "run", ref.paneId, "python3 -c 'import os,time; print(\"HS_PID:\"+str(os.getpid()),flush=True); time.sleep(180)'"]);
    await cli.json(["pane", "wait-output", ref.paneId, "--regex", "HS_PID:[0-9]+", "--timeout", "5000"]);
    const text = await cli.text(["pane", "read", ref.paneId, "--source", "recent-unwrapped", "--lines", "20"]);
    const match = text.match(/HS_PID:(\d+)/);
    assert.ok(match); pids.set(ref.terminalId, Number(match[1]));
    await geometry(n);
    console.log("live growth", n, "PASS; processes preserved");
  }
  // Preserve a user-selected, live child as well as principal focus.
  await cli.json(["tab", "focus", principal.tabId]);
  await cli.json(["pane", "focus", "--pane", principal.paneId, "--direction", "right"]);
  const before = object((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout, "layout");
  const focusedChild = String(before.focused_pane_id);
  assert.notEqual(focusedChild, principal.paneId);
  await layout.serial.run(() => layout.compact(refs));
  const after = object((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout, "layout");
  assert.equal(after.focused_pane_id, focusedChild);
  console.log("live selected-child focus restoration PASS");
  await cli.json(["pane", "focus", "--pane", focusedChild, "--direction", "left"]);
  await geometry(refs.length);
  // Arbitrary removals while survivor terminal identities stay unchanged.
  for (const index of [2, 3, 0, 1, 0, 0]) {
    const [ref] = refs.splice(index, 1);
    await layout.serial.run(() => layout.close(ref, refs));
    await geometry(refs.length);
    console.log("live compact", refs.length, "PASS");
  }
} finally {
  // Only this test's owned workspace. No user workspace/pane/session is touched.
  await cli.json(["workspace", "close", principal.workspaceId]);
}
