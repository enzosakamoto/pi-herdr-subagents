import test from "node:test";
import assert from "node:assert/strict";
import { Herdr, HerdrError, run, type Runner } from "../src/herdr.ts";
test("transport passes argument arrays without shell interpolation, binary override and parses JSON/text", async () => {
  const seen: string[][] = [];
  const runner: Runner = async (bin, args) => { assert.equal(bin, "/test/herdr"); seen.push(args); return { code: 0, stdout: args[1] === "read" ? "raw text\n" : '{"result":{"ok":true}}', stderr: "" }; };
  const cli = new Herdr({ HERDR_ENV: "1", HERDR_BIN_PATH: "/test/herdr" }, runner);
  assert.deepEqual(await cli.json(["agent", "prompt", "name", 'task $(touch x); "quotes"']), { ok: true });
  assert.equal(seen[0][3], 'task $(touch x); "quotes"');
  assert.equal(await cli.text(["agent", "read", "name"]), "raw text\n");
});
test("reject outside Herdr on every entry point", async () => {
  let calls = 0;
  const cli = new Herdr({}, async () => { calls++; return { code: 0, stdout: "", stderr: "" }; });
  await assert.rejects(cli.json(["pane", "list"]), /HERDR_ENV/);
  await assert.rejects(cli.text(["agent", "read", "x"]), /HERDR_ENV/); assert.equal(calls, 0);
});
test("JSON server errors, syntax errors and malformed success", async () => {
  for (const [code, stderr, expected] of [[1, '{"error":{"code":"agent_prompt_stalled","message":"stalled"}}', "agent_prompt_stalled"], [2, "bad syntax", "cli_syntax"], [0, "", "invalid_response"]] as const) {
    const cli = new Herdr({ HERDR_ENV: "1" }, async () => ({ code, stderr, stdout: "not json" }));
    await assert.rejects(cli.json(["agent", "prompt", "x", "task"]), e => e instanceof HerdrError && e.code === expected);
  }
});
test("CLI observer timeout after accepted work is explicitly uncertain, not remote cancellation", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.stdout.write('accepted'); setTimeout(()=>{},10000)"], process.env, undefined, 50),
    e => e instanceof HerdrError && e.uncertain && e.code === "cli_timeout");
});
