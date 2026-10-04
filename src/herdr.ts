import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export interface Execution { code: number; stdout: string; stderr: string }
export type Runner = (bin: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number) => Promise<Execution>;
export class HerdrError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  constructor(message: string, code: string, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; }
}
export const run: Runner = (bin, args, env, signal, timeoutMs = 45000) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", finished = false;
  const finish = (error?: Error, code = 0) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (error) { child.kill("SIGTERM"); reject(error); }
    else resolve({ code, stdout, stderr });
  };
  const abort = () => finish(new HerdrError("Local CLI observation interrupted; a remote mutation may already have happened.", "observer_aborted", true));
  const timer = timeoutMs > 0 ? setTimeout(() => finish(new HerdrError("Local CLI timeout; reconcile remote state before retrying.", "cli_timeout", true)), timeoutMs) : undefined;
  const append = (which: "stdout" | "stderr", chunk: Buffer) => {
    if (which === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > 1024 * 1024) finish(new HerdrError("CLI output exceeds 1 MiB; remote state is uncertain.", "output_limit", true));
  };
  child.stdout.on("data", b => append("stdout", b));
  child.stderr.on("data", b => append("stderr", b));
  child.on("error", e => finish(e));
  child.on("close", code => finish(undefined, code ?? 1));
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
});
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HerdrError("Invalid Herdr " + label, "invalid_response");
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new HerdrError("Missing Herdr " + label, "invalid_response");
  return value;
}
export interface Control {
  json(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>>;
  text(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<string>;
  setSplitRatio(tabId: string, path: boolean[], ratio: number, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>>;
}
export class Herdr implements Control {
  readonly env: NodeJS.ProcessEnv;
  readonly runner: Runner;
  readonly prefix: string[];
  readonly socketPath?: string;
  constructor(env: NodeJS.ProcessEnv = process.env, runner: Runner = run, prefix: string[] = [], socketPath?: string) { this.env = env; this.runner = runner; this.prefix = prefix; this.socketPath = socketPath; }
  private async execute(args: string[], signal?: AbortSignal, timeoutMs?: number) {
    if (this.env.HERDR_ENV !== "1") throw new HerdrError("Requires HERDR_ENV=1 inside a Herdr-managed pane.", "outside_herdr");
    const result = await this.runner(this.env.HERDR_BIN_PATH || "herdr", [...this.prefix, ...args], this.env, signal, timeoutMs);
    if (result.code !== 0) {
      let error: Record<string, unknown> = {};
      try { const parsed = object(JSON.parse(result.stderr), "error"); error = object(parsed.error ?? parsed, "error"); } catch { /* syntax/text error */ }
      throw new HerdrError(String(error.message ?? result.stderr ?? result.stdout).slice(0, 8192), String(error.code ?? (result.code === 2 ? "cli_syntax" : "cli_error")));
    }
    return result.stdout;
  }
  async json(args: string[], signal?: AbortSignal, timeoutMs?: number) {
    const raw = await this.execute(args, signal, timeoutMs);
    try {
      const response = object(JSON.parse(raw), "response");
      if (response.error) { const e = object(response.error, "error"); throw new HerdrError(String(e.message), String(e.code)); }
      return object(response.result, "result");
    } catch (e) { if (e instanceof HerdrError) throw e; throw new HerdrError("Malformed JSON from Herdr: " + raw.slice(0, 1024), "invalid_response"); }
  }
  text(args: string[], signal?: AbortSignal, timeoutMs?: number) { return this.execute(args, signal, timeoutMs); }
  async setSplitRatio(tabId: string, path: boolean[], ratio: number, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.env.HERDR_ENV !== "1") throw new HerdrError("Requires HERDR_ENV=1 inside a Herdr-managed pane.", "outside_herdr");
    if (this.prefix.length && !this.socketPath) throw new HerdrError("A prefixed Herdr instance requires an explicit socket endpoint.", "socket_required");
    const socketPath = this.socketPath ?? this.env.HERDR_SOCKET_PATH;
    if (!socketPath) throw new HerdrError("Missing Herdr socket endpoint.", "socket_required");
    string(tabId, "tab id");
    if (!Array.isArray(path) || path.some(part => typeof part !== "boolean")) throw new HerdrError("Invalid Herdr split path", "invalid_request");
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new HerdrError("Invalid Herdr split ratio", "invalid_request");

    const id = randomUUID();
    const request = JSON.stringify({ id, method: "layout.set_split_ratio", params: { tab_id: tabId, path, ratio } }) + "\n";
    let socket: ReturnType<typeof createConnection>;
    try { socket = createConnection(socketPath); }
    catch (error) { throw new HerdrError("Herdr socket connection failed: " + (error instanceof Error ? error.message : String(error)), "socket_error"); }
    return new Promise((resolve, reject) => {
      let settled = false, requestMayHaveBeenWritten = false, responseBytes = 0;
      let buffer = Buffer.alloc(0);
      const finish = (error?: HerdrError, result?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(new HerdrError("Socket request interrupted; remote state may have changed.", "observer_aborted", requestMayHaveBeenWritten));
      const timer = timeoutMs === undefined || timeoutMs > 0
        ? setTimeout(() => finish(new HerdrError("Herdr socket timeout; reconcile remote state before retrying.", "socket_timeout", requestMayHaveBeenWritten)), timeoutMs ?? 45000)
        : undefined;
      const malformed = (message: string) => finish(new HerdrError(message, "invalid_response", requestMayHaveBeenWritten));

      socket.on("connect", () => {
        requestMayHaveBeenWritten = true;
        socket.write(request, error => {
          if (error) finish(new HerdrError("Herdr socket write failed: " + error.message, "socket_error", true));
        });
      });
      socket.on("data", chunk => {
        responseBytes += chunk.length;
        if (responseBytes > 1024 * 1024) {
          finish(new HerdrError("Herdr socket output exceeds 1 MiB; remote state is uncertain.", "output_limit", requestMayHaveBeenWritten));
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        try {
          const response = object(JSON.parse(buffer.subarray(0, newline).toString("utf8")), "response");
          if (string(response.id, "response id") !== id) throw new HerdrError("Herdr socket response ID mismatch.", "invalid_response", true);
          const hasResult = Object.hasOwn(response, "result"), hasError = Object.hasOwn(response, "error");
          if (hasResult === hasError) throw new HerdrError("Invalid Herdr socket response envelope.", "invalid_response", true);
          if (hasError) {
            const error = object(response.error, "error");
            finish(new HerdrError(string(error.message, "error message"), string(error.code, "error code")));
            return;
          }
          finish(undefined, object(response.result, "result"));
        } catch (error) {
          const responseError = error instanceof HerdrError ? error : new HerdrError("Malformed JSON from Herdr socket.", "invalid_response");
          finish(new HerdrError(responseError.message, responseError.code, requestMayHaveBeenWritten));
        }
      });
      socket.on("end", () => malformed("Truncated Herdr socket response; remote state is uncertain."));
      socket.on("close", () => { if (!settled) malformed("Herdr socket closed without a complete response; remote state is uncertain."); });
      socket.on("error", error => finish(new HerdrError("Herdr socket connection failed: " + error.message, "socket_error", requestMayHaveBeenWritten)));
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
