import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import extension, { outputSchema } from "../src/extension.ts";
import { Fake, eventually } from "./fake.ts";
import { zeroUsage } from "../src/results.ts";

test("pi lifecycle: deferred follow-up admission gates closure; one-time usage and branch reconciliation", async t => {
  const root = await mkdtemp(join(tmpdir(), "hs-extension-"));
  const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "principal";
  const fake = new Fake(), session = SessionManager.inMemory("/", { id: "parent" });
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
  const ctx = { cwd: "/", mode: "json", hasUI: false, model: { provider: "test", id: "model" }, thinkingLevel: "high", sessionManager: session } as unknown as ExtensionToolContext;
  t.after(async () => {
    await handlers.get("session_shutdown")!();
    for (const key of ["HERDR_ENV", "HERDR_PANE_ID"] as const) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  });
  extension(api, () => fake, root);
  await handlers.get("session_start")!({}, ctx);
  const run = async (args: unknown) => {
    const result = await tool.execute("call", args, undefined, undefined, ctx);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    return result.structuredContent as Record<string, any>;
  };
  const spawn = await run({ action: "spawn", task: "investigate without writing" });
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
});
