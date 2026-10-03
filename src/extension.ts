import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Herdr, type Control } from "./herdr.ts";
import { paneRef } from "./layout.ts";
import { Tasks, view, type Task } from "./tasks.ts";
import { atomicJson, addUsage, zeroUsage, type Receipt } from "./results.ts";

const STATE = "herdr-subagents:task";
const MESSAGE = "herdr-subagents:result";
const ACCOUNTING = "herdrSubagentUsageTaskIds";
export const parameters = Type.Union([
  Type.Object({ action: Type.Literal("spawn"), task: Type.String({ minLength: 1, maxLength: 100000 }), instructions: Type.Optional(Type.String({ maxLength: 100000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel"), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("wait"), taskId: Type.String({ minLength: 1 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000, default: 120000 })) }, { additionalProperties: false })
]);
const usageSchema = Type.Object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number(),
  reasoning: Type.Optional(Type.Number()), cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number() })
});
const taskSchema = Type.Object({
  taskId: Type.String(), state: Type.Union(["starting", "working", "blocked", "collecting", "completed", "failed", "cancelled", "collection_failed", "cleanup_pending"].map(s => Type.Literal(s))),
  agentName: Type.String(), paneId: Type.Optional(Type.String()), diagnostic: Type.Optional(Type.String()),
  resultPath: Type.Optional(Type.String()), timedOut: Type.Optional(Type.Boolean()),
  result: Type.Optional(Type.Object({ text: Type.String(), stopReason: Type.String(), error: Type.Optional(Type.String()), usage: usageSchema, truncated: Type.Boolean() }))
});
export const outputSchema = Type.Object({ task: Type.Optional(taskSchema), tasks: Type.Optional(Type.Array(taskSchema)), error: Type.Optional(Type.String()) }, { additionalProperties: false });

export default function extension(pi: ExtensionAPI, createControl: () => Control = () => new Herdr(), storageRoot = join(getAgentDir(), "herdr-subagents")) {
  const marker = process.env.PI_HERDR_SUBAGENT;
  if (marker) {
    // No delegation tool is registered in children, even through codemode.
    let child: { taskId: string; sessionId: string; directory: string } | undefined;
    try { child = JSON.parse(marker); } catch { return; }
    const report = async (ctx: ExtensionContext, settled: boolean) => {
      if (!child || ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== child.sessionId) return;
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath) return;
      const receipt: Receipt = { taskId: child.taskId, sessionId: child.sessionId, sessionPath, leafId: ctx.sessionManager.getLeafId() };
      await atomicJson(join(child.directory, settled ? "settled.json" : "ready.json"), receipt);
    };
    pi.on("session_start", async (_event, ctx) => { await report(ctx, false); });
    pi.on("agent_settled", async (_event, ctx) => { await report(ctx, true); });
    let blocks = 0;
    const reportBlock = async (ctx: ExtensionContext, title?: string) => {
      if (!child || ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== child.sessionId) return;
      await atomicJson(join(child.directory, "blocked.json"), { taskId: child.taskId, sessionId: child.sessionId,
        sessionPath: ctx.sessionManager.getSessionFile(), active: blocks > 0, title: title?.slice(0, 200) });
    };
    pi.on("ui_prompt_start", async (event, ctx) => { blocks++; await reportBlock(ctx, event.title); });
    pi.on("ui_prompt_end", async (event, ctx) => { blocks = Math.max(0, blocks - 1); await reportBlock(ctx, event.title); });
    return;
  }
  let manager: Tasks | undefined;
  let generation = 0;
  const charged = new Set<string>();
  const queued = new Set<string>();
  const stop = async () => { generation++; const old = manager; manager = undefined; await old?.stop(); };
  const activate = async (ctx: ExtensionContext) => {
    await stop();
    charged.clear();
    queued.clear();
    if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
    const localGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const current = paneRef((await createControl().json(["pane", "current", "--current"])).pane);
    const records = new Map<string, Task>();
    const delivered = new Set<string>();
    const attentionDelivered = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE) {
        const task = entry.data as Task;
        if (task?.taskId) records.set(task.taskId, structuredClone(task));
      } else if (entry.type === "custom_message" && entry.customType === MESSAGE) {
        const data = entry.details as { taskId?: string; attention?: boolean };
        if (data?.taskId) { if (data.attention) attentionDelivered.add(data.taskId); else delivered.add(data.taskId); }
      } else if (entry.type === "message" && entry.message.role === "toolResult") {
        const details = entry.message.details;
        const ids = details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>)[ACCOUNTING] : undefined;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") charged.add(id);
      }
    }
    for (const task of records.values()) {
      task.notified = delivered.has(task.taskId);
      task.attentionSent = attentionDelivered.has(task.taskId);
    }
    const valid = () => localGeneration === generation;
    const updateUI = () => {
      if (valid() && ctx.mode === "tui" && manager) {
        const tasks = [...manager.tasks.values()];
        const active = tasks.filter(t => t.pane || t.state === "starting").length;
        ctx.ui.setStatus("herdr-subagents", active ? "Herdr children: " + active + "/6" : undefined);
      }
    };
    const created = new Tasks(createControl(), current, join(storageRoot, sessionId), {
      cwd: ctx.cwd, model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : "", thinking: ctx.thinkingLevel ?? "off",
      packagePath: resolve(dirname(fileURLToPath(import.meta.url)), "..")
    }, {
      persist: async task => { if (valid()) { pi.appendEntry(STATE, task); updateUI(); } },
      notify: async (task, attention) => {
        if (!valid()) throw new Error("Stale session callback; notification was not delivered.");
        const key = task.taskId + (attention ? ":attention" : ":result");
        if (queued.has(key)) return false;
        queued.add(key);
        const data = view(task);
        pi.sendMessage({
          customType: MESSAGE, display: true, details: { taskId: task.taskId, attention },
          content: "[herdr-subagent:" + task.taskId + "] " + (attention ? "Attention required; retain the pane. " : "Result persisted. ") +
            JSON.stringify(data) + (attention ? "" : "\nFull outcome: " + task.resultPath)
        }, { deliverAs: "followUp", triggerTurn: true });
        return false; // Closure waits for message_end: actual transcript admission.
      }
    });
    if (!valid()) { await created.stop(); return; }
    manager = created;
    await created.restore([...records.values()]);
    updateUI();
  };
  pi.on("session_start", async (_event, ctx) => { await activate(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await activate(ctx); });
  pi.on("session_shutdown", stop);
  pi.on("message_end", event => {
    if (event.message.role !== "custom" || event.message.customType !== MESSAGE) return;
    const data = event.message.details as { taskId?: string; attention?: boolean };
    if (data?.taskId && !data.attention) manager?.acknowledge(data.taskId);
  });
  pi.on("context", event => {
    const seen = new Set<string>();
    return { messages: event.messages.filter(message => {
      if (message.role !== "custom" || message.customType !== MESSAGE) return true;
      const data = message.details as { taskId?: string; attention?: boolean };
      if (!data?.taskId || !manager?.tasks.has(data.taskId)) return false;
      const key = data.taskId + (data.attention ? ":attention" : ":result");
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }) };
  });
  // The installed public ExtensionAPI has no appendUsage. Attribute detached child usage
  // exactly once to the next main tool result; never mutate the read-only SessionManager.
  pi.on("tool_result", async event => {
    if (!manager) return;
    const pending = [...manager.tasks.values()].filter(t => t.outcome && !charged.has(t.taskId));
    if (!pending.length) return;
    let usage = event.usage ?? zeroUsage();
    for (const task of pending) { usage = addUsage(usage, task.outcome!.usage); charged.add(task.taskId); }
    return { usage, details: { ...(typeof event.details === "object" && event.details !== null ? event.details : { originalDetails: event.details }),
      [ACCOUNTING]: pending.map(t => t.taskId), herdrSubagentModelUsage: pending.flatMap(t => t.outcome!.modelUsage) } };
  });
  pi.registerTool({
    name: "herdr_subagent", label: "Herdr subagent", parameters, outputSchema,
    description: "Delegate autonomous background work to visible pi TUI children in Herdr. spawn returns after reservation, not completion. Maximum six, no queue/recursion. Define disjoint file write ownership. wait timeout never cancels/resubmits. Blocked requires human intervention. Requires an initially single-pane unzoomed tab.",
    promptGuidelines: ["Continue independent work after spawn; wait only at a dependency. Never race this tool with raw Herdr pane controls."],
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (!manager) throw new Error("Herdr observer unavailable. Requires HERDR_ENV=1, a managed pane and session_start.");
        let data: unknown;
        if (params.action === "spawn") {
          if (!ctx.model) throw new Error("Select a model before delegation.");
          manager.defaults.model = ctx.model.provider + "/" + ctx.model.id;
          manager.defaults.thinking = ctx.thinkingLevel ?? "off";
          data = { task: view(await manager.spawn(params.task, params.instructions)) };
        } else if (params.action === "list") data = { tasks: manager.list() };
        else if (params.action === "status") data = { task: await manager.status(params.taskId) };
        else if (params.action === "wait") data = { task: await manager.wait(params.taskId, params.timeoutMs, signal) };
        else data = { task: await manager.cancel(params.taskId) };
        const clean = JSON.parse(JSON.stringify(data));
        return { content: [{ type: "text", text: JSON.stringify(clean) }], details: clean, structuredContent: clean };
      } catch (e) {
        const data = { error: e instanceof Error ? e.message : String(e) };
        return { content: [{ type: "text", text: data.error }], details: data, structuredContent: data, isError: true };
      }
    }
  });
}
