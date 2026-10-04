import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr, object, string } from "../src/herdr.ts";
import { Layout, paneRef, type PaneRef } from "../src/layout.ts";
import { snapshot, region, columns, plan } from "../src/layout-geometry.ts";

if (process.env.HERDR_LIVE_TEST !== "1") throw new Error("Opt-in only: creates owned panes in an already running isolated named Herdr session.");
const session = process.env.HERDR_TEST_SESSION, socket = process.env.HERDR_TEST_SOCKET;
if (!session || session === "default" || !socket || socket === process.env.HERDR_SOCKET_PATH) throw new Error("Require an isolated HERDR_TEST_SESSION and its explicit HERDR_TEST_SOCKET, different from the caller socket.");
const cli = new Herdr(process.env, undefined, ["--session", session], socket);
const evidence = await mkdtemp(join(tmpdir(), "hs-incremental-live-"));
const integration = process.env.HERDR_PI_INTEGRATION ?? join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
// Confirm that native mutations and CLI discovery select the same isolated endpoint.
const registry = JSON.parse(await cli.text(["session", "list", "--json"]));
assert.ok(registry.sessions.some((s: { name: string; socket_path: string; running: boolean }) => s.name === session && s.socket_path === socket && s.running));
const created = await cli.json(["workspace", "create", "--label", "hs-incremental-verification", "--cwd", process.cwd(), "--no-focus"]);
const external = paneRef(created.root_pane);
const principal = paneRef((await cli.json(["pane", "split", external.paneId, "--direction", "right", "--ratio", "0.2", "--cwd", process.cwd(), "--no-focus"])).pane);
const mutations: string[][] = [];
const control = {
  json: (args: string[], signal?: AbortSignal, timeout?: number) => { if (["split", "swap", "move", "close", "apply"].includes(args[1])) mutations.push(args); return cli.json(args, signal, timeout); },
  text: cli.text.bind(cli),
  setSplitRatio: (tab: string, path: boolean[], ratio: number, signal?: AbortSignal, timeout?: number) => {
    mutations.push(["layout", "set_split_ratio", tab, JSON.stringify(path), String(ratio)]);
    return cli.setSplitRatio(tab, path, ratio, signal, timeout);
  }
};
const layout = new Layout(control, principal, async () => {}), refs: PaneRef[] = [];
const processes = new Map<string, number>(), snapshots: unknown[] = [];
let births = 0, success = false, expectedFocus: string;
await cli.json(["tab", "focus", principal.tabId]);
async function select(id: string) {
  const raw = object((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout, "layout");
  if (raw.focused_pane_id !== id) {
    let found = false;
    for (const pane of raw.panes as { pane_id: string }[]) {
      if (pane.pane_id === id) continue;
      for (const direction of ["left", "right", "up", "down"]) {
        const n = object((await cli.json(["pane", "neighbor", "--pane", pane.pane_id, "--direction", direction])).neighbor, "neighbor");
        if (n.neighbor_pane_id !== id) continue;
        const focus = object((await cli.json(["pane", "focus", "--pane", pane.pane_id, "--direction", direction])).focus, "focus");
        assert.equal(focus.focused_pane_id, id); found = true; break;
      }
      if (found) break;
    }
    assert.ok(found, "a proven neighbor can select the owned test target");
  }
  expectedFocus = id;
}
await select(principal.paneId);
const initial = snapshot((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout);
const externalRects = [...initial.panes].filter(([id]) => id !== principal.paneId);
const externalRefs = await Promise.all(externalRects.map(async ([id]) => paneRef((await cli.json(["pane", "get", id])).pane)));
async function check(label: string) {
  const raw = (await cli.json(["pane", "layout", "--pane", principal.paneId])).layout, s = snapshot(raw);
  const ids = refs.map(p => p.paneId), local = region(s.tree, [principal.paneId, ...ids], s.area), main = s.panes.get(principal.paneId)!;
  assert.equal(plan(s.tree, principal.paneId, ids, "compact").length, 0);
  assert.ok(Math.abs(main.width - local.rect.width / (ids.length ? 2 : 1)) <= 1);
  for (const [id, rect] of externalRects) assert.deepEqual(s.panes.get(id), rect);
  for (const ref of externalRefs) assert.deepEqual(paneRef((await cli.json(["pane", "get", ref.paneId])).pane), ref);
  assert.equal(s.panes.size, refs.length + initial.panes.size);
  assert.equal((raw as { focused_pane_id: string }).focused_pane_id, expectedFocus);
  for (const col of columns(s.tree, principal.paneId, ids).columns) {
    const heights = col.ids.map(id => s.panes.get(id)!.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1);
  }
  for (const ref of refs) {
    await layout.validate(ref);
    const info = object((await cli.json(["pane", "process-info", "--pane", ref.paneId])).process_info, "process info");
    assert.equal(info.foreground_process_group_id, processes.get(ref.terminalId));
    process.kill(processes.get(ref.terminalId)!, 0);
  }
  snapshots.push({ label, layout: raw }); console.log(label, "PASS; identities, PIDs, ratios and focus preserved");
}
async function add() {
  const ref = await layout.serial.run(() => layout.add(refs, process.cwd(), {}, async ref => { refs.push(ref); }));
  births++;
  const name = "hs-live-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  // Idle supported pi TUIs give real agent/session/process identities, without model prompts.
  await cli.json(["agent", "start", name, "--kind", "pi", "--pane", ref.paneId, "--",
    "--no-extensions", "--extension", integration, "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools", "--no-approve", "--offline",
    "--session-dir", join(evidence, name), "--provider", process.env.PI_PROVIDER ?? "openai-codex", "--model", process.env.PI_MODEL ?? "gpt-6.1-sol", "--thinking", "off"]);
  const agent = object((await cli.json(["agent", "get", name])).agent, "agent"), identity = object(agent.agent_session, "agent session");
  ref.agentName = name;
  if (identity.kind === "path") ref.sessionPath = string(identity.value, "session path");
  else if (identity.kind === "id") ref.sessionId = string(identity.value, "session id");
  else throw new Error("Missing supported pi session identity.");
  const info = object((await cli.json(["pane", "process-info", "--pane", ref.paneId])).process_info, "process info");
  assert.ok(typeof info.foreground_process_group_id === "number" && info.foreground_process_group_id > 0);
  processes.set(ref.terminalId, Number(info.foreground_process_group_id));
  return ref;
}
async function close(id: string) {
  const index = refs.findIndex(p => p.paneId === id); assert.ok(index >= 0);
  const [ref] = refs.splice(index, 1);
  await layout.serial.run(() => layout.close(ref, refs));
  if (expectedFocus === id) expectedFocus = principal.paneId;
}
try {
  for (let n = 1; n <= 6; n++) { await add(); await check("live growth " + n); }
  const tree = snapshot((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout).tree;
  const initialColumns = columns(tree, principal.paneId, refs.map(r => r.paneId)).columns;
  assert.deepEqual(initialColumns.map(c => c.ids), [[refs[0].paneId, refs[2].paneId, refs[4].paneId], [refs[1].paneId, refs[3].paneId, refs[5].paneId]]);
  await select(refs[0].paneId);
  await layout.compact(refs); await check("live selected child focus");
  // Empty the selected child's column; survivors expand without changing vertical order.
  for (const id of initialColumns[0].ids.slice().reverse()) { await close(id); await check("live close left column " + refs.length); }
  const surviving = initialColumns[1].ids;
  await add(); await check("live reopen beside three survivors");
  const reopened = columns(snapshot((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout).tree, principal.paneId, refs.map(r => r.paneId)).columns;
  assert.deepEqual(reopened.map(c => c.ids), [[refs.at(-1)!.paneId], surviving]);
  // Close the new column, leave two existing rows, and repeat the reopen.
  await close(refs.at(-1)!.paneId); await close(surviving[1]); await check("live collapse with two survivors");
  await select(external.paneId);
  await add(); await check("live reopen beside two survivors with external focus");
  while (refs.length < 6) { await add(); await check("live regrowth " + refs.length); }
  while (refs.length) { await close(refs[Math.floor(refs.length / 2)].paneId); await check("live cleanup " + refs.length); }
  assert.equal(mutations.filter(a => a[1] === "split").length, births);
  assert.ok(!mutations.some(a => ["swap", "move", "apply"].includes(a[1])));
  success = true;
  console.log("Live incremental layout PASS; one split per child, no model prompts, swaps or auxiliary panes");
} finally {
  await writeFile(join(evidence, "verification.json"), JSON.stringify({ session, socket, workspace: principal.workspaceId, success, births, mutations, snapshots }, null, 2), { mode: 0o600 });
  if (success) await cli.json(["workspace", "close", principal.workspaceId]);
  else console.log("Preserved owned test workspace for diagnosis:", principal.workspaceId);
  console.log("Evidence directory:", evidence);
}
