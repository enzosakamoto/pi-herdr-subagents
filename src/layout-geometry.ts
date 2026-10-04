import { object, string } from "./herdr.ts";

export interface Rect { x: number; y: number; width: number; height: number }
export type Tree = { pane: string } | { direction: "right" | "down"; ratio: number; left: Tree; right: Tree };
export interface Snapshot {
  tabId: string; workspaceId: string; zoomed: boolean; area: Rect;
  panes: Map<string, Rect>; tree: Tree;
}
export function rectangle(raw: unknown): Rect {
  const r = object(raw, "layout rectangle");
  for (const key of ["x", "y", "width", "height"] as const)
    if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || Number(r[key]) < (key === "x" || key === "y" ? 0 : 1))
      throw new Error("Invalid Herdr layout rectangle.");
  return { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) };
}
export function contains(a: Rect, b: Rect) { return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height; }
export function sameRect(a: Rect, b: Rect) { return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }
export function splitRect(r: Rect, direction: "right" | "down", ratio: number): [Rect, Rect] {
  // Herdr 0.9.3 uses f32 multiplication and round for the first child.
  const size = Math.round(Math.fround((direction === "right" ? r.width : r.height) * Math.fround(ratio)));
  return direction === "right" ? [{ ...r, width: size }, { ...r, x: r.x + size, width: r.width - size }] :
    [{ ...r, height: size }, { ...r, y: r.y + size, height: r.height - size }];
}
export function leaves(t: Tree): string[] { return "pane" in t ? [t.pane] : [...leaves(t.left), ...leaves(t.right)]; }
export function equalTree(a: Tree, b: Tree): boolean {
  if ("pane" in a || "pane" in b) return "pane" in a && "pane" in b && a.pane === b.pane;
  return a.direction === b.direction && Math.fround(a.ratio) === Math.fround(b.ratio) && equalTree(a.left, b.left) && equalTree(a.right, b.right);
}
export function cells(t: Tree, area: Rect, out = new Map<string, Rect>()): Map<string, Rect> {
  if ("pane" in t) out.set(t.pane, area);
  else { const [a, b] = splitRect(area, t.direction, t.ratio); cells(t.left, a, out); cells(t.right, b, out); }
  return out;
}
export function snapshot(raw: unknown): Snapshot {
  const l = object(raw, "layout"), area = rectangle(l.area);
  if (!Array.isArray(l.panes) || !Array.isArray(l.splits) || typeof l.zoomed !== "boolean") throw new Error("Missing Herdr layout panes/splits/zoom.");
  const panes = new Map<string, Rect>();
  for (const rawPane of l.panes) {
    const p = object(rawPane, "layout pane"), id = string(p.pane_id, "layout pane_id"), r = rectangle(p.rect);
    if (panes.has(id) || !contains(area, r)) throw new Error("Inconsistent Herdr layout panes.");
    panes.set(id, r);
  }
  const splits = l.splits.map(rawSplit => {
    const s = object(rawSplit, "layout split"), r = rectangle(s.rect);
    if (!contains(area, r) || (s.direction !== "right" && s.direction !== "down") || typeof s.ratio !== "number" || !Number.isFinite(s.ratio) || s.ratio < 0.1 || s.ratio > 0.9)
      throw new Error("Inconsistent Herdr layout split.");
    return { rect: r, direction: s.direction as "right" | "down", ratio: s.ratio };
  });
  const usedPanes = new Set<string>(), usedSplits = new Set<number>();
  const walk = (r: Rect): Tree => {
    const ps = [...panes].filter(([, p]) => sameRect(p, r)), ss = splits.map((s, i) => ({ s, i })).filter(({ s }) => sameRect(s.rect, r));
    if (ps.length === 1 && !ss.length) { usedPanes.add(ps[0][0]); return { pane: ps[0][0] }; }
    if (ps.length || ss.length !== 1 || usedSplits.has(ss[0].i)) throw new Error("Incomplete/overlapping Herdr layout tree.");
    const { s, i } = ss[0]; usedSplits.add(i);
    const [a, b] = splitRect(r, s.direction, s.ratio);
    if (Math.min(a.width, a.height, b.width, b.height) < 1) throw new Error("Empty Herdr layout branch.");
    return { direction: s.direction, ratio: s.ratio, left: walk(a), right: walk(b) };
  };
  const tree = walk(area);
  if (usedPanes.size !== panes.size || usedSplits.size !== splits.length) throw new Error("Inconsistent Herdr layout coverage.");
  return { tabId: string(l.tab_id, "layout tab_id"), workspaceId: string(l.workspace_id, "layout workspace_id"), zoomed: l.zoomed, area, panes, tree };
}
export function region(t: Tree, ids: string[], area: Rect): { tree: Tree; rect: Rect } {
  const wanted = new Set(ids), present = new Set(leaves(t));
  if (wanted.size !== ids.length || ids.some(id => !present.has(id))) throw new Error("Owned pane missing/duplicated in Herdr layout.");
  const find = (node: Tree, rect: Rect): { tree: Tree; rect: Rect } => {
    const all = leaves(node);
    if (all.length === wanted.size && all.every(id => wanted.has(id))) return { tree: node, rect };
    if (!("pane" in node)) {
      const [a, b] = splitRect(rect, node.direction, node.ratio);
      if (ids.every(id => leaves(node.left).includes(id))) return find(node.left, a);
      if (ids.every(id => leaves(node.right).includes(id))) return find(node.right, b);
    }
    throw new Error("Principal/children region is not a dedicated BSP subtree; refusing user pane control.");
  };
  return find(t, area);
}
export function insert(t: Tree, target: string, id: string, direction: "right" | "down", ratio: number): Tree {
  if ("pane" in t) return t.pane === target ? { direction, ratio: Math.fround(ratio), left: t, right: { pane: id } } : t;
  return { ...t, left: insert(t.left, target, id, direction, ratio), right: insert(t.right, target, id, direction, ratio) };
}
export function swap(t: Tree, a: string, b: string): Tree {
  if ("pane" in t) return { pane: t.pane === a ? b : t.pane === b ? a : t.pane };
  return { ...t, left: swap(t.left, a, b), right: swap(t.right, a, b) };
}
export function remove(t: Tree, id: string): Tree | undefined {
  if ("pane" in t) return t.pane === id ? undefined : t;
  const a = remove(t.left, id), b = remove(t.right, id);
  return a && b ? { ...t, left: a, right: b } : a ?? b;
}
function rows(ids: string[]): Tree {
  return ids.length === 1 ? { pane: ids[0] } : { direction: "down", ratio: Math.fround(1 / ids.length), left: { pane: ids[0] }, right: rows(ids.slice(1)) };
}
export function settled(main: string, children: string[]): Tree {
  if (!children.length) return { pane: main };
  const right = children.length <= 3 ? rows(children) : { direction: "right" as const, ratio: 0.5, left: rows(children.slice(0, 3)), right: rows(children.slice(3)) };
  return { direction: "right", ratio: 0.5, left: { pane: main }, right };
}
export type Operation = { kind: "split"; slot: number; target: number | "principal"; direction: "right" | "down"; ratio: number } |
  { kind: "swap"; worker: number; slot: number } | { kind: "close"; slot: number };
