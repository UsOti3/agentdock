"use strict";
// Explicit, opt-in local integration checks. Uses synthetic files only; no service credentials.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createBridge } = require("../server");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-web-live-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-web-state-"));
  const token = crypto.randomBytes(32).toString("hex");
  const dsh = process.argv.includes("--dsh");
  const config = { token, port: 18461, transport: "stdio", stateDir, allowedRoots: [root],
    allowWrites: true, allowHandoff: dsh, backend: "dsh", handoffTimeoutMs: 150000,
    dshExecutable: path.join(process.env.ProgramFiles || "C:\\Program Files", "DSH NEXT", "DSH NEXT.exe"),
    dshScript: path.join(process.env.ProgramFiles || "C:\\Program Files", "DSH NEXT", "resources", "app.asar", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    dshElectron: true,
    dshPatch: path.join(process.env.LOCALAPPDATA, "AgentDockDeepSeekWeb", "headless-local.patch.yml"),
  };
  fs.writeFileSync(path.join(root, "sample.txt"), "SYNTHETIC_INITIAL\n", "utf8");
  fs.writeFileSync(path.join(root, "numbers.txt"), "12\n23\n", "utf8");
  const server = createBridge(config, { auditFile: path.join(stateDir, "audit.jsonl") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const evidence = { at: new Date().toISOString(), syntheticOnly: true, transport: "stdio", checks: [] };
  async function request(route, body) {
    const response = await fetch(url + route, { method: body ? "POST" : "GET", headers,
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  async function tool(name, args) { return request("/tool", { tool: name, args, workspace: "w0" }); }
  try {
    const health = await request("/health");
    assert.equal(health.body.upstreamConnected, true); evidence.checks.push("real AgentDock initialization");
    assert.equal((await fetch(url + "/health")).status, 401); evidence.checks.push("unauthorized request blocked");
    assert.equal((await tool("ad_tree", { path: "." })).status, 200); evidence.checks.push("real directory listing");
    const read = await tool("ad_read", { path: "sample.txt" });
    assert.equal(read.status, 200); assert.match(JSON.stringify(read.body.data), /SYNTHETIC_INITIAL/); evidence.checks.push("real file read");
    const search = await tool("ad_search", { query: "SYNTHETIC", path: "." });
    assert.equal(search.status, 200); assert.match(JSON.stringify(search.body.data), /SYNTHETIC/); evidence.checks.push("real text search");
    const edit = await tool("ad_edit", { path: "sample.txt", oldText: "SYNTHETIC_INITIAL", newText: "SYNTHETIC_VERIFIED" });
    assert.equal(edit.status, 200); assert.equal(fs.readFileSync(path.join(root, "sample.txt"), "utf8"), "SYNTHETIC_VERIFIED\n"); evidence.checks.push("real edit verified on disk");
    assert.equal((await tool("ad_read", { path: "../other.txt" })).status, 403);
    assert.equal((await tool("ad_read", { path: ".env" })).status, 403); evidence.checks.push("traversal and secret path blocked");
    if (dsh) {
      const started = await tool("ad_handoff", { plan: "Synthetic test. Read numbers.txt from the current directory, add its two numbers, write result.txt containing exactly the sum and a newline, then read result.txt to verify it. Do not use any file outside this directory or change any other file. Report the final sum." });
      assert.equal(started.status, 200);
      const id = started.body.data.id;
      let run;
      const deadline = Date.now() + 160000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        run = (await request("/runs/" + id)).body.run;
        if (!["starting", "running", "cancelling"].includes(run.status)) break;
      }
      evidence.dsh = { status: run.status, exitCode: run.exitCode, output: run.output };
      if (run.status !== "done") throw new Error("DSH did not complete: " + run.status);
      assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8").trim(), "35");
      evidence.checks.push("real DSH read-compute-write-read verified on disk");
    }
    evidence.pass = true;
  } catch (error) {
    evidence.pass = false; evidence.error = error.message;
    process.exitCode = 1;
  } finally {
    await server.cleanup();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    console.log(JSON.stringify(evidence, null, 2));
  }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
