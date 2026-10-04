import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr, object } from "../src/herdr.ts";
import { Layout, paneRef } from "../src/layout.ts";
import { readJson } from "../src/results.ts";
if (process.env.HERDR_LIVE_TEST !== "1") throw new Error("Opt-in only; real principal and two children make model calls.");
const session = process.env.HERDR_TEST_SESSION ?? "pi-herdr-subagents-test-20261003", socket = process.env.HERDR_TEST_SOCKET;
if (session === "default" || !socket || socket === process.env.HERDR_SOCKET_PATH) throw new Error("Require an explicit isolated HERDR_TEST_SOCKET matching HERDR_TEST_SESSION.");
const root = await mkdtemp(join(tmpdir(), "hs-live-extension-"));
const cli = new Herdr(process.env, undefined, ["--session", session], socket);
const created = await cli.json(["workspace", "create", "--label", "hs-extension-verification", "--cwd", process.cwd(), "--no-focus", "--env", "HERDR_TEST_EVIDENCE=" + root]);
const principal = paneRef(created.root_pane);
const name = "hs-main-" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
let success = false;
try {
  await new Layout(cli, principal, async () => {}).startAgent(principal, ["agent", "start", name, "--kind", "pi", "--pane", principal.paneId, "--timeout", "30000", "--",
    "--session-id", name, "--session-dir", join(root, "sessions"), "--model", (process.env.PI_PROVIDER ?? "openai-codex") + "/" + (process.env.PI_MODEL ?? "gpt-6.1-sol"),
    "--thinking", process.env.PI_REASONING_LEVEL ?? "high", "--no-skills", "--no-context-files", "-e", join(process.cwd(), "tests/fixtures/live-driver.ts")]);
  try { await cli.json(["agent", "prompt", name, "/hs-live-verify", "--wait", "--timeout", "180000"], undefined, 185000); }
  catch (e) { console.log("CLI lifecycle observation:", String(e)); } // No resubmission.
  let evidence: Record<string, any> | undefined;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const candidate = await readJson<Record<string, any>>(join(root, "principal.json"));
      if (candidate.tasks.length === 2 && candidate.notices.length === 2 && candidate.accounted.length === 2 &&
          candidate.assistants.some((text: string) => text.includes("HS-MAIN-COMPLETE"))) { evidence = candidate; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(evidence, "principal settlement evidence missing");
  assert.ok(evidence.mainWork, "principal performed its own work while delegation was active");
  assert.equal(new Set(evidence.notices).size, 2); assert.equal(new Set(evidence.accounted).size, 2);
  assert.ok(evidence.tasks.every((task: Record<string, unknown>) => task.state === "completed" && !task.paneId && task.resultPath));
  assert.deepEqual(evidence.tasks.map((task: Record<string, unknown>) => String(task.text).trim()).sort(), ["HS-CHILD-A", "HS-CHILD-B"]);
  const layout = object((await cli.json(["pane", "layout", "--pane", principal.paneId])).layout, "layout");
  assert.equal((layout.panes as unknown[]).length, 1);
  success = true;
  console.log("Live extension PASS: principal work, two task-tagged follow-ups, one-time accounting, durable results before matching child pane closure.");
} finally {
  if (success) await cli.json(["workspace", "close", principal.workspaceId]);
  else console.log("Preserved test principal/children for diagnosis:", principal.workspaceId);
  console.log("Evidence directory:", root);
}