export function operations(count: number, workers: number): Operation[] {
  if (!Number.isInteger(count) || count < 1 || count > 6 || (workers !== count && workers !== count - 1)) throw new Error("Invalid layout child count.");
  const ops: Operation[] = [{ kind: "split", slot: 0, target: "principal", direction: "right", ratio: 0.5 }];
  if (count > 3) ops.push({ kind: "split", slot: 3, target: 0, direction: "right", ratio: 0.5 });
  const columns = count > 3 ? [[0, 1, 2], Array.from({ length: count - 3 }, (_, i) => i + 3)] : [Array.from({ length: count }, (_, i) => i)];
  for (const col of columns) for (let i = 1; i < col.length; i++) ops.push({ kind: "split", slot: col[i], target: col[i - 1], direction: "down", ratio: 1 / (col.length - i + 1) });
  for (let i = 0; i < workers; i++) ops.push({ kind: "swap", worker: i, slot: i });
  for (let i = 0; i < workers; i++) ops.push({ kind: "close", slot: i });
  return ops;
}
export function minimum(tree: Tree, area: Rect, owned: string[]) {
  const map = cells(tree, area);
  if (owned.some(id => !map.has(id) || map.get(id)!.width < 3 || map.get(id)!.height < 3))
    throw new Error("Principal region too small for a safe same-tab transition (minimum 3×3 cells per pane); enlarge it. No staging fallback.");
}
export function preflight(s: Snapshot, main: string, workers: string[], count: number, next = 0, knownSlots: (string | undefined)[] = []) {
  let t = s.tree;
  const slots = Array.from({ length: count }, (_, i) => knownSlots[i] ?? "@slot:" + i);
  const present = new Set(leaves(t));
  const all = [main, ...workers, ...knownSlots.filter((id): id is string => !!id && present.has(id))];
  minimum(t, s.area, all);
  for (const op of operations(count, workers.length).slice(next)) {
    if (op.kind === "split") { t = insert(t, op.target === "principal" ? main : slots[op.target], slots[op.slot], op.direction, op.ratio); all.push(slots[op.slot]); }
    else if (op.kind === "swap") t = swap(t, workers[op.worker], slots[op.slot]);
    else { t = remove(t, slots[op.slot])!; all.splice(all.indexOf(slots[op.slot]), 1); }
    minimum(t, s.area, all);
  }
}
