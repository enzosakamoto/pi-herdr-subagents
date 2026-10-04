import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import extension, { outputSchema } from "../src/extension.ts";
import { Fake, eventually } from "./fake.ts";
import { zeroUsage } from "../src/results.ts";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hs-extension-"));
  const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "principal";
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true }); await mkdir(agentDir);
  const fake = new Fake(), session = SessionManager.inMemory(cwd, { id: "parent" });
  const handlers = new Map<string, Function>(), sent: Record<string, unknown>[] = [];
  let tool!: ToolDefinition;
  const api = {
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data); },
    sendMessage: (message: Record<string, unknown>, options: { deliverAs: string; triggerTurn: boolean }) => {
      assert.equal(options.deliverAs, "followUp"); assert.equal(options.triggerTurn, true); sent.push(message);
    }
  } as unknown as ExtensionAPI;
  const knownModels = new Set(["test/model", "test/cheap", "test/general", "test/deep", "router/vendor/model", "test/new"]);
  const ctx = { cwd, mode: "json", hasUI: false, model: { provider: "test", id: "model" }, thinkingLevel: "high", sessionManager: session,
    modelRegistry: { find: (provider: string, id: string) => knownModels.has(provider + "/" + id) ? { provider, id } : undefined }
  } as unknown as ExtensionToolContext;
  t.after(async () => {
    await handlers.get("session_shutdown")!();
    for (const key of ["HERDR_ENV", "HERDR_PANE_ID"] as const) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  });
  extension(api, () => fake, join(root, "tasks"), agentDir);
  await handlers.get("session_start")!({}, ctx);
  const run = async (args: unknown) => {
    const result = await tool.execute("call", args, undefined, undefined, ctx);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    const data = result.structuredContent as Record<string, any>;
    assert.equal(!!result.isError, !!data.error);
    return data;
  };
  return { root, cwd, agentDir, fake, session, handlers, sent, ctx, run, tool };
}

test("pi lifecycle with user pane: deferred closure, one-time usage and branch reconciliation", async t => {
  const { fake, session, handlers, sent, ctx, run } = await setup(t);
  const user = fake.newPane("original"), userId = String(user.pane_id);
  fake.tabs.set("original", { direction: "right", ratio: 0.2, left: { pane: userId }, right: fake.tabs.get("original")! });
  fake.focus = userId;
  const userBefore = fake.layout("original").panes.find(p => p.pane_id === userId)!;
  const spawn = await run({ action: "spawn", task: "investigate without writing" });
  assert.equal(spawn.task.model, "test/model"); assert.equal(spawn.task.tier, "medium"); assert.equal(spawn.task.modelSource, "inherited");
  assert.equal(spawn.task.thinking, "high", "no configuration inherits thinking");
  await eventually(() => !!fake.agents.get(spawn.task.agentName)?.prompt);
  await fake.complete(spawn.task.agentName);
  await eventually(() => sent.length === 1);
  assert.equal(fake.calls.filter(a => a[1] === "close").length, 0, "queued message is not delivery");
  assert.equal((await run({ action: "status", taskId: spawn.task.taskId })).task.state, "completed");
  const waited = await run({ action: "wait", taskId: spawn.task.taskId, timeoutMs: 1 });
  assert.equal(waited.task.timedOut, false, "persisted result resolves wait before follow-up admission/closure");
  const message = sent[0];
  session.appendCustomMessageEntry(String(message.customType), message.content as string, true, message.details);
  await handlers.get("message_end")!({ message: { role: "custom", ...message } }, ctx);
  await eventually(() => fake.calls.filter(a => a[1] === "close").length === 1);
  const usage = await handlers.get("tool_result")!({ usage: zeroUsage(), details: { retained: "renderer data" } }, ctx);
  assert.equal(usage.usage.totalTokens, 30); assert.equal(usage.details.retained, "renderer data");
  assert.deepEqual(usage.details.herdrSubagentUsageTaskIds, [spawn.task.taskId]);
  assert.equal(await handlers.get("tool_result")!({ details: {} }, ctx), undefined);
  session.appendMessage({ role: "toolResult", toolName: "herdr_subagent", toolCallId: "usage-call", content: [], details: usage.details, usage: usage.usage, timestamp: Date.now(), isError: false });
  await handlers.get("session_start")!({}, ctx);
  assert.equal(sent.length, 1, "reload does not notify already-delivered task again");
  assert.equal(await handlers.get("tool_result")!({ details: {} }, ctx), undefined, "accounting reconstructed from persisted branch");
  const deduped = await handlers.get("context")!({ messages: [{ role: "custom", ...message }, { role: "custom", ...message }] }, ctx);
  assert.equal(deduped.messages.length, 1);
  session.resetLeaf();
  await handlers.get("session_tree")!({}, ctx);
  assert.deepEqual((await run({ action: "list" })).tasks, [], "abandoned branch tasks are not adopted");
  const filtered = await handlers.get("context")!({ messages: [{ role: "custom", ...message }] }, ctx);
  assert.equal(filtered.messages.length, 0, "stale outbox content does not enter another branch context");
  assert.deepEqual(fake.layout("original").panes.find(p => p.pane_id === userId), userBefore);
  assert.equal(fake.panes.get(userId)?.terminal_id, user.terminal_id);
  assert.equal(fake.focus, userId);
  assert.equal(fake.calls.filter(a => a[1] === "close" && a[2] === userId).length, 0);
});

