"use strict";
// Executes the real service-worker message handler in a VM with mock browser APIs.
// This is not a real Chrome/DeepSeek DOM end-to-end test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function worker() {
  const id = "a".repeat(32), values = { pairToken: "e".repeat(64) }, calls = [], scopes = [];
  let handler;
  const chrome = { runtime: { id, getURL: (file) => "chrome-extension://" + id + "/" + file,
    onMessage: { addListener: (h) => { handler = h; } } }, storage: { local: {
      setAccessLevel: async (options) => { scopes.push(options.accessLevel); },
      get: async () => ({ ...values }), set: async (input) => Object.assign(values, input),
    } } };
  const sandbox = { chrome, AbortSignal, URL, fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, upstreamConnected: true }) };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../extension/background.js"), "utf8"), sandbox);
  const send = (message, sender) => new Promise((resolve) => handler(message, sender, resolve));
  return { id, values, calls, scopes, send };
}

test("extension rejects foreign senders and untrusted web origins", async () => {
  const w = worker();
  for (const sender of [{ id: "bad", url: "https://chat.deepseek.com/" }, { id: w.id, url: "https://evil.invalid/" }]) {
    const result = await w.send({ type: "bridge", method: "GET", path: "/health" }, sender);
    assert.equal(result.ok, false);
  }
  assert.equal(w.calls.length, 0);
});

test("extension pairing is limited to its popup and token storage excludes content scripts", async () => {
  const w = worker();
  const denied = await w.send({ type: "savePair", token: "b".repeat(64) }, { id: w.id, url: "https://chat.deepseek.com/" });
  assert.equal(denied.ok, false); assert.equal(w.values.pairToken, "e".repeat(64));
  const saved = await w.send({ type: "savePair", token: "b".repeat(64) }, { id: w.id, url: "chrome-extension://" + w.id + "/popup.html" });
  assert.equal(saved.ok, true); assert.equal(w.values.pairToken, "b".repeat(64));
  assert.deepEqual(w.scopes, ["TRUSTED_CONTEXTS"]);
});

test("extension sends authenticated requests only to its fixed loopback endpoint", async () => {
  const w = worker(), sender = { id: w.id, url: "https://chat.deepseek.com/a/chat" };
  const ok = await w.send({ type: "bridge", method: "GET", path: "/health" }, sender);
  assert.equal(ok.ok, true); assert.equal(w.calls[0].url, "http://127.0.0.1:18461/health");
  assert.equal(w.calls[0].options.redirect, "error"); assert.equal(w.calls[0].options.credentials, "omit");
  assert.equal(w.calls[0].options.headers.Authorization, "Bearer " + w.values.pairToken);
  assert.equal(JSON.stringify(ok).includes(w.values.pairToken), false);
  for (const route of ["/shutdown", "//evil.invalid/", "/tool?url=https://evil.invalid", "/../mcp"]) {
    const result = await w.send({ type: "bridge", method: "POST", path: route }, sender);
    assert.equal(result.ok, false);
  }
  assert.equal(w.calls.length, 1);
});
