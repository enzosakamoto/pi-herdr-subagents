import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, zeroUsage } from "../src/results.ts";

const taskId = "test-task", sessionId = "test-session";
const entry = (id: string, parentId: string | null, message: unknown) => ({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "test", stopReason, usage: { ...zeroUsage(), output: 7, totalTokens: 7 }, timestamp: Date.now() });
async function fixture(t: test.TestContext, entries: unknown[], leafId = "a", trailing = "") {
  const dir = await mkdtemp(join(tmpdir(), "hs-result-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionPath = join(dir, "session.jsonl");
  await writeFile(sessionPath, [{ type: "session", version: 3, id: sessionId, cwd: "/", timestamp: new Date().toISOString() }, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n" + trailing);
  return { taskId, sessionId, sessionPath, leafId };
}
const user = entry("u", null, { role: "user", content: "[herdr-subagent:test-task]\ntask", timestamp: Date.now() });
test("active branch, long final response, all text blocks, nested tool usage, partial last line", async t => {
  const a = assistant("long ".repeat(20000)); a.content.push({ type: "text", text: "second block" });
  const receipt = await fixture(t, [user, entry("tool", "u", assistant("working", "toolUse")),
    entry("r", "tool", { role: "toolResult", toolName: "nested", toolCallId: "call", content: [], usage: { ...zeroUsage(), input: 3, totalTokens: 3 }, timestamp: Date.now(), isError: false }),
    entry("a", "r", a), entry("abandoned", "u", assistant("WRONG BRANCH"))], "a", '{"type":"message"');
  const result = await collect(receipt, taskId, sessionId);
  assert.ok(result.text.length > 100000); assert.ok(result.text.endsWith("second block"));
  assert.equal(result.usage.output, 14); assert.equal(result.usage.input, 3); assert.equal(result.usage.totalTokens, 17);
  assert.equal(result.modelUsage.length, 1);
});
test("error, aborted and length preserve diagnostics instead of becoming success", async t => {
  for (const reason of ["error", "aborted", "length"]) {
    const a = { ...assistant("partial", reason), errorMessage: "model diagnostic" };
    const receipt = await fixture(t, [user, entry("a", "u", a)]);
    const result = await collect(receipt, taskId, sessionId);
    assert.equal(result.stopReason, reason); assert.equal(result.error, "model diagnostic");
  }
});
test("missing correlation, missing final, tool-only and additional user turn refuse collection", async t => {
  for (const entries of [
    [entry("a", null, assistant("old response"))],
    [user, entry("a", "u", assistant("tool result", "toolUse"))],
    [user, entry("other", "u", { role: "user", content: "unrelated turn", timestamp: Date.now() }), entry("a", "other", assistant("another task"))]
  ]) await assert.rejects(collect(await fixture(t, entries), taskId, sessionId));
});
test("receipt and session mismatches are rejected", async t => {
  const receipt = await fixture(t, [user, entry("a", "u", assistant("result"))]);
  await assert.rejects(collect({ ...receipt, taskId: "other" }, taskId, sessionId), /Mismatched/);
  await assert.rejects(collect({ ...receipt, leafId: "not-persisted" }, taskId, sessionId), /persisted/);
});
