import { object, string } from "./herdr.ts";
import { operations, leaves, equalTree, region, insert, swap, remove, type Tree } from "./layout-geometry.ts";
import type { PaneRef } from "./layout.ts";

export interface FocusRef extends PaneRef { occupant: string }
export interface CloseFocusState { version: 1; initial: FocusRef; target: FocusRef; last?: FocusRef }
export interface LayoutRecord {
  version: 1; id: string; owner: string; principal: PaneRef; taskIds: string[];
  workers: PaneRef[]; count: number; cwd: string; env: Record<string, string>; newTaskId?: string;
  slots: (PaneRef | null)[]; next: number; baseTree: Tree; tree: Tree;
  intent?: { before: Tree; after?: Tree; rejected?: boolean };
  focus?: FocusRef; lastFocus?: string; focusChanged?: boolean;
}
export interface LayoutState { transactionId: string; record: LayoutRecord | null }
export interface LayoutStore {
  owner: string;
  cwd?: string;
  taskIds(): string[];
  tasksFor?(panes: string[]): string[];
  persist(state: LayoutState): Promise<void>;
}
export function sameRef(a: PaneRef, b: PaneRef) {
  return a.paneId === b.paneId && a.terminalId === b.terminalId && a.tabId === b.tabId && a.workspaceId === b.workspaceId;
}
export function occupant(p: Record<string, unknown>) { return JSON.stringify({ agent: p.agent, name: p.name, session: p.agent_session }); }
function ref(raw: unknown): PaneRef {
  const p = object(raw, "layout ownership");
  for (const k of ["paneId", "terminalId", "tabId", "workspaceId"]) string(p[k], k);
  for (const k of ["agentName", "sessionId", "sessionPath"]) if (p[k] !== undefined) string(p[k], k);
  if (p.staging !== undefined && typeof p.staging !== "boolean") throw new Error("Invalid layout ownership staging flag.");
  if (p.shell !== undefined) {
    const s = object(p.shell, "journal shell");
    if (!Number.isInteger(s.pid) || Number(s.pid) <= 0) throw new Error("Invalid journal shell PID.");
    string(s.name, "shell name");
    if (s.argv0 !== undefined) string(s.argv0, "shell argv0");
    if (s.argv !== undefined && (!Array.isArray(s.argv) || s.argv.some(v => typeof v !== "string"))) throw new Error("Invalid journal shell argv.");
  }
  return p as unknown as PaneRef;
}
function tree(raw: unknown, seen = new Set<string>(), depth = 0): Tree {
  if (depth > 100) throw new Error("Layout journal tree too deep.");
  const t = object(raw, "layout journal tree");
  if (t.pane !== undefined) {
    const id = string(t.pane, "layout journal pane");
    if (seen.has(id)) throw new Error("Duplicate layout journal pane.");
    seen.add(id); return { pane: id };
  }
  if ((t.direction !== "right" && t.direction !== "down") || typeof t.ratio !== "number" || !Number.isFinite(t.ratio) || t.ratio < 0.1 || t.ratio > 0.9)
    throw new Error("Invalid layout journal split.");
  return { direction: t.direction, ratio: t.ratio, left: tree(t.left, seen, depth + 1), right: tree(t.right, seen, depth + 1) };
}
export function checkedState(raw: unknown, principal: PaneRef, owner: string, taskIds: string[]): LayoutState {
  const s = object(raw, "layout state"), transactionId = string(s.transactionId, "layout transaction");
  if (s.record === null) return { transactionId, record: null };
  const r = object(s.record, "layout journal");
  if (r.version !== 1 || r.id !== transactionId || r.owner !== owner || !sameRef(ref(r.principal), principal)) throw new Error("Layout journal belongs to another principal/session.");
  if (!Array.isArray(r.taskIds) || new Set(r.taskIds).size !== r.taskIds.length || r.taskIds.some(id => typeof id !== "string" || !taskIds.includes(id))) throw new Error("Layout journal is not owned by the active branch; refusing adoption.");
  if (!Array.isArray(r.workers) || !Array.isArray(r.slots) || !Number.isInteger(r.count) || r.slots.length !== r.count)
    throw new Error("Invalid layout journal slots/workers.");
  const workers = r.workers.map(ref), count = Number(r.count), ops = operations(count, workers.length);
  if (!Number.isInteger(r.next) || Number(r.next) < 0 || Number(r.next) > ops.length) throw new Error("Invalid layout journal phase.");
  const slots = r.slots.map(v => v === null ? null : ref(v));
  const refs = [...workers, ...slots.filter((v): v is PaneRef => v !== null)];
  if (new Set(refs.map(p => p.paneId)).size !== refs.length || refs.some(p => p.tabId !== principal.tabId || p.workspaceId !== principal.workspaceId || p.paneId === principal.paneId))
    throw new Error("Invalid layout journal ownership region.");
  string(r.cwd, "layout cwd");
  const env = object(r.env, "layout env");
  if (Object.values(env).some(v => typeof v !== "string")) throw new Error("Invalid layout journal environment.");
  if (r.newTaskId !== undefined && (typeof r.newTaskId !== "string" || !r.taskIds.includes(r.newTaskId))) throw new Error("Invalid layout journal new task.");
  if (workers.length === count && r.newTaskId !== undefined) throw new Error("Unexpected new task in compaction journal.");
  const record = structuredClone(r) as unknown as LayoutRecord;
  record.baseTree = tree(r.baseTree); record.tree = tree(r.tree); record.workers = workers; record.slots = slots;
  if (r.intent !== undefined) {
    const i = object(r.intent, "layout intent");
    if (Number(r.next) === ops.length || (i.rejected !== undefined && typeof i.rejected !== "boolean")) throw new Error("Invalid layout journal intent.");
    record.intent = { before: tree(i.before), after: i.after === undefined ? undefined : tree(i.after), rejected: i.rejected as boolean | undefined };
  }
  if (r.focus !== undefined) { ref(r.focus); string(object(r.focus, "layout focus").occupant, "layout focus occupant"); }
  if (r.lastFocus !== undefined) string(r.lastFocus, "layout last focus");
  if (r.focusChanged !== undefined && typeof r.focusChanged !== "boolean") throw new Error("Invalid layout focus flag.");
  // Replay only the deterministic schedule. A journal cannot name an existing
  // external shell as an auxiliary or invent an unrelated close operation.
  region(record.baseTree, [principal.paneId, ...workers.map(p => p.paneId)], { x: 0, y: 0, width: 100000, height: 100000 });
  const original = new Set(leaves(record.baseTree)), born = new Set<number>();
  if (slots.some(p => p && (original.has(p.paneId) || p.agentName || p.staging))) throw new Error("Journal auxiliary was not a fresh shell.");
  let projected = record.baseTree;
  const apply = (index: number): Tree | undefined => {
    const op = ops[index], slot = slots[op.slot];
    if (!slot) return undefined;
    if (op.kind === "split") {
      const target = op.target === "principal" ? principal : slots[op.target];
      if (!target) throw new Error("Invalid journal slot order.");
      born.add(op.slot); return insert(projected, target.paneId, slot.paneId, op.direction, op.ratio);
    }
    return op.kind === "swap" ? swap(projected, workers[op.worker].paneId, slot.paneId) : remove(projected, slot.paneId);
  };
  for (let i = 0; i < record.next; i++) {
    const after = apply(i); if (!after) throw new Error("Incomplete journal operation.");
    projected = after;
  }
  if (!equalTree(projected, record.tree)) throw new Error("Journal topology contradicts its operation history.");
  if (record.intent) {
    if (!equalTree(record.intent.before, projected)) throw new Error("Journal intent has an invalid starting topology.");
    const after = apply(record.next);
    if ((after && !record.intent.after) || (record.intent.after && (!after || !equalTree(after, record.intent.after))))
      throw new Error("Journal intent has an invalid destination topology.");
  }
  if (slots.some((p, i) => p && !born.has(i))) throw new Error("Journal contains an unproven auxiliary.");
  return { transactionId, record };
}
