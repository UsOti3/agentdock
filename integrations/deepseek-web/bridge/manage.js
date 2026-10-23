"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { validateConfig } = require("./policy");
const { minimalEnvironment } = require("./stdio");

async function main() {
  const action = process.argv[2];
  if (!["start", "stop", "status", "pair"].includes(action)) throw new Error("Usage: node manage.js start|stop|status|pair");
  const config = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, "config.local.json"), "utf8")));
  const base = "http://127.0.0.1:" + config.port;
  const headers = { Authorization: "Bearer " + config.token };
  const request = async (route, method = "GET") => {
    const response = await fetch(base + route, { method, headers, signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!response.ok) { const error = new Error("Local bridge returned HTTP " + response.status); error.http = response.status; throw error; }
    return response.json();
  };
  if (action === "pair") {
    if (process.platform !== "win32") throw new Error("Clipboard helper supports Windows only");
    const result = spawnSync("clip.exe", [], { input: config.token, encoding: "utf8", windowsHide: true, shell: false });
    if (result.status !== 0) throw new Error("Clipboard copy failed");
    console.log("Pairing copied to your local clipboard. Paste ONLY into the extension popup, never into chat.");
    return;
  }
  if (action === "stop") {
    await request("/shutdown", "POST");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { await request("/health"); }
      catch (e) { if (!e.http) { console.log("Local bridge stopped."); return; } }
    }
    throw new Error("Stop requested but closure is not confirmed; do not assume tasks have stopped");
  }
  try {
    const health = await request("/health");
    if (health.service !== "agentdock-deepseek-web" || !health.upstreamConnected) throw new Error("Unexpected local service identity");
    console.log(JSON.stringify({ running: true, upstreamConnected: true, transport: health.transport,
      workspaces: health.workspaces, allowWrites: health.allowWrites, allowHandoff: health.allowHandoff }));
    return;
  } catch (e) {
    if (action === "status" || e.http) throw e;
  }
  const folder = path.dirname(config.stateDir);
  fs.mkdirSync(folder, { recursive: true });
  const log = fs.openSync(path.join(folder, "bridge.log"), "a");
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname, env: minimalEnvironment(), detached: true, windowsHide: true, shell: false, stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  let error;
  child.once("error", (e) => { error = e; });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (error) throw new Error("Bridge could not start");
    await new Promise((r) => setTimeout(r, 200));
    try {
      const health = await request("/health");
      if (health.service === "agentdock-deepseek-web" && health.upstreamConnected) {
        fs.writeFileSync(path.join(folder, "bridge.pid"), String(child.pid));
        console.log(JSON.stringify({ started: true, upstreamConnected: true, port: config.port, transport: health.transport }));
        return;
      }
    } catch (e) { if (e.http === 401 || e.http === 403) break; }
  }
  child.kill(); // Only this just-created child, never the user's existing AgentDock or DSH Bot.
  throw new Error("Bridge startup did not pass the real AgentDock health check; inspect its local log");
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
