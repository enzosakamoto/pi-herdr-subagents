import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, selectModel, selectThinking, splitModelId, tiers, thinkingLevels } from "../src/config.ts";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hs-config-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true }); await mkdir(agentDir);
  const globalPath = join(agentDir, "herdr-subagents.json"), projectPath = join(cwd, ".pi", "herdr-subagents.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd, agentDir, globalPath, projectPath, load: () => loadConfig(cwd, agentDir) };
}

test("missing/empty mappings inherit the principal even when a tier is requested", async t => {
  const { load, projectPath } = await setup(t);
  for (const content of [undefined, {}, { models: {} }, { defaultTier: "high" }]) {
    if (content !== undefined) await writeFile(projectPath, JSON.stringify(content));
    const config = await load();
    for (const tier of tiers) assert.deepEqual(selectModel(config, { tier }, "test/principal"), {
      model: "test/principal", tier, modelSource: "inherited"
    });
    assert.equal(selectModel(config, {}, "test/principal").tier, content && "defaultTier" in content ? "high" : "medium");
  }
  assert.throws(() => selectModel({}, {}), /Select a principal model/);
});

test("project merges individual tiers over global and overrides defaultTier; reads are fresh", async t => {
  const { load, globalPath, projectPath } = await setup(t);
  await writeFile(globalPath, JSON.stringify({ defaultTier: "high", models: { low: "p/cheap", medium: "p/general", high: "p/deep" } }));
  await writeFile(projectPath, JSON.stringify({ models: { medium: "p/project" } }));
  const first = await load();
  assert.deepEqual(first, { defaultTier: "high", models: { low: "p/cheap", medium: "p/project", high: "p/deep" } });
  assert.equal(selectModel(first, {}).model, "p/deep");
  await writeFile(projectPath, JSON.stringify({ defaultTier: "low", models: { low: "p/new" } }));
  assert.deepEqual(selectModel(await load(), {}), { tier: "low", model: "p/new", modelSource: "tier" });
  assert.equal(selectModel(first, { tier: "low" }).model, "p/cheap", "earlier snapshots are unaffected");
});

test("each configured tier resolves exactly; explicit model overrides without a principal", () => {
  const config = { models: { low: "p/cheap", medium: "p/general", high: "p/deep" } };
  for (const tier of tiers) assert.deepEqual(selectModel(config, { tier }, "p/main"), {
    tier, model: config.models[tier], modelSource: "tier"
  });
  assert.equal(selectModel(config, {}).model, "p/general");
  assert.deepEqual(selectModel(config, { model: "router/vendor/model:version" }), {
    model: "router/vendor/model:version", modelSource: "explicit"
  });
  assert.deepEqual(splitModelId("router/vendor/model:version"), { provider: "router", id: "vendor/model:version" });
  assert.throws(() => selectModel(config, { tier: "low", model: "p/override" }), /mutually exclusive/);
});

test("partial mappings never silently fallback to the principal or another tier", () => {
  const config = { models: { low: "p/cheap" } };
  assert.throws(() => selectModel(config, {}, "p/main"), /No model configured for tier "medium"/);
  assert.throws(() => selectModel(config, { tier: "high" }, "p/main"), /No model configured for tier "high"/);
  assert.equal(selectModel(config, { tier: "low" }).model, "p/cheap");
  assert.equal(selectModel(config, { model: "p/explicit" }).model, "p/explicit");
});

test("strict configuration errors identify the file, including malformed IDs and unknown fields", async t => {
  const { load, globalPath, projectPath } = await setup(t);
  const invalid = ["{", "null", "[]", "true", '{"extra":1}', '{"defaultTier":"fast"}', '{"defaultTier":null}',
    '{"models":null}', '{"models":[]}', '{"models":{"other":"p/m"}}', '{"models":{"low":null}}',
    '{"models":{"low":1}}', '{"models":{"low":""}}', '{"models":{"low":"alias"}}',
    '{"models":{"low":" p/m"}}', '{"models":{"low":"p/m "}}', '{"models":{"low":"p/"}}',
    '{"models":{"__proto__":"p/m"}}'];
  for (const path of [globalPath, projectPath]) {
    for (const source of invalid) {
      await writeFile(path, source);
      await assert.rejects(load(), error => error instanceof Error && error.message.includes(path) && error.message.includes("Invalid subagent configuration"));
    }
    await rm(path);
  }
});

