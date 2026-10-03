import { spawn } from "node:child_process";

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
}
export class Herdr implements Control {
  readonly env: NodeJS.ProcessEnv;
  readonly runner: Runner;
  readonly prefix: string[];
  constructor(env: NodeJS.ProcessEnv = process.env, runner: Runner = run, prefix: string[] = []) { this.env = env; this.runner = runner; this.prefix = prefix; }
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
}
