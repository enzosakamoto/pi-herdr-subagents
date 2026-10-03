import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

export interface Receipt { taskId: string; sessionId: string; sessionPath: string; leafId: string | null; model?: string }
export interface Outcome {
  text: string; stopReason: string; error?: string;
  usage: Usage; modelUsage: { provider: string; model: string; usage: Usage }[];
}
export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(a: Usage, b: Usage): Usage {
  const result = zeroUsage();
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) result[key] = a[key] + b[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) result.cost[key] = a.cost[key] + b.cost[key];
  if (a.reasoning || b.reasoning) result.reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  if (a.cacheWrite1h || b.cacheWrite1h) result.cacheWrite1h = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);
  return result;
}
export async function atomicJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp-" + crypto.randomUUID();
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

export async function collect(receipt: Receipt, taskId: string, sessionId: string, explicitlyCancelled = false): Promise<Outcome> {
  if (receipt.taskId !== taskId || receipt.sessionId !== sessionId || !receipt.leafId) throw new Error("Mismatched settlement receipt.");
  const raw = await readFile(receipt.sessionPath, "utf8");
  // A concurrent/partial last line is never a finalized entry.
  const entries = raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line)) as FileEntry[];
  if (entries[0]?.type !== "session" || entries[0].id !== sessionId || entries[0].version !== 3)
    throw new Error("Not the expected fresh v3 child session.");
  const manager = SessionManager.inMemory(undefined, undefined, entries);
  if (!manager.getEntry(receipt.leafId)) throw new Error("Settled leaf has not been persisted.");
  const branch = manager.getBranch(receipt.leafId);
  const marker = "[herdr-subagent:" + taskId + "]";
  const start = branch.findIndex(e => e.type === "message" && e.message.role === "user" &&
    (typeof e.message.content === "string" ? e.message.content : e.message.content.filter(c => c.type === "text").map(c => c.text).join("\n")).startsWith(marker));
  if (start < 0) throw new Error("Task prompt absent from active branch; do not collect an older response.");
  const work = branch.slice(start + 1);
  if (work.some(e => e.type === "message" && e.message.role === "user")) throw new Error("Additional user turn; task completion is ambiguous.");
  const assistants = work.filter(e => e.type === "message" && e.message.role === "assistant");
  const last = assistants.at(-1);
  let response: AssistantMessage | undefined = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
  if (explicitlyCancelled && (!response || response.stopReason === "toolUse")) {
    // The correlated settlement + separately verified idle state prove interruption,
    // even when Escape stopped the turn before any final assistant response existed.
    // This is a cancellation diagnostic, never an older assistant's successful answer.
    response = { role: "assistant", content: [{ type: "text", text: "Task explicitly cancelled; no final assistant response was produced." }],
      api: "interrupted", provider: "unknown", model: "interrupted", stopReason: "aborted", usage: zeroUsage(), timestamp: Date.now() };
  }
  if (!response) throw new Error("No finalized assistant response for this task.");
  if (!["stop", "length", "error", "aborted"].includes(response.stopReason) || response.content.some(c => c.type === "toolCall"))
    throw new Error("Last assistant message is not a final task response.");
  const text = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  if (!text && !response.errorMessage && response.stopReason !== "aborted") throw new Error("Final response contains no text/diagnostic.");
  let usage = zeroUsage();
  const buckets = new Map<string, { provider: string; model: string; usage: Usage }>();
  for (const entry of work) {
    let u: Usage | undefined, provider = response.provider, model = response.model;
    if (entry.type === "message") {
      const m = entry.message;
      if (m.role === "assistant" || m.role === "toolResult") {
        u = m.usage;
        if (m.role === "assistant") { provider = m.provider; model = m.model; }
        else { provider = "unknown"; model = "nested-tool"; } // Usage has no provider attribution.
      }
    } else if ("usage" in entry) {
      u = entry.usage;
      if (entry.type === "usage") { provider = entry.provider; model = entry.model; }
      else { provider = "unknown"; model = entry.type; }
    }
    if (u) {
      usage = addUsage(usage, u);
      const key = provider + "/" + model, previous = buckets.get(key);
      buckets.set(key, { provider, model, usage: addUsage(previous?.usage ?? zeroUsage(), u) });
    }
  }
  return { text, stopReason: response.stopReason, error: response.errorMessage, usage, modelUsage: [...buckets.values()] };
}
