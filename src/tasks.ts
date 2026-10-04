import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Control, HerdrError, object } from "./herdr.ts";
import { Layout, paneRef, type PaneRef } from "./layout.ts";
import { atomicJson, collect, readJson, zeroUsage, type Receipt, type Outcome } from "./results.ts";
import { splitModelId, type ModelSelection, type ModelSource, type Tier } from "./config.ts";
import { sameRef, type LayoutState, type CloseFocusState } from "./layout-state.ts";

export type State = "starting" | "working" | "blocked" | "collecting" | "completed" | "failed" | "cancelled" | "collection_failed" | "cleanup_pending";
export interface Task {
  taskId: string; task: string; instructions?: string; state: State; created: string;
  agentName: string; sessionId: string; directory: string; pane?: PaneRef;
  model?: string; thinking?: string; tier?: Tier; modelSource?: ModelSource;
  submitted: boolean; cancelRequested: boolean; launchAttempted?: boolean; diagnostic?: string; outcome?: Outcome; resultPath?: string;
  attentionSent?: boolean; notified?: boolean; closeFocus?: CloseFocusState; closeAttempted?: boolean;
}
export interface Hooks {
  persist(task: Task): Promise<void>;
  persistLayout?(state: LayoutState): Promise<void>;
  /** false means queued, not yet admitted to the principal transcript. */
  notify(task: Task, attention: boolean): Promise<boolean | void>;
}
export interface Defaults { cwd: string; model: string; thinking: string; packagePath: string }
export interface SpawnOptions extends ModelSelection { thinking: string }
export function finished(task: Task) { return ["completed", "failed", "cancelled"].includes(task.state) && !task.pane; }
export function view(task: Task) {
  return { taskId: task.taskId, state: task.state, agentName: task.agentName, paneId: task.pane?.paneId,
    model: task.model, tier: task.tier, modelSource: task.modelSource, thinking: task.thinking,
    diagnostic: task.diagnostic, resultPath: task.resultPath, result: task.outcome ? {
      text: task.outcome.text.slice(0, 12000), stopReason: task.outcome.stopReason, error: task.outcome.error,
      usage: task.outcome.usage, truncated: task.outcome.text.length > 12000
    } : undefined };
}
export class Tasks {
  readonly tasks = new Map<string, Task>();
  readonly controller = new AbortController();
  readonly pending = new Set<Promise<void>>();
  readonly cli: Control;
  readonly layout: Layout;
  readonly root: string;
  readonly defaults: Defaults;
  readonly hooks: Hooks;
  private layoutProblem?: string;
  constructor(cli: Control, principal: PaneRef, root: string, defaults: Defaults, hooks: Hooks) {
    this.root = resolve(root); this.defaults = defaults; this.hooks = hooks;
    this.cli = {
      json: (args, signal, timeout) => this.controller.signal.aborted || signal?.aborted ? Promise.reject(new HerdrError("Observer stopped before request.", "observer_stopped")) : cli.json(args, signal ?? this.controller.signal, timeout),
      text: (args, signal, timeout) => this.controller.signal.aborted || signal?.aborted ? Promise.reject(new HerdrError("Observer stopped before request.", "observer_stopped")) : cli.text(args, signal ?? this.controller.signal, timeout),
      setSplitRatio: (tabId, path, ratio, signal, timeout) => this.controller.signal.aborted || signal?.aborted ? Promise.reject(new HerdrError("Observer stopped before request.", "observer_stopped")) : cli.setSplitRatio(tabId, path, ratio, signal ?? this.controller.signal, timeout)
    };
    this.layout = new Layout(this.cli, principal, async () => {
      for (const task of this.tasks.values()) if (task.pane) await this.save(task);
    }, {
      owner: this.root, cwd: defaults.cwd, taskIds: () => [...this.tasks.keys()],
      tasksFor: panes => [...this.tasks.values()].filter(t => t.pane && panes.includes(t.pane.paneId)).map(t => t.taskId),
      persist: async state => {
        await atomicJson(join(this.root, "layout.json"), state);
        if (this.alive) await this.hooks.persistLayout?.(structuredClone(state));
      }
    });
  }
  private get alive() { return !this.controller.signal.aborted; }
  async stop() { this.controller.abort(); await Promise.allSettled([...this.pending]); }
  private ownRefs(exclude?: Task) { return [...this.tasks.values()].filter(t => t !== exclude && t.pane).map(t => t.pane!); }
  private async save(task: Task) {
    await atomicJson(join(task.directory, "task.json"), task);
    if (this.alive) await this.hooks.persist(structuredClone(task));
  }
  private launch(fn: () => Promise<void>) {
    const promise = fn().catch(() => {}).finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }
  async spawn(taskText: string, instructions?: string, options?: SpawnOptions): Promise<Task> {
    if (!this.alive) throw new Error("Session observer is closed.");
    if (this.layoutProblem || this.layout.needsRecovery) throw new Error(this.layoutProblem ?? "Layout recovery pending; consult status before spawning.");
    if ([...this.tasks.values()].filter(t => !finished(t)).length >= 6) throw new Error("Six active children already reserved; no queue.");
    const id = crypto.randomUUID();
    const task: Task = { taskId: id, task: taskText, instructions, state: "starting", created: new Date().toISOString(),
      agentName: "hs-" + id.replaceAll("-", "").slice(0, 24), sessionId: "hs-" + id, directory: join(this.root, id),
      model: options?.model ?? this.defaults.model, thinking: options?.thinking ?? this.defaults.thinking,
      tier: options?.tier, modelSource: options?.modelSource ?? "inherited",
      submitted: false, cancelRequested: false };
    this.tasks.set(id, task); // Synchronous reservation precedes the first await.
    try { await this.save(task); } catch (e) { this.tasks.delete(id); throw e; }
    this.launch(() => this.start(task));
    return structuredClone(task);
  }
  private async attention(task: Task) {
    if (!this.alive) return;
    if (!task.attentionSent) {
      await this.hooks.notify(structuredClone(task), true);
      task.attentionSent = true; await this.save(task);
    }
  }
  private async start(task: Task) {
    let prompting: Promise<{ error?: unknown }> | undefined;
    try {
      await this.layout.serial.run(async () => {
        if (!this.alive) return;
        if (task.cancelRequested) { task.state = "cancelled"; await this.save(task); return; }
        const marker = JSON.stringify({ taskId: task.taskId, directory: task.directory, sessionId: task.sessionId });
        await mkdir(join(task.directory, "sessions"), { recursive: true, mode: 0o700 });
        await this.layout.add(this.ownRefs(task), this.defaults.cwd, { PI_HERDR_SUBAGENT: marker }, async ref => {
          task.pane = ref; await this.save(task);
        });
        const args = ["agent", "start", task.agentName, "--kind", "pi", "--pane", task.pane!.paneId, "--timeout", "30000", "--",
          "--session-id", task.sessionId, "--session-dir", join(task.directory, "sessions"),
          "--provider", splitModelId(task.model ?? this.defaults.model).provider,
          "--model", task.model ?? this.defaults.model, "--thinking", task.thinking ?? this.defaults.thinking, "-e", this.defaults.packagePath];
        if (task.instructions) {
          const path = join(task.directory, "instructions.txt");
          const { writeFile } = await import("node:fs/promises");
          await writeFile(path, task.instructions, { mode: 0o600 });
          args.push("--append-system-prompt", path);
        }
        await this.layout.startAgent(task.pane!, args, async () => {
          task.launchAttempted = true; await this.save(task); // Intent after shell readiness, not proof of execution.
        });
        await this.bind(task, true);
        const a = await this.layout.validate(task.pane!);
        if (!["idle", "done"].includes(String(a.agent_status))) throw new Error("Child is not ready for its single task prompt.");
        if (task.cancelRequested) return;
        task.submitted = true; task.state = "working";
        await this.save(task); // Intent precedes the single remote submission.
        prompting = this.cli.json(["agent", "prompt", task.agentName, "[herdr-subagent:" + task.taskId + "]\n" + task.task, "--wait"], undefined, 0)
          .then(() => ({}), error => ({ error }));
        // Do not reorganize this new pane until its prompt has started activity (or settled).
        // A failed gate is diagnostic only: submission is never retried.
        try { await this.cli.json(["agent", "wait", task.agentName, "--until", "working", "--timeout", "5000"], undefined, 7000); }
        catch (e) { task.diagnostic = diagnostic(e); await this.save(task); }
      });
      if (!this.alive || finished(task)) return;
      if (task.cancelRequested) { await this.cancel(task.taskId); return; }
      if (!prompting) return;
      const observed = await prompting;
      if (!this.alive) return;
      await this.observe(task, observed.error);
    } catch (e) {
      if (!this.alive) return;
      task.diagnostic = diagnostic(e);
      if (e instanceof HerdrError && e.code === "pane_not_found") { delete task.pane; task.state = "failed"; }
      else if (task.pane) {
        try { await this.bind(task); const a = await this.layout.validate(task.pane);
          task.state = a.agent_status === "blocked" ? "blocked" : "collection_failed";
        } catch { task.state = "collection_failed"; }
      } else task.state = "failed";
      await this.save(task);
      await this.attention(task);
    }
  }
  private async resumeStartup(task: Task) {
    let prompting: Promise<{ error?: unknown }> | undefined;
    try {
      await this.layout.serial.run(async () => {
        if (!this.alive || task.submitted || task.outcome || task.cancelRequested || !task.pane) return;
        await this.bind(task, true);
        const a = await this.layout.validate(task.pane);
        if (!["idle", "done"].includes(String(a.agent_status))) return;
        task.submitted = true; task.state = "working"; await this.save(task);
        prompting = this.cli.json(["agent", "prompt", task.agentName, "[herdr-subagent:" + task.taskId + "]\n" + task.task, "--wait"], undefined, 0)
          .then(() => ({}), error => ({ error }));
        try { await this.cli.json(["agent", "wait", task.agentName, "--until", "working", "--timeout", "5000"], undefined, 7000); }
        catch (e) { task.diagnostic = diagnostic(e); await this.save(task); }
      });
      if (prompting && this.alive) { const observed = await prompting; if (this.alive) await this.observe(task, observed.error); }
    } catch (e) {
      if (!this.alive) return;
      task.state = "collection_failed"; task.diagnostic = diagnostic(e); await this.save(task); await this.attention(task);
    }
  }
  private async bind(task: Task, checkStartupModel = false) {
    if (!task.pane) throw new Error("No owned pane.");
    const ready = await readJson<Receipt>(join(task.directory, "ready.json"));
    if (ready.taskId !== task.taskId || ready.sessionId !== task.sessionId) throw new Error("Missing/mismatched child package handshake.");
    task.pane.agentName = task.agentName; task.pane.sessionId = task.sessionId; task.pane.sessionPath = ready.sessionPath;
    await this.save(task);
    // pi's CLI can fuzzy-match models. Check the actual selection before sending any work.
    // Legacy tasks have no modelSource and retain their original handshake contract.
    if (checkStartupModel && task.modelSource && ready.model !== task.model)
      throw new Error(`Child model mismatch: expected "${task.model}", received "${ready.model ?? "unknown"}". Task not submitted; no automatic model substitution. Pane retained for intervention.`);
  }
  private async receipt(task: Task) {
    try { return await readJson<Receipt>(join(task.directory, "settled.json")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  }
  private async observe(task: Task, error?: unknown) {
    if (!task.pane) return;
    const a = await this.layout.serial.run(() => this.layout.validate(task.pane!));
    const state = String(a.agent_status);
    if (state === "blocked") {
      task.state = "blocked"; task.diagnostic = "Child needs user intervention; no approvals are sent automatically.";
      await this.save(task); await this.attention(task);
    } else if (!["idle", "done", "working", "unknown"].includes(state)) throw new Error("Unrecognized child lifecycle state.");
    if (error) { task.diagnostic = diagnostic(error); await this.save(task); }
    // Filesystem events, not repeated polling. The child writes this only at agent_settled.
    await this.waitReceipt(task);
    if (!this.alive) return;
    const current = await this.layout.serial.run(() => this.layout.validate(task.pane!));
    if (!["idle", "done"].includes(String(current.agent_status))) {
      // The settlement file can precede the integration's idle report by a few ms.
      try {
        await this.cli.json(["agent", "wait", task.agentName, "--timeout", "3000"], undefined, 5000);
        const settled = await this.layout.validate(task.pane);
        if (["idle", "done"].includes(String(settled.agent_status))) { await this.finish(task); return; }
      } catch {}
      task.state = "collection_failed"; task.diagnostic = "Settlement receipt exists but agent is not quiescent; pane retained.";
      await this.save(task); await this.attention(task); return;
    }
    await this.finish(task);
  }
  private async waitReceipt(task: Task) {
    const signal = this.controller.signal;
    await new Promise<void>((resolve, reject) => {
      let closed = false, checking = false, dirty = false;
      const watcher = watch(task.directory, () => { void check(); });
      const close = (error?: unknown) => {
        if (closed) return; closed = true; watcher.close(); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => close(new Error("Observer stopped."));
      const check = async () => {
        if (checking) { dirty = true; return; }
        checking = true;
        try {
          do {
            dirty = false;
            if (await this.receipt(task)) { close(); break; }
            let block: { taskId: string; sessionId: string; sessionPath: string; active: boolean; title?: string } | undefined;
            try { block = await readJson(join(task.directory, "blocked.json")); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
            if (block && block.taskId === task.taskId && block.sessionId === task.sessionId && block.sessionPath === task.pane?.sessionPath) {
              if (block.active && task.state !== "blocked") {
                task.state = "blocked"; task.diagnostic = "Child UI needs intervention: " + (block.title ?? "approval/question");
                await this.save(task); await this.attention(task);
              } else if (!block.active && task.state === "blocked") { task.state = "working"; await this.save(task); }
            }
          } while (dirty && !closed);
        } catch (e) { close(e); }
        finally { checking = false; }
      };
      watcher.on("error", close);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      void check(); // Subscribe before reading to cover fast completion.
    });
  }
  private async finish(task: Task) {
    await this.layout.serial.run(async () => {
      if (!this.alive || !task.pane || task.outcome) return;
      task.state = "collecting"; await this.save(task);
      try {
        const receipt = await this.receipt(task);
        if (!receipt || receipt.sessionPath !== task.pane.sessionPath) throw new Error("Settlement/session identity mismatch.");
        const outcome = await collect(receipt, task.taskId, task.sessionId, task.cancelRequested);
        const resultPath = join(task.directory, "result.json");
        await atomicJson(resultPath, outcome); // Save complete result before any notification/closure.
        task.outcome = outcome; task.resultPath = resultPath;
        task.state = task.cancelRequested || outcome.stopReason === "aborted" ? "cancelled" : outcome.stopReason === "stop" ? "completed" : "failed";
        await this.save(task);
        if (!task.notified) { task.notified = (await this.hooks.notify(structuredClone(task), false)) !== false; await this.save(task); }
        await this.cleanup(task);
      } catch (e) {
        task.state = task.outcome ? "cleanup_pending" : "collection_failed";
        task.diagnostic = diagnostic(e);
        try { task.diagnostic += "\n" + (await this.cli.text(["agent", "read", task.agentName, "--source", "recent-unwrapped", "--lines", "80"])).slice(-4000); } catch {}
        await this.save(task); await this.attention(task);
      }
    });
  }
  private async cleanup(task: Task) {
    if (!task.pane || !task.outcome || !task.resultPath || !task.notified) return;
    if (this.layoutProblem) throw new Error(this.layoutProblem);
    await this.recoverLayout();
    const ref = task.pane;
    if (task.closeAttempted) throw new Error("Previous child close is uncertain; reconcile its absence with status before any resend.");
    if (!ref.agentName && task.cancelRequested && !task.submitted) await this.layout.awaitShell(ref);
    else {
      const a = await this.layout.validate(ref);
      if (!["idle", "done"].includes(String(a.agent_status))) throw new Error("Cannot close non-quiescent child.");
    }
    await this.layout.close(ref, this.ownRefs(task), async () => { delete task.pane; delete task.closeAttempted; task.state = "collecting"; await this.save(task); },
      async state => { task.closeFocus = state; await this.save(task); },
      async attempted => { task.closeAttempted = attempted || undefined; await this.save(task); });
    task.state = task.cancelRequested || task.outcome.stopReason === "aborted" ? "cancelled" : task.outcome.stopReason === "stop" ? "completed" : "failed";
    await this.save(task);
  }
  private async ownReservation(reserved: PaneRef) {
    const id = this.layout.reservedTaskId;
    if (!id) throw new Error("Missing active-branch task for the new layout slot.");
    const task = this.task(id);
    if (task.pane && !sameRef(task.pane, reserved)) throw new Error("Reserved child ownership changed; refusing journal adoption.");
    if (!task.pane) {
      await this.layout.awaitShell(reserved); task.pane = { ...reserved };
      task.state = "collection_failed"; task.diagnostic = "Recovered an unstarted reservation; cancel explicitly. No prompt was sent.";
      await this.save(task);
    }
  }
  private async recoverLayout(resetFocus = false) {
    await this.layout.recover(this.ownRefs(), resetFocus, ref => this.ownReservation(ref));
  }
  private async reconcileReservation(task: Task, includeStarting = false): Promise<boolean> {
    if (this.layout.pending || !task.pane || task.pane.agentName || task.submitted || task.outcome || (!includeStarting && task.state === "starting")) return false;
    const ref = task.pane;
    try {
      const current = paneRef((await this.cli.json(["pane", "get", ref.paneId])).pane);
      if (!sameRef(current, ref)) throw new Error("Reservation moved or replaced; refusing control: " + ref.paneId);
      return false;
    } catch (e) {
      if (!this.alive) return true;
      if (e instanceof HerdrError && e.code === "pane_not_found" && !e.uncertain) {
        delete task.pane; task.state = "failed";
        task.diagnostic = "Owned reservation disappeared; no replacement adopted. " + diagnostic(e);
      } else {
        task.state = "collection_failed";
        task.diagnostic = "Reservation identity unproven; pane retained, no input/closure attempted. " + diagnostic(e);
      }
      await this.save(task); return true;
    }
  }
  async restore(records: Task[], branchLayout?: LayoutState | null) {
    for (const record of records) {
      // Forked/copied history must not adopt another principal session\'s workers.
      if (typeof record.directory !== "string" || typeof record.taskId !== "string" ||
          dirname(record.directory) !== this.root || basename(record.directory) !== record.taskId) continue;
      let task = structuredClone(record);
      try { const disk = await readJson<Task>(join(task.directory, "task.json"));
        if (disk.taskId === task.taskId && disk.sessionId === task.sessionId && disk.directory === task.directory) task = { ...disk, notified: record.notified, attentionSent: record.attentionSent };
      } catch {}
      this.tasks.set(task.taskId, task);
    }
    let state = branchLayout ?? null;
    try {
      if (state?.record) {
        let disk: LayoutState | undefined;
        try { disk = await readJson<LayoutState>(join(this.root, "layout.json")); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        // Disk progress/tombstones are eligible only for the transaction named
        // by this branch, never for an unrelated abandoned branch.
        if (disk?.transactionId === state.transactionId) state = disk;
      }
      this.layout.load(state ?? null);
    } catch (e) { this.layoutProblem = diagnostic(e); return; }
    const reconciled = new Set<string>();
    try {
      await this.layout.serial.run(async () => {
        if (!this.layout.pending) for (const task of this.tasks.values())
          if (await this.reconcileReservation(task, true)) reconciled.add(task.taskId);
        await this.recoverLayout();
      });
    } catch (e) {
      for (const task of this.tasks.values()) if (task.pane) {
        task.state = task.outcome ? "cleanup_pending" : "collection_failed"; task.diagnostic = diagnostic(e); await this.save(task);
      }
      return;
    }
    for (const task of this.tasks.values()) if (!reconciled.has(task.taskId) && (!finished(task) || (task.outcome && !task.notified))) this.launch(async () => {
      try {
        if (task.outcome && !task.pane) {
          if (task.state === "cleanup_pending" || task.state === "collecting") await this.layout.serial.run(() => this.layout.compact(this.ownRefs(task)));
          if (!task.notified) task.notified = (await this.hooks.notify(task, false)) !== false;
          task.state = task.outcome.stopReason === "stop" ? "completed" : task.outcome.stopReason === "aborted" ? "cancelled" : "failed";
          await this.save(task); return;
        }
        if (!task.pane) { task.state = "failed"; task.diagnostic = "Startup interrupted before pane ownership was recorded; not relaunching."; await this.save(task); return; }
        if (!task.launchAttempted && !task.pane.agentName && !task.submitted) {
          await this.layout.awaitShell(task.pane); task.state = "collection_failed";
          task.diagnostic = "Unstarted reservation retained; cancel explicitly. Recovery never launches agents or prompts.";
          await this.save(task); await this.attention(task); return;
        }
        await this.bind(task);
        await this.layout.validate(task.pane);
        if (task.outcome) {
          await this.layout.serial.run(async () => {
            if (!task.notified) { task.notified = (await this.hooks.notify(task, false)) !== false; await this.save(task); }
            await this.cleanup(task);
          });
        } else if (task.submitted) {
          // Resume observation, never repeat agent start/prompt.
          this.launch(async () => {
            try { await this.cli.json(["agent", "wait", task.agentName], undefined, 0); await this.observe(task); }
            catch (e) { if (this.alive) { task.state = "collection_failed"; task.diagnostic = diagnostic(e); await this.save(task); await this.attention(task); } }
          });
        } else { task.state = "collection_failed"; task.diagnostic = "Startup interrupted; prompt was not sent. Pane retained for intervention."; await this.save(task); await this.attention(task); }
      } catch (e) {
        if (!this.alive) return;
        if (e instanceof HerdrError && e.code === "pane_not_found" && !task.outcome) { delete task.pane; task.state = "failed"; }
        else task.state = task.outcome ? "cleanup_pending" : "collection_failed";
        task.diagnostic = diagnostic(e); await this.save(task); await this.attention(task);
      }
    });
  }
  acknowledge(id: string) {
    const task = this.tasks.get(id);
    if (!task || !task.outcome || task.notified || !this.alive) return;
    this.launch(async () => {
      await this.layout.serial.run(async () => {
        if (!this.alive || task.notified) return;
        task.notified = true; await this.save(task);
        try { await this.cleanup(task); }
        catch (e) { task.state = "cleanup_pending"; task.diagnostic = diagnostic(e); await this.save(task); await this.attention(task); }
      });
    });
  }
  list() { return [...this.tasks.values()].map(view); }
  task(id: string) { const task = this.tasks.get(id); if (!task) throw new Error("Unknown taskId: " + id); return task; }
  async status(id: string) {
    const task = this.task(id);
    if (this.layoutProblem) return { ...view(task), diagnostic: this.layoutProblem };
    if (this.layout.pending) {
      try { await this.layout.serial.run(() => this.recoverLayout(true)); }
      catch (e) { task.diagnostic = diagnostic(e); await this.save(task); return view(task); }
    }
    if (task.state === "cleanup_pending" && task.outcome && task.notified) {
      try {
        await this.layout.serial.run(async () => {
          if (task.state !== "cleanup_pending") return;
          if (task.pane) {
            try { await this.layout.validate(task.pane); }
            catch (e) {
              if (e instanceof HerdrError && e.code === "pane_not_found" && !e.uncertain) {
                await this.layout.restoreClosedFocus(task.closeFocus, task.pane); delete task.closeFocus; delete task.closeAttempted; delete task.pane; await this.save(task);
              } else throw e;
            }
          }
          if (task.pane) await this.cleanup(task);
          else {
            await this.layout.compact(this.ownRefs(task));
            task.state = task.cancelRequested || task.outcome!.stopReason === "aborted" ? "cancelled" : task.outcome!.stopReason === "stop" ? "completed" : "failed";
            await this.save(task);
          }
        });
      } catch (e) { task.diagnostic = diagnostic(e); await this.save(task); }
    }
    if (await this.layout.serial.run(() => this.reconcileReservation(task))) return view(task);
    if (task.pane && !task.pane.agentName && !task.submitted && task.state !== "starting") {
      try { await this.bind(task); } catch { /* A startup dialog can precede the package handshake. No control is safe yet. */ }
    }
    if (task.pane?.agentName && !task.outcome) {
      try {
        const a = await this.layout.serial.run(() => this.layout.validate(task.pane!));
        if (a.agent_status === "blocked") {
          task.state = "blocked"; task.diagnostic = "Child needs user intervention.";
          await this.save(task); await this.attention(task);
        } else if (a.agent_status === "working") {
          task.state = "working"; await this.save(task);
        } else if (a.agent_status === "unknown") {
          task.diagnostic = "Herdr state unknown; not evidence of completion."; await this.save(task);
        }
        if (["idle", "done"].includes(String(a.agent_status))) {
          if (!task.submitted && !task.cancelRequested) this.launch(() => this.resumeStartup(task));
          else if (await this.receipt(task)) await this.finish(task);
        }
      } catch (e) {
        if (!this.alive) return view(task);
        if (e instanceof HerdrError && e.code === "pane_not_found") { delete task.pane; task.state = "failed"; }
        else task.state = "collection_failed";
        task.diagnostic = "Lost or changed child; no input/closure attempted. " + diagnostic(e);
        await this.save(task); await this.attention(task);
      }
    }
    return view(task);
  }
  async wait(id: string, timeoutMs = 120000, signal?: AbortSignal) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error("timeoutMs must be 1..3600000.");
    const task = this.task(id);
    if (task.outcome || finished(task) || ["blocked", "collection_failed", "cleanup_pending"].includes(task.state)) return { ...view(task), timedOut: false };
    const until = Date.now() + timeoutMs;
    // Observer polls only local task state; it neither sends Herdr controls nor resubmits.
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (task.outcome || finished(task) || ["blocked", "collection_failed", "cleanup_pending"].includes(task.state) || Date.now() >= until) { cleanup(); resolve(); }
      };
      const abort = () => { cleanup(); reject(new Error("Wait interrupted; child is still owned by the session.")); };
      const cleanup = () => { clearInterval(timer); signal?.removeEventListener("abort", abort); this.controller.signal.removeEventListener("abort", abort); };
      const timer = setInterval(tick, Math.min(50, timeoutMs));
      signal?.addEventListener("abort", abort, { once: true }); this.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || !this.alive) abort(); else tick();
    });
    return { ...view(task), timedOut: Date.now() >= until && !task.outcome && !finished(task) };
  }
  async cancel(id: string) {
    const task = this.task(id);
    if (finished(task)) return view(task);
    task.cancelRequested = true; await this.save(task);
    if (this.layoutProblem) throw new Error(this.layoutProblem);
    if (task.state === "starting" && !task.pane?.agentName) return view(task); // In-flight startup observes this flag before prompting.
    if (this.layout.pending) await this.layout.serial.run(() => this.recoverLayout(true));
    if (!task.pane) return view(task);
    if (!task.pane.agentName) {
      await this.layout.serial.run(async () => {
        await this.layout.checkTab(this.ownRefs()); await this.layout.awaitShell(task.pane!);
        task.outcome = { text: "Cancelled before prompt submission.", stopReason: "aborted", usage: zeroUsage(), modelUsage: [] };
        task.resultPath = join(task.directory, "result.json"); await atomicJson(task.resultPath, task.outcome);
        task.state = "cancelled"; await this.save(task);
        if (!task.notified) { task.notified = (await this.hooks.notify(task, false)) !== false; await this.save(task); }
        try { await this.cleanup(task); }
        catch (e) { task.state = "cleanup_pending"; task.diagnostic = diagnostic(e); await this.save(task); throw e; }
      });
      return view(task);
    }
    await this.layout.serial.run(async () => {
      const a = await this.layout.validate(task.pane!);
      if (["working", "blocked", "unknown"].includes(String(a.agent_status))) {
        await this.cli.text(["agent", "send-keys", task.agentName, "esc"]);
        try { await this.cli.json(["agent", "wait", task.agentName, "--timeout", "15000"], undefined, 20000); }
        catch (e) { task.diagnostic = "Cancellation not confirmed; pane retained. " + diagnostic(e); await this.save(task); }
      }
    });
    if (!task.submitted) {
      await this.layout.serial.run(async () => {
        const a = await this.layout.validate(task.pane!);
        if (!["idle", "done"].includes(String(a.agent_status))) return;
        task.outcome = { text: "Cancelled before prompt submission.", stopReason: "aborted", usage: zeroUsage(), modelUsage: [] };
        task.resultPath = join(task.directory, "result.json");
        await atomicJson(task.resultPath, task.outcome);
        task.state = "cancelled"; await this.save(task);
        if (!task.notified) { task.notified = (await this.hooks.notify(task, false)) !== false; await this.save(task); }
        try { await this.cleanup(task); }
        catch (e) { task.state = "cleanup_pending"; task.diagnostic = diagnostic(e); await this.save(task); throw e; }
      });
    } else if (await this.receipt(task)) await this.status(id);
    return view(task);
  }
}
function diagnostic(e: unknown) { return (e instanceof HerdrError ? e.code + ": " : "") + String(e instanceof Error ? e.message : e).slice(0, 8192); }
