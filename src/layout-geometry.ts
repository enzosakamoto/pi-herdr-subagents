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
export function region(t: Tree, ids: string[], area: Rect): { tree: Tree; rect: Rect; path: boolean[] } {
  const wanted = new Set(ids), present = new Set(leaves(t));
  if (wanted.size !== ids.length || ids.some(id => !present.has(id))) throw new Error("Owned pane missing/duplicated in Herdr layout.");
  const find = (node: Tree, rect: Rect, path: boolean[]): { tree: Tree; rect: Rect; path: boolean[] } => {
    const all = leaves(node);
    if (all.length === wanted.size && all.every(id => wanted.has(id))) return { tree: node, rect, path };
    if (!("pane" in node)) {
      const [a, b] = splitRect(rect, node.direction, node.ratio);
      if (ids.every(id => leaves(node.left).includes(id))) return find(node.left, a, [...path, false]);
      if (ids.every(id => leaves(node.right).includes(id))) return find(node.right, b, [...path, true]);
    }
    throw new Error("Principal/children region is not a dedicated BSP subtree; refusing user pane control.");
  };
  return find(t, area, []);
}
export function insert(t: Tree, target: string, id: string, direction: "right" | "down", ratio: number): Tree {
  if ("pane" in t) return t.pane === target ? { direction, ratio: Math.fround(ratio), left: t, right: { pane: id } } : t;
  return { ...t, left: insert(t.left, target, id, direction, ratio), right: insert(t.right, target, id, direction, ratio) };
}
export function remove(t: Tree, id: string): Tree | undefined {
  if ("pane" in t) return t.pane === id ? undefined : t;
  const a = remove(t.left, id), b = remove(t.right, id);
  return a && b ? { ...t, left: a, right: b } : a ?? b;
}
export const NEW_PANE = "@new-child";
export type Operation = { kind: "split"; target: string; pane: string; direction: "right" | "down"; ratio: number } |
  { kind: "ratio"; path: boolean[]; ratio: number };
export function at(t: Tree, path: boolean[]): Tree {
  for (const side of path) {
    if ("pane" in t) throw new Error("Invalid layout split path.");
    t = side ? t.right : t.left;
  }
  return t;
}
export function apply(t: Tree, op: Operation): Tree {
  if (op.kind === "split") {
    if (!leaves(t).includes(op.target) || leaves(t).includes(op.pane)) throw new Error("Invalid fresh layout split.");
    return insert(t, op.target, op.pane, op.direction, op.ratio);
  }
  const replace = (node: Tree, path: boolean[]): Tree => {
    if ("pane" in node) throw new Error("Invalid layout split path.");
    if (!path.length) return { ...node, ratio: Math.fround(op.ratio) };
    return path[0] ? { ...node, right: replace(node.right, path.slice(1)) } : { ...node, left: replace(node.left, path.slice(1)) };
  };
  return replace(t, op.path);
}
export function columns(t: Tree, main: string, children: string[]) {
  const local = region(t, [main, ...children], { x: 0, y: 0, width: 100000, height: 100000 });
  const cols: { tree: Tree; path: boolean[]; ids: string[] }[] = [], ratios: { path: boolean[]; ratio: number }[] = [];
  const invalid = (): never => { throw new Error("Unsupported owned layout topology; reconcile manually."); };
  const column = (node: Tree, path: boolean[]) => {
    const vertical = (n: Tree): boolean => "pane" in n || n.direction === "down" && vertical(n.left) && vertical(n.right);
    const ids = leaves(node);
    if (!vertical(node) || ids.includes(main) || ids.length > 3) invalid();
    cols.push({ tree: node, path, ids });
  };
  const n = local.tree, p = local.path;
  if (!children.length) { if (!("pane" in n) || n.pane !== main) invalid(); }
  else if (!("pane" in n) && n.direction === "right") {
    if ("pane" in n.left && n.left.pane === main) {
      ratios.push({ path: p, ratio: 0.5 });
      const r = n.right;
      if (!("pane" in r) && r.direction === "right") {
        ratios.push({ path: [...p, true], ratio: 0.5 });
        column(r.left, [...p, true, false]); column(r.right, [...p, true, true]);
      } else column(r, [...p, true]);
    } else {
      const l = n.left;
      if ("pane" in l || l.direction !== "right" || !("pane" in l.left) || l.left.pane !== main) return invalid();
      ratios.push({ path: p, ratio: 0.75 }, { path: [...p, false], ratio: 2 / 3 });
      column(l.right, [...p, false, true]); column(n.right, [...p, true]);
    }
  } else invalid();
  return { columns: cols, ratios };
}
export function plan(base: Tree, main: string, children: string[], mode: "add" | "compact", pane = NEW_PANE): Operation[] {
  if (children.length > 6 || mode === "add" && children.length >= 6) throw new Error("At most six layout children are allowed.");
  const ops: Operation[] = []; let t = base;
  const push = (op: Operation) => { ops.push(op); t = apply(t, op); };
  const ratio = (path: boolean[], value: number) => {
    const node = at(t, path);
    if ("pane" in node) throw new Error("Invalid layout split path.");
    if (Math.fround(node.ratio) !== Math.fround(value)) push({ kind: "ratio", path, ratio: Math.fround(value) });
  };
  const normalize = (ids: string[]) => {
    const shape = columns(t, main, ids);
    for (const r of shape.ratios) ratio(r.path, r.ratio);
    const rows = (node: Tree, path: boolean[]) => {
      if ("pane" in node) return;
      ratio(path, leaves(node.left).length / leaves(node).length);
      rows(node.left, [...path, false]); rows(node.right, [...path, true]);
    };
    for (const col of shape.columns) rows(col.tree, col.path);
  };
  normalize(children);
  if (mode === "compact") return ops;
  const shape = columns(t, main, children), cols = shape.columns;
  if (!cols.length) push({ kind: "split", target: main, pane, direction: "right", ratio: 0.5 });
  else if (cols.length === 1) {
    if (cols[0].ids.length === 1) push({ kind: "split", target: cols[0].ids[0], pane, direction: "right", ratio: 0.5 });
    else {
      ratio(shape.ratios[0].path, 0.75);
      push({ kind: "split", target: main, pane, direction: "right", ratio: Math.fround(2 / 3) });
    }
  } else {
    const col = cols[0].ids.length <= cols[1].ids.length ? cols[0] : cols[1];
    // Give the bottom pane the space for both rows before splitting it.
    if (col.ids.length === 2) ratio(col.path, 1 / 3);
    push({ kind: "split", target: col.ids.at(-1)!, pane, direction: "down", ratio: 0.5 });
  }
  normalize([...children, pane]); return ops;
}
export function minimum(tree: Tree, area: Rect, owned: string[]) {
  const map = cells(tree, area);
  if (owned.some(id => !map.has(id) || map.get(id)!.width < 3 || map.get(id)!.height < 3))
    throw new Error("Principal region too small for a safe incremental transition (minimum 3×3 cells per pane); enlarge it. No staging fallback.");
}
export function preflight(tree: Tree, area: Rect, ops: Operation[], owned: string[]) {
  let t = tree;
  for (let i = 0; i <= ops.length; i++) {
    minimum(t, area, owned.filter(id => leaves(t).includes(id)));
    if (i < ops.length) t = apply(t, ops[i]);
  }
}
