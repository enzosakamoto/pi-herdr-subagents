import { join, dirname } from "node:path";
import { readJson, atomicJson, zeroUsage } from "../src/results.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { HerdrError, type Control } from "../src/herdr.ts";
import type { Task } from "../src/tasks.ts";

type Node = { pane: string } | { direction: string; ratio: number; left: Node; right: Node };
export class Fake implements Control {
  count = 0;
  panes = new Map<string, Record<string, unknown>>();
  tabs = new Map<string, Node>();
  calls: string[][] = [];
  agents = new Map<string, { pane: string; task: Task; prompt?: string; resolve?: () => void }>();
  focus = "principal";
  zoomed = false;
  delayStart: Promise<void> = Promise.resolve();
  error?: (args: string[]) => Error | undefined;
  constructor() {
    this.panes.set("principal", { pane_id: "principal", terminal_id: "main-terminal", tab_id: "original", workspace_id: "workspace", agent_status: "unknown" });
    this.tabs.set("original", { pane: "principal" });
  }
  newPane(tab: string, env: Record<string, string> = {}) {
    const id = "child-" + ++this.count;
    const p = { pane_id: id, terminal_id: "terminal-" + this.count, tab_id: tab, workspace_id: "workspace", agent_status: "unknown", env };
    this.panes.set(id, p); return p;
  }
  insert(root: Node, target: string, pane: string, direction: string, ratio: number): Node {
    if ("pane" in root) return root.pane === target ? { direction, ratio, left: root, right: { pane } } : root;
    return { ...root, left: this.insert(root.left, target, pane, direction, ratio), right: this.insert(root.right, target, pane, direction, ratio) };
  }
  remove(root: Node, target: string): Node | undefined {
    if ("pane" in root) return root.pane === target ? undefined : root;
    const left = this.remove(root.left, target), right = this.remove(root.right, target);
    return left && right ? { ...root, left, right } : left ?? right;
  }
  layout(tab: string) {
    const result: unknown[] = [];
    const walk = (n: Node, x: number, y: number, width: number, height: number) => {
      if ("pane" in n) { result.push({ pane_id: n.pane, rect: { x, y, width, height } }); return; }
      const size = Math.round((n.direction === "right" ? width : height) * n.ratio);
      if (n.direction === "right") { walk(n.left, x, y, size, height); walk(n.right, x + size, y, width - size, height); }
      else { walk(n.left, x, y, width, size); walk(n.right, x, y + size, width, height - size); }
    };
    walk(this.tabs.get(tab)!, 0, 0, 203, 57);
    return { area: { x: 0, y: 0, width: 203, height: 57 }, panes: result, focused_pane_id: this.focus, zoomed: this.zoomed };
  }
  async json(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.calls.push(args);
    const error = this.error?.(args); if (error) throw error;
    const opt = (key: string) => args[args.indexOf(key) + 1];
    const env: Record<string, string> = {};
    args.forEach((arg, i) => { if (arg === "--env") { const value = args[i + 1], eq = value.indexOf("="); env[value.slice(0, eq)] = value.slice(eq + 1); } });
    const [group, action, id] = args;
    if (group === "tab" && action === "create") {
      const tab = "stage-" + ++this.count, p = this.newPane(tab, env);
      this.tabs.set(tab, { pane: String(p.pane_id) }); return { root_pane: p };
    }
    if (group === "pane") {
      if (action === "current" || action === "get") {
        const p = this.panes.get(action === "get" ? id : args.includes("--current") ? "principal" : opt("--pane"));
        if (!p) throw new HerdrError("Pane closed", "pane_not_found");
        return { pane: { ...p } };
      }
      if (action === "layout") return { layout: this.layout(String(this.panes.get(opt("--pane"))!.tab_id)) };
      if (action === "split") {
        const target = this.panes.get(id)!, tab = String(target.tab_id), p = this.newPane(tab, env);
        this.tabs.set(tab, this.insert(this.tabs.get(tab)!, id, String(p.pane_id), opt("--direction"), Number(opt("--ratio"))));
        return { pane: { ...p } };
      }
      if (action === "move") {
        const p = this.panes.get(id)!, oldTab = String(p.tab_id);
        const tab = args.includes("--new-tab") ? "stage-" + ++this.count : opt("--tab");
        if (tab === oldTab) return { move_result: { changed: false, reason: "same_tab" } };
        const root = this.remove(this.tabs.get(oldTab)!, id);
        if (root) this.tabs.set(oldTab, root); else this.tabs.delete(oldTab);
        this.tabs.set(tab, this.tabs.has(tab) ? this.insert(this.tabs.get(tab)!, opt("--target-pane"), id, opt("--split"), Number(opt("--ratio"))) : { pane: id });
        p.tab_id = tab;
        return { move_result: { changed: true, pane: { ...p }, focused_pane_id: this.focus } };
      }
      if (action === "close") {
        const p = this.panes.get(id);
        if (!p) throw new HerdrError("Pane absent", "pane_not_found");
        const tab = String(p.tab_id), root = this.remove(this.tabs.get(tab)!, id);
        if (root) this.tabs.set(tab, root); else this.tabs.delete(tab);
        this.panes.delete(id); return {};
      }
    }
    if (group === "agent") {
      if (action === "start") {
        await this.delayStart;
        if (signal?.aborted) throw new Error("aborted");
        const p = this.panes.get(opt("--pane"))!;
        const task = await readJson<Task>(join(dirname(opt("--session-dir")), "task.json"));
        const sessionPath = join(task.directory, "sessions", "child.jsonl");
        Object.assign(p, { agent: "pi", name: id, agent_status: "idle", agent_session: { kind: "path", value: sessionPath } });
        this.agents.set(id, { pane: String(p.pane_id), task });
        await atomicJson(join(task.directory, "ready.json"), { taskId: task.taskId, sessionId: task.sessionId, sessionPath, leafId: null });
        return { agent: { ...p } };
      }
      const a = this.agents.get(id);
      if (!a) throw new HerdrError("Agent absent", "agent_not_found");
      const p = this.panes.get(a.pane)!;
      if (action === "get") return { agent: { ...p } };
      if (action === "prompt") {
        a.prompt = args[3]; p.agent_status = "working";
        await new Promise<void>((resolve, reject) => {
          a.resolve = resolve;
          const abort = () => reject(new Error("Local observer aborted"));
          if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        });
        return { agent: { ...p } };
      }
      if (action === "wait") {
        if (args.includes("--until") && opt("--until") === "working" && p.agent_status === "working") return { agent: { ...p } };
        if (p.agent_status === "working") await new Promise<void>((resolve, reject) => {
          const prior = a.resolve; a.resolve = () => { prior?.(); resolve(); };
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { agent: { ...p } };
      }
      if (action === "send-keys") { await this.complete(id, "aborted"); return {}; }
    }
    throw new Error("Unsupported fake command: " + args.join(" "));
  }
  async text(args: string[]) { this.calls.push(args); return "bounded terminal diagnostic"; }
  async complete(name: string, stopReason = "stop", text = "result") {
    const a = this.agents.get(name)!;
    const p = this.panes.get(a.pane)!;
    const task = a.task;
    const sessionPath = join(task.directory, "sessions", "child.jsonl");
    const entries = [
      { type: "session", version: 3, id: task.sessionId, cwd: "/test", timestamp: new Date().toISOString() },
      { type: "message", id: "u", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: a.prompt, timestamp: Date.now() } },
      { type: "message", id: "a", parentId: "u", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }], stopReason, api: "test", provider: "test", model: "test", timestamp: Date.now(), usage: { ...zeroUsage(), input: 10, output: 20, totalTokens: 30 } } }
    ];
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    p.agent_status = "idle";
    await atomicJson(join(task.directory, "settled.json"), { taskId: task.taskId, sessionId: task.sessionId, sessionPath, leafId: "a" });
    a.resolve?.();
  }
  block(name: string) { const a = this.agents.get(name)!; this.panes.get(a.pane)!.agent_status = "blocked"; a.resolve?.(); }
}
export async function eventually(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition did not settle");
    await new Promise(r => setTimeout(r, 5));
  }
}
