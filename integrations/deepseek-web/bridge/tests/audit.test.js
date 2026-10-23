"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateConfig, safePath } = require("../policy");
const { searchCandidates } = require("../search-policy");
const { minimalEnvironment } = require("../stdio");
const { createBridge } = require("../server");
const { HandoffManager } = require("../handoff");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-web-audit-"));
  return { root, config: validateConfig({ token: "c".repeat(64), allowedRoots: [root] }) };
}

test("Windows normalization and reserved device paths are rejected on every platform", () => {
  const { root, config } = fixture();
  try {
    for (const name of [".git./config", "file. ", "AUX", "NUL.txt", "COM1.log", "config.local.json"]) assert.throws(() => safePath(config, "w0", name));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("direct access and recursive search reject hard links and secret filenames", () => {
  const { root, config } = fixture();
  try {
    fs.writeFileSync(path.join(root, "allowed.txt"), "public");
    fs.writeFileSync(path.join(root, "source.txt"), "private synthetic");
    fs.linkSync(path.join(root, "source.txt"), path.join(root, "alias.txt"));
    fs.writeFileSync(path.join(root, "my_password.md"), "private synthetic");
    assert.throws(() => safePath(config, "w0", "alias.txt"));
    const list = searchCandidates(config, "w0", ".").files;
    assert.deepEqual(list, ["allowed.txt"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("child environment does not inherit bridge, cloud or model credentials", () => {
  process.env.AD_WEB_SYNTHETIC_SECRET = "DO_NOT_INHERIT";
  try {
    const env = minimalEnvironment();
    assert.equal(env.AD_WEB_SYNTHETIC_SECRET, undefined);
    assert.equal(env.AGENTDOCK_WEB_UPSTREAM_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.AGENTDOCK_RUNTIME_ROOT, undefined);
  } finally { delete process.env.AD_WEB_SYNTHETIC_SECRET; }
});

async function withServer(config, dependencies, callback) {
  const server = createBridge(config, dependencies);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await callback("http://127.0.0.1:" + server.address().port); }
  finally { await server.cleanup(); await new Promise((r) => server.close(r)); }
}

test("health does not claim connected when real upstream initialization fails", async () => {
  const { root, config } = fixture();
  try {
    await withServer(config, { mcp: { initialize: async () => { throw new Error("offline"); } }, auditFile: null }, async (url) => {
      const r = await fetch(url + "/health", { headers: { Authorization: "Bearer " + config.token } });
      assert.equal(r.status, 502); assert.equal((await r.json()).ok, false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an audit write failure blocks side effects before the tool is called", async () => {
  const { root, config } = fixture(); let calls = 0;
  try {
    await withServer({ ...config, allowWrites: true }, { mcp: { call: async () => { calls++; return {}; } }, auditFile: root }, async (url) => {
      const r = await fetch(url + "/tool", { method: "POST", headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "ad_edit", args: { path: "test.txt", oldText: "a", newText: "b" } }) });
      assert.equal(r.status, 403); assert.equal(calls, 0);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed ACP cancellation does not falsely mark the task cancelled or allow a new run", async () => {
  const { root, config } = fixture();
  try {
    const manager = new HandoffManager({ ...config, allowHandoff: true }, { call: async () => { throw new Error("offline"); } });
    const run = { id: "run-test", backend: "acp", status: "running", output: "", remoteRunId: "remote", sessionId: "session" };
    manager.runs.set(run.id, run); manager.activeId = run.id;
    await assert.rejects(manager.cancel(run.id));
    assert.equal(run.status, "cancelling"); assert.equal(manager.activeId, run.id);
    assert.throws(() => manager.start("another task", "w0"), /already active/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH process-tree cancellation waits for actual child closure", async () => {
  const { root, config } = fixture();
  const script = path.join(root, "fake-dsh.js");
  fs.writeFileSync(script, "setInterval(()=>{},1000);\n");
  const manager = new HandoffManager({ ...config, allowHandoff: true, backend: "dsh", dshExecutable: process.execPath,
    dshScript: script, handoffTimeoutMs: 20000 }, {});
  try {
    const started = manager.start("synthetic task", "w0");
    await new Promise((r) => setTimeout(r, 150));
    const result = await manager.cancel(started.id);
    assert.equal(result.status, "cancelled"); assert.notEqual(result.finishedAt, null); assert.equal(manager.activeId, null);
  } finally { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH timeout stops a real synthetic child instead of only changing a status label", async () => {
  const { root, config } = fixture();
  const script = path.join(root, "fake-dsh.js"); fs.writeFileSync(script, "setInterval(()=>{},1000);\n");
  const manager = new HandoffManager({ ...config, allowHandoff: true, backend: "dsh", dshExecutable: process.execPath,
    dshScript: script, handoffTimeoutMs: 250 }, {});
  try {
    const start = manager.start("synthetic task", "w0"); let result;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); result = await manager.get(start.id); if (result.finishedAt) break; }
    assert.equal(result.status, "timed_out"); assert.notEqual(result.finishedAt, null); assert.equal(manager.activeId, null);
  } finally { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
