import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../../src/extension.ts";
import { atomicJson } from "../../src/results.ts";
import type { Task } from "../../src/tasks.ts";

export default function (pi: ExtensionAPI) {
  let tool!: ToolDefinition;
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return (definition: ToolDefinition) => { tool = definition; target.registerTool(definition); };
    return Reflect.get(target, key);
  } });
  extension(proxy);
  pi.registerCommand("hs-live-verify", {
    description: "Isolated integration test only: delegate two read-only tasks while the principal works.",
    handler: async (_args, ctx) => {
      for (const token of ["HS-CHILD-A", "HS-CHILD-B"]) {
        const result = await tool.execute("test-spawn-" + token, {
          action: "spawn", task: "Live integration test. Do not read or modify project files. Use bash once to run sleep 3, then reply with exactly " + token + "."
        }, undefined, undefined, ctx as unknown as ExtensionToolContext);
        if (result.isError) throw new Error(JSON.stringify(result.content));
      }
      pi.sendUserMessage("Live integration test. Do not read or modify project files and do not spawn additional children. First use bash once to run sleep 10, then say MAIN-WORK-FINISHED. When the two herdr-subagent follow-ups arrive, use herdr_subagent status for each actual returned taskId. After both results are available, reply HS-MAIN-COMPLETE. Keep responses short.", { deliverAs: "followUp" });
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const directory = process.env.HERDR_TEST_EVIDENCE;
    if (!directory) return;
    const tasks = new Map<string, Task>(), notices: string[] = [], accounted: string[] = [], assistants: string[] = [];
    let mainWork = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "herdr-subagents:task") {
        const task = entry.data as Task; tasks.set(task.taskId, task);
      }
      if (entry.type === "custom_message" && entry.customType === "herdr-subagents:result") {
        const details = entry.details as { taskId: string; attention: boolean };
        if (!details.attention) notices.push(details.taskId);
      }
      if (entry.type === "message") {
        const m = entry.message;
        if (m.role === "assistant") {
          assistants.push(m.content.filter(c => c.type === "text").map(c => c.text).join("\n").slice(0, 500));
          if (m.content.some(c => c.type === "toolCall" && c.name === "bash" && String(c.arguments.command).includes("sleep 10"))) mainWork = true;
        }
        if (m.role === "toolResult" && m.details && typeof m.details === "object" && !Array.isArray(m.details)) {
          const ids = (m.details as Record<string, unknown>).herdrSubagentUsageTaskIds;
          if (Array.isArray(ids)) accounted.push(...ids);
        }
      }
    }
    await atomicJson(join(directory, "principal.json"), { sessionPath: ctx.sessionManager.getSessionFile(), leafId: ctx.sessionManager.getLeafId(),
      tasks: [...tasks.values()].map(task => ({ taskId: task.taskId, state: task.state, paneId: task.pane?.paneId, resultPath: task.resultPath, text: task.outcome?.text })),
      notices, accounted, assistants, mainWork });
  });
}
