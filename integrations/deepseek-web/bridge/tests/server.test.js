"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBridge } = require("../server");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-web-server-"));
const token = "f".repeat(64);
const config = {
  token, allowedRoots: [root], port: 18461,
  upstreamUrl: "http://127.0.0.1:8765/mcp",
  allowWrites: false, allowHandoff: false
};
const calls = [];
const mcp = {
  async call(name, args) {
    calls.push({ name, args });
    if (name === "acp_session") return { session_id: "session-123" };
    if (name === "acp_prompt" && args.action === "start") return { run_id: "run-123" };
    if (name === "acp_prompt" && args.action === "events") {
      return { status: "completed", next_seq: 2,
        events: [{ seq: 1, type: "tool", message: "mock only" }] };
    }
    return { name, entries: [{ path: "ok.txt" }, { path: ".env" }] };
  }
};
let server;
let url;
async function req(pathname, { method = "GET", auth = token, origin, body } = {}) {
  const headers = {};
  if (auth) headers.Authorization = "Bearer " + auth;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(url + pathname, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
test.before(async () => {
  server = createBridge(config, { mcp, auditFile: path.join(root, "audit.jsonl") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test("auth, origin and HTTP route restrictions", async () => {
  assert.equal((await req("/health", { auth: "" })).status, 401);
  assert.equal((await req("/health", { auth: "a".repeat(64) })).status, 401);
  assert.equal((await req("/health", { origin: "https://chat.deepseek.com" })).status, 403);
  assert.equal((await req("/health")).data.ok, true);
  assert.equal((await req("/unknown")).status, 404);
});
test("read-only MCP adapter restricts paths and filters secrets", async () => {
  const tool = async (tool, args, workspace = "w0") => req("/tool",
    { method: "POST", body: { tool, args, workspace } });
  const good = await tool("ad_tree", { path: "." });
  assert.equal(good.status, 200);
  assert.equal(good.data.data.entries.length, 1);
  assert.equal(calls.at(-1).name, "list_dir");
  assert.equal(calls.at(-1).args.path, root);
  assert.equal((await tool("ad_read", { path: "../secrets" })).status, 403);
  assert.equal((await tool("ad_read", { path: ".env" })).status, 403);
  assert.equal((await tool("ad_read", { path: "C:\\Windows\\win.ini" })).status, 403);
  assert.equal((await tool("ad_read", { path: "ok.txt" }, "w1")).status, 403);
  assert.equal((await tool("ad_edit", { path: "ok.txt", oldText: "x", newText: "y" })).status, 403);
  assert.equal((await tool("ad_handoff", { plan: "test" })).status, 403);
  assert.equal((await tool("exec_command", {})).status, 403);
});
test("audit log has no model content or auth token", async () => {
  await req("/tool", { method: "POST", body: { tool: "ad_read", args: { path: "ok.txt" } } });
  const audit = fs.readFileSync(path.join(root, "audit.jsonl"), "utf8");
  assert.match(audit, /ad_read/);
  assert.doesNotMatch(audit, new RegExp(token));
  assert.doesNotMatch(audit, /ok\.txt/);
});
test("explicitly enabled ACP handoff uses authorized workspace", async () => {
  const enabled = createBridge({ ...config, allowHandoff: true }, { mcp, auditFile: null });
  await new Promise((resolve) => enabled.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + enabled.address().port;
  try {
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const start = await fetch(base + "/tool", { method: "POST", headers,
      body: JSON.stringify({ tool: "ad_handoff", args: { plan: "synthetic test only" } }) });
    const data = await start.json();
    assert.equal(start.status, 200);
    assert.match(data.data.id, /^[a-f0-9-]{36}$/);
    let poll;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 10));
      poll = await (await fetch(base + "/runs/" + data.data.id, { headers })).json();
      if (poll.run.status === "done") break;
    }
    assert.equal(poll.run.status, "done");
    assert.ok(calls.some((c) => c.name === "acp_session" && c.args.cwd === root));
    assert.ok(calls.some((c) => c.name === "acp_prompt" && c.args.action === "start"));
  } finally {
    await new Promise((resolve) => enabled.close(resolve));
  }
});