test("configured tiers and explicit overrides are snapshotted concurrently and survive reload", async t => {
  const { root, cwd, agentDir, fake, run, ctx, handlers, sent } = await setup(t);
  await writeFile(join(agentDir, "herdr-subagents.json"), JSON.stringify({ models: {
    low: { model: "test/cheap", thinking: null },
    medium: { model: "test/general", thinking: "low" }, high: "test/deep"
  } }));
  const projectPath = join(cwd, ".pi", "herdr-subagents.json");
  await writeFile(projectPath, JSON.stringify({ models: { medium: { model: "router/vendor/model", thinking: "medium" } } }));
  const pending = Promise.all([
    run({ action: "spawn", task: "run tests", tier: "low" }),
    run({ action: "spawn", task: "map flow" }),
    run({ action: "spawn", task: "review invariants", tier: "high" }),
    run({ action: "spawn", task: "user-selected model", model: "test/new" })
  ]);
  ctx.thinkingLevel = "low"; // Change during config I/O, before reservation.
  const [a, b, c, d] = await pending;
  const tasks = [a, b, c, d].map(result => result.task);
  await writeFile(projectPath, JSON.stringify({ defaultTier: "low", models: { low: { model: "test/new", thinking: "xhigh" } } }));
  await eventually(() => tasks.every(task => !!fake.agents.get(task.agentName)?.prompt));
  for (const [i, expected] of ["test/cheap", "router/vendor/model", "test/deep", "test/new"].entries()) {
    const task = tasks[i];
    assert.equal(task.model, expected); assert.equal(task.tier, ["low", "medium", "high", undefined][i]);
    assert.equal(task.modelSource, i === 3 ? "explicit" : "tier");
    const args = fake.calls.find(args => args[1] === "start" && args[2] === task.agentName)!;
    assert.equal(args[args.indexOf("--model") + 1], expected);
    const expectedThinking = ["off", "medium", "high", "high"][i];
    assert.equal(task.thinking, expectedThinking);
    assert.equal(args[args.indexOf("--thinking") + 1], expectedThinking);
    const persisted = JSON.parse(await readFile(join(root, "tasks", "parent", task.taskId, "task.json"), "utf8"));
    assert.equal(persisted.model, expected); assert.equal(persisted.tier, task.tier); assert.equal(persisted.modelSource, task.modelSource);
    assert.equal(persisted.thinking, expectedThinking);
  }
  await handlers.get("session_start")!({}, ctx);
  const listed = (await run({ action: "list" })).tasks;
  for (const task of tasks) {
    const restored = listed.find((entry: any) => entry.taskId === task.taskId);
    assert.deepEqual([restored.model, restored.tier, restored.modelSource, restored.thinking], [task.model, task.tier, task.modelSource, task.thinking]);
  }
  assert.equal(fake.calls.filter(args => args[1] === "start").length, 4, "reload does not restart children");
  for (const task of tasks) {
    const status = (await run({ action: "status", taskId: task.taskId })).task;
    assert.equal(status.model, task.model); assert.equal(status.thinking, task.thinking);
    const waited = (await run({ action: "wait", taskId: task.taskId, timeoutMs: 1 })).task;
    assert.equal(waited.modelSource, task.modelSource); assert.equal(waited.thinking, task.thinking);
    await fake.complete(task.agentName);
  }
  await eventually(() => sent.length === 4);
  for (const task of tasks) {
    const message = sent.find(message => (message.details as { taskId: string }).taskId === task.taskId)!;
    assert.ok(String(message.content).includes(`"model":"${task.model}"`));
    assert.ok(String(message.content).includes(`"modelSource":"${task.modelSource}"`));
    assert.ok(String(message.content).includes(`"thinking":"${task.thinking}"`));
  }
  const next = await run({ action: "spawn", task: "new default" });
  assert.equal(next.task.model, "test/new"); assert.equal(next.task.tier, "low");
  await eventually(() => !!fake.agents.get(next.task.agentName)?.prompt);
  const args = fake.calls.find(args => args[1] === "start" && args[2] === next.task.agentName)!;
  assert.equal(next.task.thinking, "xhigh");
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
});

