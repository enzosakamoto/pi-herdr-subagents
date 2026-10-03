import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { parameters, outputSchema } from "../src/extension.ts";
import { loadConfig } from "../src/config.ts";

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
  const tool = tools[0].definition;
  for (const phrase of ["no explicit subagent request is needed", "low to run tests", "medium to map", "high for deep correctness review", "share filesystem/permissions", "follow-ups"])
    assert.ok(tool.description.includes(phrase), phrase);
  assert.ok(tool.promptGuidelines?.some(line => line.includes("Never automatically escalate")));
  for (const name of ["task", "instructions", "tier", "model", "taskId", "timeoutMs"]) {
    const objects = (parameters as unknown as { anyOf: { properties: Record<string, { description?: string }> }[] }).anyOf;
    assert.ok(objects.some(schema => schema.properties[name]?.description), `missing description: ${name}`);
  }
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
  for (const args of [{ action: "spawn", task: "inspect", instructions: "read only" },
    ...["low", "medium", "high"].map(tier => ({ action: "spawn", task: "inspect", tier })),
    { action: "spawn", task: "inspect", model: "router/vendor/model" },
    { action: "list" }, { action: "status", taskId: "id" }, { action: "wait", taskId: "id", timeoutMs: 1 }, { action: "cancel", taskId: "id" }])
    assert.equal(Value.Check(parameters, args), true);
  for (const args of [{ action: "spawn" }, { action: "spawn", task: "inspect", tier: "fast" },
    { action: "spawn", task: "inspect", tier: "low", model: "test/model" },
    ...["", "alias", "test/", "test/model\n", "test/model name"].map(model => ({ action: "spawn", task: "inspect", model })),
    { action: "list", taskId: "id" }, { action: "wait", taskId: "id", timeoutMs: 0 }, { action: "wait", taskId: "id", timeoutMs: 3600001 }, { action: "other" }])
    assert.equal(Value.Check(parameters, args), false);
  assert.equal(Value.Check(outputSchema, { tasks: [{ taskId: "id", state: "starting", agentName: "hs-test" }] }), true);
  assert.equal(Value.Check(outputSchema, { task: { taskId: "id", state: "unknown" } }), false);
  assert.equal(Value.Check(outputSchema, { task: { taskId: "id", state: "starting", agentName: "hs-test", model: "test/model", tier: "low", modelSource: "tier" } }), true);
  assert.equal(Value.Check(outputSchema, { task: { taskId: "id", state: "starting", agentName: "hs-test", tier: "fast" } }), false);
  assert.equal(Value.Check(outputSchema, { task: { taskId: "id", state: "starting", agentName: "hs-test", thinking: "off" } }), true);
  assert.equal(Value.Check(outputSchema, { task: { taskId: "id", state: "starting", agentName: "hs-test", thinking: null } }), false, "nullable configuration is resolved to a requested string");
  assert.equal(Value.Check(parameters, { action: "spawn", task: "inspect", thinking: "high" }), false, "thinking is config-only");
});
test("skill examples conform to the implemented schema and retain independent/dependency/blocked guidance", async () => {
  const source = await readFile("skills/pi-herdr-subagents/SKILL.md", "utf8");
  const examples = source.split("\n").filter(line => line.startsWith("{") && line.endsWith("}"));
  assert.equal(examples.length, 5);
  for (const example of examples) assert.equal(Value.Check(parameters, JSON.parse(example)), true);
  for (const phrase of ["Independent investigation", "Dependency", "Blocked child", "write ownership", "Do not answer approvals automatically", "resultPath", "hs-staging"]) assert.ok(source.includes(phrase), phrase);
  assert.ok(!source.includes("planned interface") && !source.includes("not implemented yet"));
  for (const phrase of ["no explicit subagent request", "Respect user restrictions", "Run tests and report results — low",
    "Understand a use-case flow — medium", "Review a newly implemented class — high", "Formatting/import review — low",
    "Never automatically escalate", "low alone does not make the child cheaper", "mutually exclusive", "modelSource"])
    assert.ok(source.includes(phrase), phrase);
  assert.ok(!source.includes("Delegate only after the user authorizes"));
  for (const phrase of ["thinking null means off", "Omitted thinking", "not proof of the effective level", "entire global entry"])
    assert.ok(source.includes(phrase), phrase);
});

test("documented profile configurations validate and retain nullable thinking", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hs-doc-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".pi"));
  for (const path of ["README.md", "README.pt-BR.md", "skills/pi-herdr-subagents/SKILL.md"]) {
    const source = await readFile(path, "utf8");
    const configs = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].filter(match => match[1].includes('"models"'));
    assert.ok(configs.length, `missing configuration example: ${path}`);
    for (const [, json] of configs) {
      await writeFile(join(dir, ".pi", "herdr-subagents.json"), json);
      const config = await loadConfig(dir, dir);
      assert.deepEqual(config, JSON.parse(json));
    }
  }
});
test("child marker never registers delegation, including through codemode", () => {
  const old = process.env.PI_HERDR_SUBAGENT;
  process.env.PI_HERDR_SUBAGENT = JSON.stringify({ taskId: "id", sessionId: "session", directory: "/tmp/test" });
  let tools = 0, hooks = 0;
  try { extension({ registerTool: () => { tools++; }, on: () => { hooks++; } } as unknown as ExtensionAPI); }
  finally { if (old === undefined) delete process.env.PI_HERDR_SUBAGENT; else process.env.PI_HERDR_SUBAGENT = old; }
  assert.equal(tools, 0); assert.equal(hooks, 4);
});
