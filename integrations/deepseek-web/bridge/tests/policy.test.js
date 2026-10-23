"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PolicyError, validateConfig, resolveWorkspace, safePath, textForBrowser } = require("../policy");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-web-policy-"));
const config = validateConfig({
  token: "a".repeat(64), port: 18461, allowedRoots: [root],
  upstreamUrl: "http://127.0.0.1:8765/mcp",
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("valid roots and workspaces are explicit", () => {
  assert.equal(resolveWorkspace(config, "w0"), fs.realpathSync(root));
  assert.equal(safePath(config, "w0", "sample.txt"), path.join(root, "sample.txt"));
  assert.throws(() => resolveWorkspace(config, "w1"), PolicyError);
  assert.throws(() => resolveWorkspace(config, "C:\\Windows"), PolicyError);
});
test("rejects traversal, absolute and sensitive paths", () => {
  for (const p of ["../secrets", "folder/../sample.txt", "C:\\Windows\\win.ini",
    "/etc/passwd", "\\\\server\\share\\file", ".env", "child/.ssh/id_rsa",
    "child/node_modules/index.js", "child/.agentdock/config.yaml", "token.txt"]) {
    assert.throws(() => safePath(config, "w0", p), PolicyError, p);
  }
  assert.throws(() => safePath(config, "w0", "."), PolicyError);
  assert.equal(safePath(config, "w0", ".", true), root);
});
test("rejects symlinks in any existing path component", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ad-web-outside-"));
  const link = path.join(root, "link");
  try { fs.symlinkSync(outside, link, "junction"); }
  catch (e) { fs.rmSync(outside, { recursive: true, force: true }); t.skip("OS cannot create test symlink: " + e.code); return; }
  assert.throws(() => safePath(config, "w0", "link/info.txt"), PolicyError);
  fs.rmSync(link, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
test("rejects non-local MCP upstream and weak token", () => {
  const base = { token: "a".repeat(64), allowedRoots: [root] };
  assert.throws(() => validateConfig({ ...base, upstreamUrl: "https://example.com/mcp" }), PolicyError);
  assert.throws(() => validateConfig({ ...base, upstreamUrl: "http://127.0.0.1:8765/other" }), PolicyError);
  assert.throws(() => validateConfig({ ...base, token: "short" }), PolicyError);
});
test("scrubs common token strings in tool output", () => {
  const value = textForBrowser({ note: "Bearer " + "b".repeat(64), value: "sk-" + "X".repeat(32) }, config);
  assert.match(JSON.stringify(value), /redacted/);
  assert.doesNotMatch(JSON.stringify(value), new RegExp("b{64}"));
});
