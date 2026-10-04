import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type Request = Record<string, unknown> & { id: string };
async function unixServer(handle: (socket: Socket, request: Request) => void) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-socket-test-"));
  const socketPath = join(dir, "control.sock");
  const server = createServer(socket => {
    let input = "", handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      handle(socket, JSON.parse(input.slice(0, newline)) as Request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const socketHerdr = (socketPath: string, env: NodeJS.ProcessEnv = { HERDR_ENV: "1" }) => new Herdr(env, undefined, [], socketPath);
const responseLine = (request: Request, result: unknown) => JSON.stringify({ id: request.id, result }) + "\n";

test("native ratio transport sends a framed request and parses a fragmented response", async () => {
  let request: Request | undefined;
  const server = await unixServer((socket, received) => {
    request = received;
    const line = responseLine(received, { changed: true });
    socket.write(line.slice(0, 7));
    setTimeout(() => socket.write(line.slice(7)), 5);
  });
  try {
    const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath };
    const result = await new Herdr(env).setSplitRatio("tab-1", [true, false], 0.75);
    assert.deepEqual(result, { changed: true });
    assert.equal(typeof request?.id, "string");
    assert.equal(request?.method, "layout.set_split_ratio");
    assert.deepEqual(request?.params, { tab_id: "tab-1", path: [true, false], ratio: 0.75 });
  } finally { await server.close(); }
});

test("native ratio transport preserves explicit server rejection", async () => {
  const server = await unixServer((socket, request) => socket.end(JSON.stringify({ id: request.id, error: { code: "layout_error", message: "ratio rejected" } }) + "\n"));
  try {
    await assert.rejects(socketHerdr(server.socketPath).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.code === "layout_error" && !e.uncertain && e.message === "ratio rejected");
  } finally { await server.close(); }
});

test("native ratio transport rejects malformed and truncated frames as uncertain", async () => {
  for (const [payload, end] of [["not json\n", false], ['{"id":"unfinished"}', true]] as const) {
    const server = await unixServer(socket => { socket.write(payload); if (end) socket.end(); });
    try {
      await assert.rejects(socketHerdr(server.socketPath).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.code === "invalid_response" && e.uncertain);
    } finally { await server.close(); }
  }
});

test("native ratio transport rejects mismatched response IDs as uncertain", async () => {
  const server = await unixServer(socket => socket.end(JSON.stringify({ id: "not-the-request", result: {} }) + "\n"));
  try {
    await assert.rejects(socketHerdr(server.socketPath).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.code === "invalid_response" && e.uncertain);
  } finally { await server.close(); }
});

test("native ratio transport marks lost replies and oversized frames uncertain", async () => {
  const lost = await unixServer(socket => socket.destroy());
  try {
    await assert.rejects(socketHerdr(lost.socketPath).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.uncertain && e.code === "invalid_response");
  } finally { await lost.close(); }

  const large = await unixServer(socket => socket.write(Buffer.alloc(1024 * 1024 + 1, 120)));
  try {
    await assert.rejects(socketHerdr(large.socketPath).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.uncertain && e.code === "output_limit");
  } finally { await large.close(); }
});

test("native ratio transport marks post-write aborts and timeouts uncertain", async () => {
  let received!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const stalled = await unixServer(() => received());
  try {
    const controller = new AbortController();
    const pending = socketHerdr(stalled.socketPath).setSplitRatio("tab", [], 0.5, controller.signal);
    await requestReceived;
    controller.abort();
    await assert.rejects(pending, e => e instanceof HerdrError && e.code === "observer_aborted" && e.uncertain);
  } finally { await stalled.close(); }

  const noReply = await unixServer(() => {});
  try {
    await assert.rejects(socketHerdr(noReply.socketPath).setSplitRatio("tab", [], 0.5, undefined, 30), e => e instanceof HerdrError && e.code === "socket_timeout" && e.uncertain);
  } finally { await noReply.close(); }
});

test("native ratio transport requires Herdr context and reports pre-write connection errors as certain", async () => {
  await assert.rejects(new Herdr({}, undefined, [], "/unused").setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.code === "outside_herdr" && !e.uncertain);
  const dir = await mkdtemp(join(tmpdir(), "herdr-socket-missing-"));
  try {
    await assert.rejects(socketHerdr(join(dir, "missing.sock")).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.code === "socket_error" && !e.uncertain);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prefixed instances require and use only their explicit socket endpoint", async () => {
  let inheritedRequests = 0, explicitRequests = 0;
  const inherited = await unixServer(() => { inheritedRequests++; });
  const explicit = await unixServer((socket, request) => { explicitRequests++; socket.end(responseLine(request, { selected: "named" })); });
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: inherited.socketPath };
  try {
    await assert.rejects(new Herdr(env, undefined, ["--session", "named"]).setSplitRatio("tab", [], 0.5), e => e instanceof HerdrError && e.code === "socket_required");
    const result = await new Herdr(env, undefined, ["--session", "named"], explicit.socketPath).setSplitRatio("tab", [], 0.5);
    assert.deepEqual(result, { selected: "named" });
    assert.equal(explicitRequests, 1);
    assert.equal(inheritedRequests, 0);
  } finally { await inherited.close(); await explicit.close(); }
});
