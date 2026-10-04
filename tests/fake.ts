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
  focusHistory: string[] = [];
  swapChangedFalse = false;
  processInfo?: (paneId: string, query: number) => Record<string, unknown>;
  processInfoQueries = new Map<string, number>();
  area = { x: 0, y: 0, width: 203, height: 57 };
  zoomed = false;
  startBlocked = false;
  startupModel?: string | null;
  delayStart: Promise<void> = Promise.resolve();
  error?: (args: string[]) => Error | undefined;
  afterError?: (args: string[]) => Error | undefined;
  sidebarOnTabCreation = false;
  tabCreatedHooks = 0;
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
    if ("pane" in root) return root.pane === target ? { direction, ratio: Math.fround(ratio), left: root, right: { pane } } : root;
    return { ...root, left: this.insert(root.left, target, pane, direction, ratio), right: this.insert(root.right, target, pane, direction, ratio) };
  }
  remove(root: Node, target: string): Node | undefined {
    if ("pane" in root) return root.pane === target ? undefined : root;
    const left = this.remove(root.left, target), right = this.remove(root.right, target);
    return left && right ? { ...root, left, right } : left ?? right;
  }
  layout(tab: string) {
    const result: { pane_id: string; rect: { x: number; y: number; width: number; height: number } }[] = [];
    const splits: { id: string; direction: string; ratio: number; rect: { x: number; y: number; width: number; height: number } }[] = [];
    const walk = (n: Node, x: number, y: number, width: number, height: number) => {
      if ("pane" in n) { result.push({ pane_id: n.pane, rect: { x, y, width, height } }); return; }
      splits.push({ id: "split-" + splits.length, direction: n.direction, ratio: n.ratio, rect: { x, y, width, height } });
      const size = Math.round(Math.fround((n.direction === "right" ? width : height) * Math.fround(n.ratio)));
      if (n.direction === "right") { walk(n.left, x, y, size, height); walk(n.right, x + size, y, width - size, height); }
      else { walk(n.left, x, y, width, size); walk(n.right, x, y + size, width, height - size); }
    };
    walk(this.tabs.get(tab)!, this.area.x, this.area.y, this.area.width, this.area.height);
    return { tab_id: tab, workspace_id: "workspace", area: { ...this.area }, panes: result, splits, focused_pane_id: this.focus, zoomed: this.zoomed };
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
      this.tabs.set(tab, { pane: String(p.pane_id) });
      this.tabCreatedHooks++;
      if (this.sidebarOnTabCreation) {
        const sidebar = this.newPane(tab); Object.assign(sidebar, { label: "Sidebar", tokens: { "herdr-sidebar-explorer": "hook" } });
        this.tabs.set(tab, this.insert(this.tabs.get(tab)!, String(p.pane_id), String(sidebar.pane_id), "right", 0.8));
      }
      return { root_pane: p };
    }
    if (group === "tab" && action === "focus") { this.focus = this.layout(id).panes[0].pane_id; this.focusHistory.push(this.focus); return {}; }
    if (group === "pane") {
      if (action === "list") return { panes: [...this.panes.values()].map(p => ({ ...p, focused: p.pane_id === this.focus })) };
      if (action === "swap") {
        const source = opt("--source-pane"), target = opt("--target-pane");
        const tab = String(this.panes.get(source)!.tab_id);
        if (this.swapChangedFalse) return { swap: { changed: false, reason: "cross_tab", source_pane_id: source, target_pane_id: target, focused_pane_id: this.focus, layout: this.layout(tab) } };
        const walk = (n: Node): Node => "pane" in n ? { pane: n.pane === source ? target : n.pane === target ? source : n.pane } : { ...n, left: walk(n.left), right: walk(n.right) };
        this.tabs.set(tab, walk(this.tabs.get(tab)!)); this.focus = source; this.focusHistory.push(source);
        const error = this.afterError?.(args); if (error) throw error;
        return { swap: { changed: true, source_pane_id: source, target_pane_id: target, focused_pane_id: this.focus, layout: this.layout(tab) } };
      }
      if (action === "process-info") {
        const paneId = opt("--pane"), query = (this.processInfoQueries.get(paneId) ?? 0) + 1;
        this.processInfoQueries.set(paneId, query);
        const info = this.processInfo?.(paneId, query) ?? { shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: "bash", argv0: "/bin/bash", argv: ["/bin/bash"] }] };
        return { process_info: { pane_id: paneId, ...structuredClone(info) } };
      }
      if (action === "current" || action === "get") {
        const p = this.panes.get(action === "get" ? id : args.includes("--current") ? "principal" : opt("--pane"));
        if (!p) throw new HerdrError("Pane closed", "pane_not_found");
        return { pane: { ...p, focused: p.pane_id === this.focus } };
      }
      if (action === "neighbor" || action === "focus") {
        const source = opt("--pane"), direction = opt("--direction");
        const data = this.layout(String(this.panes.get(source)!.tab_id));
        const rect = data.panes.find(p => p.pane_id === source)!.rect;
        const neighbor = data.panes.find(p => {
          const r = p.rect;
          const verticalOverlap = r.y < rect.y + rect.height && rect.y < r.y + r.height;
          const horizontalOverlap = r.x < rect.x + rect.width && rect.x < r.x + r.width;
          return direction === "right" ? verticalOverlap && r.x === rect.x + rect.width :
            direction === "left" ? verticalOverlap && r.x + r.width === rect.x :
            direction === "down" ? horizontalOverlap && r.y === rect.y + rect.height :
            horizontalOverlap && r.y + r.height === rect.y;
        });
        if (action === "focus" && neighbor) { this.focus = neighbor.pane_id; this.focusHistory.push(this.focus); }
        return { neighbor: { neighbor_pane_id: neighbor?.pane_id } };
      }
      if (action === "layout") return { layout: this.layout(String(this.panes.get(opt("--pane"))!.tab_id)) };
      if (action === "split") {
        const target = this.panes.get(id)!, tab = String(target.tab_id), p = this.newPane(tab, env);
        this.tabs.set(tab, this.insert(this.tabs.get(tab)!, id, String(p.pane_id), opt("--direction"), Number(opt("--ratio"))));
        const error = this.afterError?.(args); if (error) throw error;
        return { pane: { ...p } };
      }
      if (action === "move") {
        const p = this.panes.get(id)!, oldTab = String(p.tab_id);
        const tab = args.includes("--new-tab") ? "stage-" + ++this.count : opt("--tab");
        if (tab === oldTab) return { move_result: { changed: false, reason: "same_tab" } };
        const root = this.remove(this.tabs.get(oldTab)!, id);
        if (this.focus === id) this.focus = oldTab === "original" ? "principal" : "";
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
        this.panes.delete(id);
        if (this.focus === id) this.focus = "principal";
        const error = this.afterError?.(args); if (error) throw error;
        return {};
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
        await atomicJson(join(task.directory, "ready.json"), { taskId: task.taskId, sessionId: task.sessionId, sessionPath, leafId: null,
          model: this.startupModel === undefined ? task.model : this.startupModel ?? undefined });
        if (this.startBlocked) { p.agent_status = "blocked"; throw new HerdrError("Approval needed", "agent_not_ready"); }
        return { agent: { ...p } };
      }
      const a = this.agents.get(id);
      if (!a) throw new HerdrError("Agent absent", "agent_not_found");
      const p = this.panes.get(a.pane)!;
      if (action === "get") return { agent: { ...p } };
      if (action === "focus") { this.focus = a.pane; return {}; }
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
  async text(args: string[]) {
    if (args[0] === "agent" && args[1] === "send-keys") { await this.json(args); return ""; }
    this.calls.push(args); return "bounded terminal diagnostic";
  }
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
export async function eventually(check: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition did not settle");
    await new Promise(r => setTimeout(r, 5));
  }
}
