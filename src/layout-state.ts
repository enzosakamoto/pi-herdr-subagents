import { object, string } from "./herdr.ts";
import { plan, apply, leaves, equalTree, NEW_PANE, type Tree } from "./layout-geometry.ts";
import type { PaneRef } from "./layout.ts";

export interface FocusRef extends PaneRef { occupant: string }
export interface CloseFocusState { version: 1; initial: FocusRef; target: FocusRef; last?: FocusRef }
export interface LayoutRecord {
  version: 2; id: string; owner: string; principal: PaneRef; taskIds: string[];
  workers: PaneRef[]; mode: "add" | "compact"; cwd: string; env: Record<string, string>; newTaskId?: string;
  reserve?: PaneRef; next: number; baseTree: Tree; tree: Tree;
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
  return { direction: t.direction, ratio: Math.fround(t.ratio), left: tree(t.left, seen, depth + 1), right: tree(t.right, seen, depth + 1) };
}
export function journalPlan(t: LayoutRecord) { return plan(t.baseTree, t.principal.paneId, t.workers.map(p => p.paneId), t.mode, t.reserve?.paneId ?? NEW_PANE); }
export function checkedState(raw: unknown, principal: PaneRef, owner: string, taskIds: string[]): LayoutState {
  const s = object(raw, "layout state"), transactionId = string(s.transactionId, "layout transaction");
  if (s.record === null) return { transactionId, record: null };
  const r = object(s.record, "layout journal");
  if (r.version === 1) throw new Error("Legacy v1 layout journal retained; reconcile manually. Incremental recovery never executes swaps or adopts auxiliaries.");
  if (r.version !== 2 || r.id !== transactionId || r.owner !== owner || !sameRef(ref(r.principal), principal)) throw new Error("Layout journal belongs to another principal/session.");
  if (!Array.isArray(r.taskIds) || new Set(r.taskIds).size !== r.taskIds.length || r.taskIds.some(id => typeof id !== "string" || !taskIds.includes(id))) throw new Error("Layout journal is not owned by the active branch; refusing adoption.");
  if (!Array.isArray(r.workers) || (r.mode !== "add" && r.mode !== "compact")) throw new Error("Invalid incremental layout workers/mode.");
  const workers = r.workers.map(ref), reserve = r.reserve === undefined ? undefined : ref(r.reserve);
  const refs = [...workers, ...(reserve ? [reserve] : [])];
  if (new Set(refs.map(p => p.paneId)).size !== refs.length || refs.some(p => p.tabId !== principal.tabId || p.workspaceId !== principal.workspaceId || p.paneId === principal.paneId))
    throw new Error("Invalid layout journal ownership region.");
  if (reserve && (r.mode !== "add" || reserve.agentName || reserve.staging)) throw new Error("Invalid fresh layout reservation.");
  string(r.cwd, "layout cwd");
  const env = object(r.env, "layout env");
  if (Object.values(env).some(v => typeof v !== "string")) throw new Error("Invalid layout journal environment.");
  if (r.newTaskId !== undefined && (typeof r.newTaskId !== "string" || !r.taskIds.includes(r.newTaskId))) throw new Error("Invalid layout journal new task.");
  if (r.mode === "compact" && r.newTaskId !== undefined) throw new Error("Unexpected new task in compaction journal.");
  const record = structuredClone(r) as unknown as LayoutRecord;
  record.baseTree = tree(r.baseTree); record.tree = tree(r.tree); record.workers = workers; record.reserve = reserve;
  if (reserve && leaves(record.baseTree).includes(reserve.paneId)) throw new Error("Journal reserve was not a fresh shell.");
  if (leaves(record.baseTree).includes(NEW_PANE)) throw new Error("Journal contains a planning placeholder.");
  const ops = journalPlan(record);
  if (!Number.isInteger(r.next) || Number(r.next) < 0 || Number(r.next) > ops.length) throw new Error("Invalid layout journal phase.");
  if (r.intent !== undefined) {
    const i = object(r.intent, "layout intent");
    if (Number(r.next) === ops.length || (i.rejected !== undefined && typeof i.rejected !== "boolean")) throw new Error("Invalid layout journal intent.");
    record.intent = { before: tree(i.before), after: i.after === undefined ? undefined : tree(i.after), rejected: i.rejected as boolean | undefined };
  }
  if (r.focus !== undefined) { ref(r.focus); string(object(r.focus, "layout focus").occupant, "layout focus occupant"); }
  if (r.lastFocus !== undefined) string(r.lastFocus, "layout last focus");
  if (r.focusChanged !== undefined && typeof r.focusChanged !== "boolean") throw new Error("Invalid layout focus flag.");
  // Recompute the schedule from the original owned topology, never trust
  // arbitrary persisted commands or infer a reservation from pane deltas.
  let projected = record.baseTree, born = false;
  for (let i = 0; i < record.next; i++) {
    if (ops[i].kind === "split") { if (!reserve) throw new Error("Incomplete journal reservation."); born = true; }
    projected = apply(projected, ops[i]);
  }
  if (!equalTree(projected, record.tree)) throw new Error("Journal topology contradicts its operation history.");
  if (record.intent) {
    if (!equalTree(record.intent.before, projected)) throw new Error("Journal intent has an invalid starting topology.");
    const op = ops[record.next], after = op.kind === "split" && !reserve ? undefined : apply(projected, op);
    if ((after && !record.intent.after) || (record.intent.after && (!after || !equalTree(after, record.intent.after))))
      throw new Error("Journal intent has an invalid destination topology.");
    if (op.kind === "split" && reserve) born = true;
  }
  if (reserve && !born) throw new Error("Journal contains an unproven reservation.");
  return { transactionId, record };
}
