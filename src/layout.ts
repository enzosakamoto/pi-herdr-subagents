import { type Control, HerdrError, object, string } from "./herdr.ts";
import { snapshot, region, leaves, equalTree, insert, swap, remove, settled, operations, preflight, minimum, type Snapshot, type Tree, type Operation } from "./layout-geometry.ts";
import { checkedState, sameRef, occupant, type FocusRef, type CloseFocusState, type LayoutRecord, type LayoutState, type LayoutStore } from "./layout-state.ts";

export interface PaneRef {
  paneId: string; terminalId: string; tabId: string; workspaceId: string;
  agentName?: string; sessionPath?: string; sessionId?: string; staging?: boolean;
  shell?: { pid: number; name: string; argv0?: string; argv?: string[] };
}
export function paneRef(raw: unknown): PaneRef {
  const p = object(raw, "pane");
  return { paneId: string(p.pane_id, "pane_id"), terminalId: string(p.terminal_id, "terminal_id"),
    tabId: string(p.tab_id, "tab_id"), workspaceId: string(p.workspace_id, "workspace_id") };
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn); this.tail = next.catch(() => {}); return next;
  }
}
function rejected(e: unknown) {
  return e instanceof HerdrError && !e.uncertain && !["invalid_response", "cli_error"].includes(e.code);
}
export class Layout {
  readonly serial = new Serial();
  readonly cli: Control;
  readonly principal: PaneRef;
  readonly changed: () => Promise<void>;
  readonly store: LayoutStore;
  private record: LayoutRecord | null = null;
  private active = 0;
  constructor(cli: Control, principal: PaneRef, changed: () => Promise<void>, store?: LayoutStore) {
    this.cli = cli; this.principal = principal; this.changed = changed;
    this.store = store ?? { owner: "standalone", taskIds: () => [], persist: async () => {} };
  }
  get pending() { return this.record !== null; }
  get needsRecovery() { return this.pending && this.active === 0; }
  get state(): LayoutState | undefined { return this.record ? { transactionId: this.record.id, record: structuredClone(this.record) } : undefined; }
  get reservedPane() {
    const t = this.record;
    return t && t.workers.length < t.count ? t.slots[t.count - 1] ?? undefined : undefined;
  }
  get reservedTaskId() { return this.record?.newTaskId; }
  load(state: LayoutState | null) {
    this.record = state === null ? null : checkedState(state, this.principal, this.store.owner, this.store.taskIds()).record;
  }
  private async save() {
    if (!this.record) return;
    await this.store.persist({ transactionId: this.record.id, record: structuredClone(this.record) });
  }
  private async identity(ref: PaneRef): Promise<Record<string, unknown>> {
    const p = object((await this.cli.json(["pane", "get", ref.paneId])).pane, "pane");
    if (!sameRef(paneRef(p), ref)) throw new Error("Pane moved or replaced; refusing control: " + ref.paneId);
    if (ref.agentName) {
      const a = object((await this.cli.json(["agent", "get", ref.agentName])).agent, "agent");
      if (!a.agent_session) throw new Error("Missing Herdr pi session reporting. Check herdr integration status; update separately with consent. Pane retained.");
      const session = object(a.agent_session, "agent_session");
      if (a.pane_id !== ref.paneId || a.terminal_id !== ref.terminalId || a.name !== ref.agentName || a.agent !== "pi" ||
          !((session.kind === "path" && session.value === ref.sessionPath) || (session.kind === "id" && session.value === ref.sessionId)))
        throw new Error("Agent identity changed; refusing control: " + ref.paneId);
      return a;
    }
    if (p.agent) throw new Error("Unexpected agent in reserved shell: " + ref.paneId);
    return p;
  }
  async validate(ref: PaneRef): Promise<Record<string, unknown>> {
    const p = await this.identity(ref);
    if (!ref.agentName) await this.awaitShell(ref);
    return p;
  }
  async checkTab(refs: PaneRef[]): Promise<Snapshot> {
    const main = paneRef((await this.cli.json(["pane", "current", "--pane", this.principal.paneId])).pane);
    if (!sameRef(main, this.principal)) throw new Error("Principal moved/replaced; reload the extension in its current tab.");
    const s = snapshot((await this.cli.json(["pane", "layout", "--pane", main.paneId])).layout);
    if (s.tabId !== main.tabId || s.workspaceId !== main.workspaceId) throw new Error("Principal layout changed tabs/workspaces; reconcile before control.");
    if (s.zoomed) throw new Error("Unzoom the tab before delegation.");
    for (const ref of refs) {
      if (ref.tabId !== main.tabId || ref.workspaceId !== main.workspaceId)
        throw new Error("Legacy staging or changed child topology; reconcile manually. Same-tab controller never moves panes across tabs.");
      await this.validate(ref);
    }
    const known = new Map(refs.map(r => [r.paneId, r]));
    for (const ref of this.record?.slots ?? []) if (ref && s.panes.has(ref.paneId) && !known.has(ref.paneId)) {
      await this.validate(ref); known.set(ref.paneId, ref);
    }
    region(s.tree, [main.paneId, ...known.keys()], s.area);
    return s;
  }
  private shell(info: Record<string, unknown>): PaneRef["shell"] {
    if (typeof info.shell_pid !== "number" || !Number.isSafeInteger(info.shell_pid) || info.shell_pid <= 0 || info.foreground_process_group_id !== info.shell_pid || !Array.isArray(info.foreground_processes) || info.foreground_processes.length !== 1) return;
    const p = object(info.foreground_processes[0], "shell process");
    if (p.pid !== info.shell_pid || typeof p.name !== "string") return;
    // PID equality alone cannot distinguish a shell from `exec python`.
    if (!["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "pwsh"].includes(p.name)) return;
    return { pid: info.shell_pid, name: p.name, ...(typeof p.argv0 === "string" ? { argv0: p.argv0 } : {}),
      ...(Array.isArray(p.argv) && p.argv.every(v => typeof v === "string") ? { argv: p.argv as string[] } : {}) };
  }
  private checkShellIdentity(ref: PaneRef, info: Record<string, unknown>) {
    const expected = ref.shell;
    if (!expected) return;
    const changed = (field: string) => { throw new Error("Shell identity changed (" + field + "); refusing control: " + ref.paneId); };
    if (typeof info.shell_pid === "number" && Number.isSafeInteger(info.shell_pid) && info.shell_pid > 0 && info.shell_pid !== expected.pid) changed("PID");
    if (!Array.isArray(info.foreground_processes)) return;
    const p = info.foreground_processes.map(raw => object(raw, "foreground process")).find(p => p.pid === expected.pid);
    // A child foreground group may not include the shell. This is not proof
    // of replacement, but it is also not permission to mutate the terminal.
    if (!p) return;
    if (typeof p.name === "string" && p.name !== expected.name) changed("name");
    if (expected.argv0 !== undefined && typeof p.argv0 === "string" && p.argv0 !== expected.argv0) changed("argv0");
    if (expected.argv !== undefined && Array.isArray(p.argv) && p.argv.every(v => typeof v === "string") && JSON.stringify(p.argv) !== JSON.stringify(expected.argv)) changed("argv");
  }
  async awaitShell(ref: PaneRef) {
    if (ref.agentName) throw new Error("Expected a reserved shell, not a bound agent: " + ref.paneId);
    let reason = "foreground unproven";
    for (const delay of [0, 100, 200, 400, 800, 1200]) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      await this.identity(ref); // Do not recursively invoke foreground validation.
      const info = object((await this.cli.json(["pane", "process-info", "--pane", ref.paneId])).process_info, "process_info");
      this.checkShellIdentity(ref, info);
      const shell = this.shell(info), expected = ref.shell;
      if (shell) {
        if (expected && ((expected.argv0 !== undefined && shell.argv0 === undefined) || (expected.argv !== undefined && shell.argv === undefined))) {
          reason = "captured shell arguments temporarily unavailable"; continue;
        }
        ref.shell ??= shell; return; // Never replace an existing fingerprint.
      }
      reason = "foreground busy, unavailable or not a recognized shell";
    }
    throw new Error("Reserved pane did not reach proven shell foreground (" + reason + "); pane retained: " + ref.paneId);
  }
  async startAgent(ref: PaneRef, args: string[], beforeSend: () => Promise<void> = async () => {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.awaitShell(ref);
      await beforeSend(); // Durable launch intent follows local shell readiness.
      try { await this.cli.json(args); return; }
      catch (e) {
        if (!(e instanceof HerdrError) || e.code !== "agent_pane_busy" || e.uncertain || attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1))); await this.validate(ref);
      }
    }
  }
  private async focused(): Promise<FocusRef | undefined> {
    const data = await this.cli.json(["pane", "list"]);
    if (!Array.isArray(data.panes)) throw new Error("Missing focused pane snapshot.");
    const focused = data.panes.map(raw => object(raw, "pane")).filter(p => p.focused === true);
    if (focused.length !== 1) throw new Error("Cannot prove a unique current focus; no layout control attempted.");
    return { ...paneRef(focused[0]), occupant: occupant(focused[0]) };
  }
  private async checkFocus(t: LayoutRecord) {
    const current = await this.focused();
    if (current?.paneId !== (t.lastFocus ?? t.focus?.paneId)) {
      t.focusChanged = true; await this.save();
      throw new Error("Focus changed externally; layout paused. Consult status to reconcile using the current focus.");
    }
  }
  private async restoreFocus(t: Pick<LayoutRecord, "focus" | "lastFocus" | "focusChanged" | "workers">) {
    if (!t.focus || !t.lastFocus || t.focusChanged || (await this.focused())?.paneId !== t.lastFocus) return;
    const source = t.workers.find(p => p.paneId === t.lastFocus);
    if (source) { try { await this.validate(source); } catch { return; } }
    else if (t.lastFocus === t.focus.paneId && (await this.focused())?.occupant !== t.focus.occupant) return;
    let target: Record<string, unknown>;
    try { target = object((await this.cli.json(["pane", "get", t.focus.paneId])).pane, "pane"); }
    catch (e) { if (e instanceof HerdrError && e.code === "pane_not_found") return; throw e; }
    if (!sameRef(paneRef(target), t.focus) || occupant(target) !== t.focus.occupant) return;
    if (target.focused === true) return;
    const l = object((await this.cli.json(["pane", "layout", "--pane", t.focus.paneId])).layout, "focus layout");
    if (!Array.isArray(l.panes)) throw new Error("Missing focus layout.");
    let restored = false;
    if (l.panes.length === 1) {
      if ((await this.focused())?.paneId !== t.lastFocus) { t.focusChanged = true; return; }
      await this.cli.json(["tab", "focus", t.focus.tabId]); restored = true;
    } else for (const raw of l.panes) {
      const source = string(object(raw, "focus pane").pane_id, "pane_id");
      if (source === t.focus.paneId) continue;
      for (const direction of ["left", "right", "up", "down"]) {
        const n = object((await this.cli.json(["pane", "neighbor", "--pane", source, "--direction", direction])).neighbor, "neighbor");
        if (n.neighbor_pane_id === t.focus.paneId) {
          // No atomic focus CAS exists; avoid overwriting an observed new selection.
          if ((await this.focused())?.paneId !== t.lastFocus) { t.focusChanged = true; return; }
          await this.cli.json(["pane", "focus", "--pane", source, "--direction", direction]); restored = true; break;
        }
      }
      if (restored) break;
    }
    if (!restored || (await this.focused())?.paneId !== t.focus.paneId) throw new Error("Could not restore initial focus after same-tab layout.");
    t.lastFocus = t.focus.paneId; await this.save();
  }
  private async begin(refs: PaneRef[], count: number, cwd: string, env: Record<string, string>) {
    if (this.pending) throw new Error("Layout transaction pending; reconcile with status before another spawn.");
    const s = await this.checkTab(refs);
    preflight(s, this.principal.paneId, refs.map(r => r.paneId), count);
    let newTaskId: string | undefined;
    if (env.PI_HERDR_SUBAGENT) newTaskId = string(object(JSON.parse(env.PI_HERDR_SUBAGENT), "child marker").taskId, "taskId");
    const taskIds = this.store.tasksFor?.(refs.map(r => r.paneId)) ?? this.store.taskIds();
    if (newTaskId && !taskIds.includes(newTaskId)) taskIds.push(newTaskId);
    this.record = { version: 1, id: crypto.randomUUID(), owner: this.store.owner, principal: { ...this.principal }, taskIds,
      workers: structuredClone(refs), count, cwd, env, newTaskId, slots: Array(count).fill(null), next: 0, baseTree: s.tree, tree: s.tree, focus: await this.focused() };
    await this.save();
  }
  private slot(t: LayoutRecord, index: number) {
    const ref = t.slots[index]; if (!ref) throw new Error("Missing owned layout slot."); return ref;
  }
  private after(t: LayoutRecord, op: Operation): Tree | undefined {
    if (op.kind === "split") {
      const ref = t.slots[op.slot];
      return ref ? insert(t.tree, op.target === "principal" ? this.principal.paneId : this.slot(t, op.target).paneId, ref.paneId, op.direction, op.ratio) : undefined;
    }
    return op.kind === "swap" ? swap(t.tree, t.workers[op.worker].paneId, this.slot(t, op.slot).paneId) : remove(t.tree, this.slot(t, op.slot).paneId);
  }
  private async proof(t: LayoutRecord, refs: PaneRef[]) {
    for (const worker of t.workers) {
      const owned = refs.find(r => sameRef(r, worker));
      if (!owned || worker.agentName !== owned.agentName || worker.sessionId !== owned.sessionId || worker.sessionPath !== owned.sessionPath)
        throw new Error("Layout worker identity not owned by the active task branch.");
    }
    const s = await this.checkTab(refs);
    const expected = t.intent?.after;
    if (!equalTree(s.tree, t.tree) && (!expected || !equalTree(s.tree, expected))) throw new Error("Layout topology changed during transaction; refusing unowned/uncertain panes.");
    const ids = [this.principal.paneId, ...t.workers.map(r => r.paneId), ...t.slots.filter((r): r is PaneRef => !!r && s.panes.has(r.paneId)).map(r => r.paneId)];
    minimum(s.tree, s.area, [...new Set(ids)]);
    return s;
  }
  private async confirm(t: LayoutRecord, refs: PaneRef[], op: Operation) {
    const s = await this.proof(t, refs), i = t.intent!;
    if (i.after && equalTree(s.tree, i.after)) {
      if (i.rejected) throw new Error("Topology changed after a rejected operation; intervention required.");
      if (op.kind === "close") {
        try { await this.cli.json(["pane", "get", this.slot(t, op.slot).paneId]); throw new Error("Closed auxiliary still exists outside its recorded region."); }
        catch (e) { if (!(e instanceof HerdrError) || e.code !== "pane_not_found") throw e; }
      }
      if (op.kind === "swap" && (await this.focused())?.paneId === t.workers[op.worker].paneId) t.lastFocus = t.workers[op.worker].paneId;
      t.tree = i.after; t.next++; delete t.intent; await this.save(); return true;
    }
    if (!i.rejected) throw new Error("Uncertain layout operation has no confirmed result; no automatic resend or pane adoption. Intervention required.");
    delete t.intent; await this.save(); return false;
  }
  private async execute(t: LayoutRecord, refs: PaneRef[], op: Operation, own?: (r: PaneRef) => Promise<void>) {
    const s = await this.proof(t, refs);
    preflight(s, this.principal.paneId, t.workers.map(r => r.paneId), t.count, t.next, t.slots.map(r => r?.paneId));
    await this.checkFocus(t);
    if (op.kind === "split" && op.target !== "principal") await this.awaitShell(this.slot(t, op.target));
    if (op.kind === "swap") { await this.validate(t.workers[op.worker]); await this.awaitShell(this.slot(t, op.slot)); }
    if (op.kind === "close") await this.awaitShell(this.slot(t, op.slot));
    t.intent = { before: t.tree, after: this.after(t, op) }; await this.save();
    let sent = false;
    try {
      // Persistence is asynchronous: recheck the *before* map before sending.
      // A coincidentally matching external swap must not be swapped back.
      const before = await this.proof(t, refs);
      if (!equalTree(before.tree, t.tree)) throw new Error("Layout changed before the recorded command was sent.");
      await this.checkFocus(t);
      if (op.kind === "close") await this.awaitShell(this.slot(t, op.slot));
      sent = true;
      if (op.kind === "split") {
        const target = op.target === "principal" ? this.principal : this.slot(t, op.target);
        const env = t.workers.length < t.count && op.slot === t.count - 1 ? t.env : {};
        const args = ["pane", "split", target.paneId, "--direction", op.direction, "--ratio", String(op.ratio), "--cwd", t.cwd, "--no-focus",
          ...Object.entries(env).flatMap(([k, v]) => ["--env", k + "=" + v])];
        const ref = paneRef((await this.cli.json(args)).pane);
        if (ref.tabId !== this.principal.tabId || ref.workspaceId !== this.principal.workspaceId || leaves(t.tree).includes(ref.paneId) || t.slots.some(p => p?.paneId === ref.paneId))
          throw new Error("Split did not return a fresh shell in the principal tab.");
        t.slots[op.slot] = ref; t.intent.after = this.after(t, op); await this.save();
        await this.awaitShell(ref); await this.save();
        if (t.workers.length < t.count && op.slot === t.count - 1 && own) await own(ref);
      } else if (op.kind === "swap") {
        const source = t.workers[op.worker], target = this.slot(t, op.slot);
        const r = object((await this.cli.json(["pane", "swap", "--source-pane", source.paneId, "--target-pane", target.paneId])).swap, "swap");
        if (r.changed !== true) throw new HerdrError("Swap did not apply: " + String(r.reason), "swap_rejected");
        t.lastFocus = source.paneId; await this.save();
        if (r.source_pane_id !== source.paneId || r.target_pane_id !== target.paneId || !equalTree(snapshot(r.layout).tree, t.intent.after!))
          throw new HerdrError("Unexpected swap response; reconcile before control.", "invalid_response", true);
      } else await this.cli.json(["pane", "close", this.slot(t, op.slot).paneId]);
    } catch (e) {
      if (!sent || rejected(e)) { t.intent.rejected = true; await this.save(); }
      throw e;
    }
    await this.confirm(t, refs, op);
  }
  private async run(refs: PaneRef[], own?: (r: PaneRef) => Promise<void>) {
    const t = this.record!;
    try {
      const ops = operations(t.count, t.workers.length);
      while (t.next < ops.length) {
        const op = ops[t.next];
        if (t.intent && await this.confirm(t, refs, op)) continue;
        await this.execute(t, refs, op, own);
      }
      const s = await this.proof(t, refs);
      const children = [...t.workers.map(r => r.paneId), ...(t.workers.length < t.count ? [this.slot(t, t.count - 1).paneId] : [])];
      if (!equalTree(region(s.tree, [this.principal.paneId, ...children], s.area).tree, settled(this.principal.paneId, children)))
        throw new Error("Same-tab layout did not settle; journal retained.");
      await this.restoreFocus(t);
      await this.store.persist({ transactionId: t.id, record: null }); this.record = null;
      await this.changed();
    } catch (e) {
      // A lost acknowledgement may still have a provable applied result. Observe
      // it (never resend), then restore the original focus before reporting failure.
      try {
        if (t.intent?.after) {
          const s = await this.proof(t, refs);
          if (equalTree(s.tree, t.intent.after)) await this.confirm(t, refs, operations(t.count, t.workers.length)[t.next]);
        }
        await this.restoreFocus(t); await this.save();
      } catch { /* Preserve the original failure and journal. */ }
      throw e;
    }
  }
  async recover(refs: PaneRef[], resetFocus = false, own?: (ref: PaneRef) => Promise<void>) {
    if (!this.record) return;
    const t = this.record;
    if (t.workers.length < t.count && !own && !refs.some(r => t.slots[t.count - 1] && sameRef(r, t.slots[t.count - 1]!)))
      throw new Error("New reservation needs an active-branch ownership callback before layout recovery.");
    this.active++;
    try {
      if (resetFocus) { this.record.focus = await this.focused(); delete this.record.lastFocus; delete this.record.focusChanged; await this.save(); }
      await this.run(refs, own);
      return t.workers.length < t.count ? this.slot(t, t.count - 1) : undefined;
    } finally { this.active--; }
  }
  async add(refs: PaneRef[], cwd: string, env: Record<string, string>, own: (ref: PaneRef) => Promise<void>): Promise<PaneRef> {
    this.active++;
    try {
      refs = [...refs];
      await this.begin(refs, refs.length + 1, cwd, env);
      const t = this.record!;
      await this.run(refs, own);
      return this.slot(t, t.count - 1);
    } finally { this.active--; }
  }
  async compact(refs: PaneRef[]) {
    this.active++;
    try {
      if (this.pending) { await this.recover(refs); return; }
      const s = await this.checkTab(refs);
      const local = region(s.tree, [this.principal.paneId, ...refs.map(r => r.paneId)], s.area);
      if (equalTree(local.tree, settled(this.principal.paneId, refs.map(r => r.paneId)))) return;
      await this.begin(refs, refs.length, this.store.cwd ?? process.cwd(), {}); await this.run(refs);
    } finally { this.active--; }
  }
  async restoreClosedFocus(state: CloseFocusState | undefined, closed: PaneRef) {
    if (!state?.last) return; // An unacknowledged close has no proven focus effect.
    if (state.version !== 1 || !sameRef(state.target, this.principal) || !sameRef(state.initial, closed)) throw new Error("Invalid closed-child focus ownership.");
    try { await this.cli.json(["pane", "get", closed.paneId]); throw new Error("Selected child is not confirmed closed."); }
    catch (e) { if (!(e instanceof HerdrError) || e.code !== "pane_not_found") throw e; }
    const current = await this.focused();
    if (!current || !sameRef(current, state.last) || current.occupant !== state.last.occupant) return;
    await this.restoreFocus({ focus: state.target, lastFocus: state.last.paneId, workers: [] });
  }
  async close(ref: PaneRef, survivors: PaneRef[], closed: () => Promise<void> = async () => {},
      saveFocus: (state: CloseFocusState | undefined) => Promise<void> = async () => {}) {
    if (this.pending) await this.recover([ref, ...survivors]);
    await this.checkTab([ref, ...survivors]); await this.validate(ref);
    const initial = await this.focused();
    const main = object((await this.cli.json(["pane", "get", this.principal.paneId])).pane, "principal focus");
    const focus: CloseFocusState | undefined = initial?.paneId === ref.paneId ?
      { version: 1, initial, target: { ...this.principal, occupant: occupant(main) } } : undefined;
    await saveFocus(focus); // Task persistence precedes the completed-child close.
    await this.cli.json(["pane", "close", ref.paneId]);
    if (focus) {
      const current = await this.focused();
      // Capture the acknowledged native selection. Any later observed change
      // prevents restoration; no focus CAS is available across this boundary.
      if (current && [this.principal, ...survivors].some(p => sameRef(p, current))) {
        focus.last = current; await saveFocus(focus); await this.restoreClosedFocus(focus, ref);
      }
    }
    await saveFocus(undefined);
    await closed(); await this.changed(); await this.compact(survivors);
  }
}
