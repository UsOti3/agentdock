"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MCPClient } = require("../mcp");

test("MCP requests use explicit methods and return structured tool data", async () => {
  const calls = [];
  const fake = async (_url, init) => {
    calls.push(init);
    const rpc = JSON.parse(init.body);
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ jsonrpc: "2.0", id: rpc.id,
        result: rpc.method === "initialize" ?
          { protocolVersion: "2025-11-25" } :
          { structuredContent: { entries: [{ path: "a.txt" }] } } }),
    };
  };
  const mcp = new MCPClient("http://127.0.0.1:8765/mcp", "local-secret", fake);
  assert.equal((await mcp.initialize()).protocolVersion, "2025-11-25");
  assert.deepEqual(await mcp.call("list_dir", { path: "." }), { entries: [{ path: "a.txt" }] });
  assert.equal(calls[1].headers.Authorization, "Bearer local-secret");
  assert.equal(JSON.parse(calls[1].body).params.name, "list_dir");
});
test("upstream HTTP and MCP errors fail closed", async () => {
  const failure = new MCPClient("http://127.0.0.1/mcp", "", async () => ({ ok: false, status: 401 }));
  await assert.rejects(failure.call("read_file", {}), /401/);
  const mcpError = new MCPClient("http://127.0.0.1/mcp", "", async () => ({
    ok: true, headers: { get: () => "application/json" },
    json: async () => ({ error: { code: -32000, message: "access denied" } }),
  }));
  await assert.rejects(mcpError.call("read_file", {}), /access denied/);
});
