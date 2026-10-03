import { type Control, object, string } from "./herdr.ts";

export interface PaneRef {
  paneId: string; terminalId: string; tabId: string; workspaceId: string;
  agentName?: string; sessionPath?: string; sessionId?: string; staging?: boolean;
}
export function paneRef(raw: unknown): PaneRef {
  const p = object(raw, "pane");
  return { paneId: string(p.pane_id, "pane_id"), terminalId: string(p.terminal_id, "terminal_id"),
    tabId: string(p.tab_id, "tab_id"), workspaceId: string(p.workspace_id, "workspace_id") };
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
export class Layout {
  readonly serial = new Serial();
  readonly cli: Control;
  readonly principal: PaneRef;
  readonly changed: () => Promise<void>;
  constructor(cli: Control, principal: PaneRef, changed: () => Promise<void>) { this.cli = cli; this.principal = principal; this.changed = changed; }
  async validate(ref: PaneRef): Promise<Record<string, unknown>> {
    const p = object((await this.cli.json(["pane", "get", ref.paneId])).pane, "pane");
    if (p.terminal_id !== ref.terminalId || p.workspace_id !== ref.workspaceId || p.tab_id !== ref.tabId)
      throw new Error("Pane moved or replaced; refusing control: " + ref.paneId);
    if (ref.agentName) {
      const a = object((await this.cli.json(["agent", "get", ref.agentName])).agent, "agent");
      const session = object(a.agent_session, "agent_session");
      if (a.pane_id !== ref.paneId || a.terminal_id !== ref.terminalId || a.name !== ref.agentName || a.agent !== "pi" ||
          !((session.kind === "path" && session.value === ref.sessionPath) || (session.kind === "id" && session.value === ref.sessionId)))
        throw new Error("Agent identity changed; refusing control: " + ref.paneId);
      return a;
    }
    if (p.agent) throw new Error("Unexpected agent in reserved shell: " + ref.paneId);
    return p;
  }
  async checkTab(refs: PaneRef[]) {
    const main = paneRef((await this.cli.json(["pane", "current", "--pane", this.principal.paneId])).pane);
    if (main.terminalId !== this.principal.terminalId || main.tabId !== this.principal.tabId)
      throw new Error("Principal moved/replaced; reload the extension in its current tab.");
    const layout = object((await this.cli.json(["pane", "layout", "--pane", main.paneId])).layout, "layout");
    if (layout.zoomed !== false) throw new Error("Unzoom the tab before delegation.");
    const allowed = new Set([main.paneId, ...refs.filter(r => r.tabId === main.tabId).map(r => r.paneId)]);
    if (!Array.isArray(layout.panes) || layout.panes.some(p => !allowed.has(String(object(p, "layout pane").pane_id))))
      throw new Error("Tab contains unmanaged panes. MVP requires only the principal before first delegation.");
    for (const ref of refs) {
      if (ref.workspaceId !== main.workspaceId || (ref.tabId !== main.tabId && !ref.staging))
        throw new Error("Principal/child topology changed externally; restore the original tab before control.");
      await this.validate(ref);
    }
  }
  private async focusedChild(refs: PaneRef[]) {
    for (const ref of refs) {
      const p = object((await this.cli.json(["pane", "get", ref.paneId])).pane, "pane");
      if (p.focused === true) return ref;
    }
    return undefined;
  }
  private async restoreFocus(saved: PaneRef | undefined, refs: PaneRef[]) {
    if (!saved || !refs.includes(saved)) return;
    const main = object((await this.cli.json(["pane", "get", this.principal.paneId])).pane, "pane");
    // Moving the selected child falls back to the principal. If the user selected
    // another pane/tab/workspace meanwhile, don't steal their new focus.
    if (main.focused !== true) return;
    await this.validate(saved);
    if (saved.agentName) await this.cli.json(["agent", "focus", saved.agentName]);
    else {
      let restored = false;
      for (const source of [this.principal, ...refs]) {
        if (source === saved) continue;
        for (const direction of ["left", "right", "up", "down"]) {
          const neighbor = object((await this.cli.json(["pane", "neighbor", "--pane", source.paneId, "--direction", direction])).neighbor, "neighbor");
          if (neighbor.neighbor_pane_id === saved.paneId) {
            await this.cli.json(["pane", "focus", "--pane", source.paneId, "--direction", direction]);
            restored = true; break;
          }
        }
        if (restored) break;
      }
      if (!restored) throw new Error("Could not restore owned pane focus after staging.");
    }
  }
  private async move(ref: PaneRef, destination: string[], target?: PaneRef, ratio = 0.5, direction = "down") {
    await this.validate(ref);
    if (target && target !== this.principal) await this.validate(target);
    const args = ["pane", "move", ref.paneId, ...destination, "--no-focus"];
    if (target) args.push("--target-pane", target.paneId, "--split", direction, "--ratio", String(ratio));
    const result = object((await this.cli.json(args)).move_result, "move_result");
    if (result.changed !== true) throw new Error("Move did not apply: " + String(result.reason));
    const next = paneRef(result.pane);
    if (next.terminalId !== ref.terminalId || next.workspaceId !== ref.workspaceId)
      throw new Error("Move changed terminal/workspace identity.");
    Object.assign(ref, next, { staging: next.tabId !== this.principal.tabId });
    await this.changed();
  }
  // Only leaf splits and cross-tab moves. Never layout.apply or a worker restart.
  private async assemble(refs: PaneRef[]) {
    const first = refs[0];
    await this.move(first, ["--tab", this.principal.tabId], this.principal, 0.5, "right");
    const columns = refs.length > 3 ? [refs.slice(0, 3), refs.slice(3)] : [refs];
    if (columns.length === 2) await this.move(columns[1][0], ["--tab", this.principal.tabId], first, 0.5, "right");
    for (const column of columns) {
      for (let i = 1; i < column.length; i++)
        await this.move(column[i], ["--tab", this.principal.tabId], column[i - 1], 1 / (column.length - i + 1));
    }
  }
  async add(refs: PaneRef[], cwd: string, env: Record<string, string>, own: (ref: PaneRef) => Promise<void>): Promise<PaneRef> {
    refs = [...refs]; // The ownership callback may append to the caller\'s array.
    await this.checkTab(refs);
    const focused = await this.focusedChild(refs);
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", k + "=" + v]);
    let ref: PaneRef;
    if (refs.length === 0) {
      ref = paneRef((await this.cli.json(["pane", "split", this.principal.paneId, "--direction", "right", "--ratio", "0.5", "--cwd", cwd, "--no-focus", ...envArgs])).pane);
      await own(ref);
    } else {
      const created = await this.cli.json(["tab", "create", "--workspace", this.principal.workspaceId, "--label", "hs-staging", "--cwd", cwd, "--no-focus", ...envArgs]);
      ref = paneRef(created.root_pane);
      ref.staging = true;
      await own(ref); // Persist ownership before any subsequent remote mutation.
      for (const existing of refs) await this.move(existing, ["--tab", ref.tabId], ref);
      await this.assemble([...refs, ref]);
    }
    await this.restoreFocus(focused, [...refs, ref]);
    return ref;
  }
  async compact(refs: PaneRef[]) {
    await this.checkTab(refs);
    if (refs.length === 0) return;
    const focused = await this.focusedChild(refs);
    const first = refs[0];
    await this.move(first, ["--new-tab", "--workspace", this.principal.workspaceId, "--label", "hs-staging"]);
    for (const ref of refs.slice(1)) await this.move(ref, ["--tab", first.tabId], first);
    await this.assemble(refs);
    await this.restoreFocus(focused, refs);
    // Herdr removes a source tab automatically when its last pane leaves.
  }
  async close(ref: PaneRef, survivors: PaneRef[], closed: () => Promise<void> = async () => {}) {
    await this.checkTab([ref, ...survivors]);
    await this.validate(ref);
    await this.cli.json(["pane", "close", ref.paneId]);
    await closed(); // Persist that this is no longer a live target before compaction.
    await this.changed();
    await this.compact(survivors);
  }
}