test("unreadable config is an error rather than absence", async t => {
  const { load, globalPath } = await setup(t);
  await mkdir(globalPath);
  await assert.rejects(load(), error => error instanceof Error && error.message.includes(globalPath) && error.message.includes("Cannot read"));
});

test("object profiles accept every thinking level; null means off, omission/strings inherit", async t => {
  const { load, projectPath } = await setup(t);
  for (const thinking of [...thinkingLevels, null, undefined]) {
    await writeFile(projectPath, JSON.stringify({ models: { medium: { model: "p/general", thinking } } }));
    const config = await load(), selection = selectModel(config, {});
    assert.deepEqual(selection, { model: "p/general", tier: "medium", modelSource: "tier" });
    assert.equal(selectThinking(config, selection, "high"), thinking === undefined ? "high" : thinking === null ? "off" : thinking);
    assert.equal(selectThinking(config, selection), thinking ?? "off");
  }
  await writeFile(projectPath, JSON.stringify({ models: { medium: "p/general" } }));
  const config = await load();
  assert.equal(selectThinking(config, selectModel(config, {}), "max"), "max");
});

test("project replaces complete profiles: null disables, omitted thinking does not inherit global", async t => {
  const { load, globalPath, projectPath } = await setup(t);
  await writeFile(globalPath, JSON.stringify({ models: {
    low: { model: "p/fast", thinking: "high" },
    medium: { model: "p/general", thinking: "low" },
    high: { model: "p/deep", thinking: "max" }
  } }));
  await writeFile(projectPath, JSON.stringify({ models: {
    low: { model: "p/local-fast", thinking: null },
    medium: { model: "p/local-general" }
  } }));
  const first = await load();
  assert.deepEqual(first.models?.medium, { model: "p/local-general" });
  assert.equal(selectThinking(first, selectModel(first, { tier: "low" }), "high"), "off");
  assert.equal(selectThinking(first, selectModel(first, { tier: "medium" }), "high"), "high");
  assert.equal(selectThinking(first, selectModel(first, { tier: "high" }), "high"), "max");
  await writeFile(projectPath, JSON.stringify({ models: { low: "p/string" } }));
  const next = await load();
  assert.equal(selectThinking(next, selectModel(next, { tier: "low" }), "minimal"), "minimal");
  assert.equal(selectThinking(next, selectModel(next, { tier: "medium" }), "high"), "low");
  assert.equal(selectThinking(first, selectModel(first, { tier: "low" }), "high"), "off", "old snapshot unchanged");
});

test("explicit model and absent mappings never take thinking from defaultTier", () => {
  const config = { models: { medium: { model: "p/general", thinking: null } } };
  const explicit = selectModel(config, { model: "p/general" });
  assert.equal(selectThinking(config, explicit, "high"), "high", "even an identical model does not adopt the profile");
  assert.equal(selectThinking(config, explicit), "off");
  const inherited = selectModel({}, { tier: "low" }, "p/main");
  assert.equal(selectThinking({}, inherited, "medium"), "medium");
});

test("invalid object profiles and thinking values fail with file and tier diagnostics", async t => {
  const { load, globalPath, projectPath } = await setup(t);
  const invalid: unknown[] = [{}, { thinking: null }, { model: null }, { model: 1 }, { model: "alias" },
    { model: "p/m", extra: true }, { model: "p/m", thinking: "HIGH" }, { model: "p/m", thinking: "" },
    { model: "p/m", thinking: "auto" }, { model: "p/m", thinking: false }, { model: "p/m", thinking: 0 },
    { model: "p/m", thinking: {} }, { model: "p/m", thinking: [] }, []];
  for (const path of [globalPath, projectPath]) {
    for (const entry of invalid) {
      await writeFile(path, JSON.stringify({ models: { medium: entry } }));
      await assert.rejects(load(), error => error instanceof Error && error.message.includes(path) && error.message.includes("models.medium"));
    }
    await rm(path);
  }
});

test("model IDs require an exact provider and nonempty whitespace-free ID", () => {
  for (const model of ["", "model", "/model", "p/", "p/model name", "p/model\n", " p/model"])
    assert.throws(() => selectModel({}, { model }), /exact provider\/model-id/);
});