test("invalid configuration/model requests reserve no tasks and open no panes", async t => {
  const { cwd, fake, run, ctx } = await setup(t);
  const path = join(cwd, ".pi", "herdr-subagents.json");
  const initialCalls = fake.calls.length;
  for (const [config, request, expected] of [
    ["{", { model: "test/cheap" }, /Invalid subagent configuration/],
    [JSON.stringify({ models: { low: "test/cheap" } }), {}, /No model configured for tier "medium"/],
    [JSON.stringify({ models: { medium: "test/unknown" } }), {}, /Unknown chat model/],
    [JSON.stringify({ models: { medium: { model: "test/general", thinking: "auto" } } }), {}, /thinking must be/],
    [JSON.stringify({ models: { medium: { model: "test/general", thinking: false } } }), { model: "test/new" }, /thinking must be/],
    [JSON.stringify({ models: { medium: { thinking: null } } }), {}, /model must be/],
    ["{}", { tier: "low", model: "test/cheap" }, /mutually exclusive/],
    ["{}", { model: "cheap" }, /exact provider/],
    ["{}", { model: "test/cheap\n" }, /exact provider/],
    ["{}", { model: "test/unknown" }, /Unknown chat model/],
    ["{}", { tier: "fast" }, /tier must be/]
  ] as const) {
    await writeFile(path, config);
    const result = await run({ action: "spawn", task: "invalid", ...request });
    assert.match(result.error, expected);
  }
  await rm(path); await mkdir(path);
  assert.match((await run({ action: "spawn", task: "unreadable" })).error, /Cannot read/);
  await rm(path, { recursive: true });
  ctx.model = undefined;
  assert.match((await run({ action: "spawn", task: "no model" })).error, /Select a principal model/);
  assert.deepEqual((await run({ action: "list" })).tasks, []);
  assert.equal(fake.calls.length, initialCalls, "even CLI pane mutations are skipped");
});

