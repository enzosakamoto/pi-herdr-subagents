import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { parameters, outputSchema } from "../src/extension.ts";

test("manifest discovery loads actual tool and skill with no diagnostics and no session side effects", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hs-loader-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: dir, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [process.cwd()] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tools = [...loaded.extensions[0].tools.values()];
  assert.equal(tools.length, 1); assert.equal(tools[0].definition.name, "herdr_subagent");
  const skills = loader.getSkills();
  assert.deepEqual(skills.diagnostics, []);
  assert.equal(skills.skills.length, 1); assert.equal(skills.skills[0].name, "pi-herdr-subagents");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.ok(manifest.pi.extensions.includes("./src/extension.ts"));
  assert.ok(manifest.pi.skills.includes("./skills/pi-herdr-subagents"));
  for (const pkg of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) assert.equal(manifest.peerDependencies[pkg], "*");
});
test("discriminated tool schemas validate all actions and reject malformed arguments", () => {
  for (const args of [{ action: "spawn", task: "inspect", instructions: "read only" }, { action: "list" }, { action: "status", taskId: "id" }, { action: "wait", taskId: "id", timeoutMs: 1 }, { action: "cancel", taskId: "id" }])
    assert.equal(Value.Check(parameters, args), true);
  for (const args of [{ action: "spawn" }, { action: "list", taskId: "id" }, { action: "wait", taskId: "id", timeoutMs: 0 }, { action: "wait", taskId: "id", timeoutMs: 3600001 }, { action: "other" }])
    assert.equal(Value.Check(parameters, args), false);
  assert.equal(Value.Check(outputSchema, { tasks: [{ taskId: "id", state: "starting", agentName: "hs-test" }] }), true);
  assert.equal(Value.Check(outputSchema, { task: { taskId: "id", state: "unknown" } }), false);
});
test("child marker never registers delegation, including through codemode", () => {
  const old = process.env.PI_HERDR_SUBAGENT;
  process.env.PI_HERDR_SUBAGENT = JSON.stringify({ taskId: "id", sessionId: "session", directory: "/tmp/test" });
  let tools = 0, hooks = 0;
  try { extension({ registerTool: () => { tools++; }, on: () => { hooks++; } } as unknown as ExtensionAPI); }
  finally { if (old === undefined) delete process.env.PI_HERDR_SUBAGENT; else process.env.PI_HERDR_SUBAGENT = old; }
  assert.equal(tools, 0); assert.equal(hooks, 2);
});