test("explicit/configured models work without a principal model; unconfigured tier inherits visibly", async t => {
  const { cwd, fake, run, ctx } = await setup(t);
  const pending = run({ action: "spawn", task: "tests", tier: "low" });
  ctx.model = undefined; // A changed selection during I/O cannot alter the original call.
  const inherited = await pending;
  assert.equal(inherited.task.modelSource, "inherited"); assert.equal(inherited.task.model, "test/model");
  assert.equal(inherited.task.tier, "low");
  const explicit = await run({ action: "spawn", task: "explicit", model: "router/vendor/model" });
  assert.equal(explicit.task.modelSource, "explicit"); assert.equal(explicit.task.tier, undefined);
  await writeFile(join(cwd, ".pi", "herdr-subagents.json"), JSON.stringify({ models: { medium: "test/general" } }));
  const configured = await run({ action: "spawn", task: "configured" });
  assert.equal(configured.task.modelSource, "tier"); assert.equal(configured.task.model, "test/general");
  await eventually(() => [inherited, explicit, configured].every(result => !!fake.agents.get(result.task.agentName)?.prompt));
});

test("omitted profile thinking inherits caller and defaults off without a caller level", async t => {
  const { cwd, run, fake, ctx } = await setup(t);
  await writeFile(join(cwd, ".pi", "herdr-subagents.json"), JSON.stringify({ models: {
    low: { model: "test/cheap", thinking: "off" },
    medium: { model: "test/general" },
    high: { model: "test/deep", thinking: null }
  } }));
  const inherited = await run({ action: "spawn", task: "flow" });
  assert.equal(inherited.task.thinking, "high");
  Object.assign(ctx, { thinkingLevel: undefined });
  const [omitted, explicit, off] = await Promise.all([
    run({ action: "spawn", task: "no caller level" }),
    run({ action: "spawn", task: "explicit model", model: "test/deep" }),
    run({ action: "spawn", task: "explicit off", tier: "low" })
  ]);
  for (const result of [omitted, explicit, off]) assert.equal(result.task.thinking, "off");
  await eventually(() => [inherited, omitted, explicit, off].every(result => !!fake.agents.get(result.task.agentName)?.prompt));
  for (const result of [inherited, omitted, explicit, off]) {
    const args = fake.calls.find(args => args[1] === "start" && args[2] === result.task.agentName)!;
    assert.equal(args[args.indexOf("--thinking") + 1], result.task.thinking);
  }
});

test("child handshake reports the actual startup model without registering delegation", async t => {
  const root = await mkdtemp(join(tmpdir(), "hs-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_HERDR_SUBAGENT;
  const handlers = new Map<string, Function>();
  process.env.PI_HERDR_SUBAGENT = JSON.stringify({ taskId: "task", sessionId: "child", directory: root });
  try {
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler),
      registerTool: () => assert.fail("children cannot delegate") } as unknown as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env.PI_HERDR_SUBAGENT; else process.env.PI_HERDR_SUBAGENT = previous;
  }
  const ctx = { mode: "tui", model: { provider: "router", id: "vendor/model" }, sessionManager: {
    getSessionId: () => "child", getSessionFile: () => join(root, "session.jsonl"), getLeafId: () => null
  } };
  await handlers.get("session_start")!({}, ctx);
  const ready = JSON.parse(await readFile(join(root, "ready.json"), "utf8"));
  assert.equal(ready.model, "router/vendor/model"); assert.equal(ready.taskId, "task");
  await handlers.get("agent_settled")!({}, ctx);
  const settled = JSON.parse(await readFile(join(root, "settled.json"), "utf8"));
  assert.equal(settled.model, ready.model);
});

test("session changes during config I/O cannot reserve work in either session", async t => {
  const { run, handlers, fake } = await setup(t);
  const spawning = run({ action: "spawn", task: "stale" });
  await handlers.get("session_shutdown")!();
  assert.match((await spawning).error, /Session changed/);
  assert.equal(fake.calls.filter(args => args[1] === "start" || args[1] === "split").length, 0);
});
