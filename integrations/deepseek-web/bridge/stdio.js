"use strict";

// Documented MCP stdio transport: no HTTP listener and no service credential access.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { MCPClient } = require("./mcp");

function minimalEnvironment() {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function installedAgentDock() {
  if (process.platform !== "win32") return "agentdock";
  const root = path.join(process.env.LOCALAPPDATA || "", "AgentDock");
  // This file contains only the selected release version, not credentials.
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "active-version.json"), "utf8").replace(/^\uFEFF/, ""));
  if (!/^v[0-9][A-Za-z0-9._-]*$/.test(metadata.active_version || "")) throw new Error("Invalid installed AgentDock version");
  const exe = path.join(root, "versions", metadata.active_version, "agentdock-core.exe");
  if (!fs.statSync(exe).isFile()) throw new Error("Installed AgentDock executable not found");
  return exe;
}

class StdioMCPClient extends MCPClient {
  constructor(options) {
    super("");
    this.options = options;
    this.pending = new Map();
    this.buffer = "";
    this.child = null;
    this.initializing = null;
    this.closed = false;
  }

  start() {
    if (this.child) return;
    if (this.closed) throw new Error("MCP client is closed");
    const env = minimalEnvironment();
    env.AGENTDOCK_HOME = this.options.stateDir;
    env.AGENTDOCK_DEFAULT_DIR = this.options.workspace;
    env.AGENTDOCK_MCP_APPS_MODE = "off";
    // A separate state directory prevents Nexus registration, shared task state, or service repair.
    fs.mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    this.child = spawn(this.options.executable || installedAgentDock(), ["--stdio", "--log-level", "error"], {
      cwd: this.options.workspace, env, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 2 * 1024 * 1024) return this.fail(new Error("MCP response exceeded limit"));
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { this.fail(new Error("Invalid MCP stdio response")); return; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error("MCP request failed: " + String(message.error.code)));
        else if (!message.result) pending.reject(new Error("Missing MCP result"));
        else pending.resolve(message.result);
      }
    });
    // Drain stderr without returning local paths, logs or possible secrets to the browser.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail(new Error("MCP input closed")));
    this.child.on("error", () => this.fail(new Error("Could not start installed AgentDock")));
    this.child.on("close", () => this.fail(new Error("AgentDock process closed")));
  }

  fail(error) {
    this.closed = true; // Failed transports require an explicit bridge restart, never an ambiguous replay.
    this.initialized = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.buffer = "";
  }

  request(method, params, timeoutMs = 30000) {
    this.start();
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("MCP request timed out; no automatic retry")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (!error) return;
        const p = this.pending.get(id);
        if (p) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new Error("MCP request write failed")); }
      });
    });
  }

  async initialize() {
    if (this.initialized) return { connected: true, transport: "stdio" };
    if (!this.initializing) this.initializing = (async () => {
      const result = await super.initialize();
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return result;
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("MCP closed")); }
    this.pending.clear();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
    this.child = null;
  }
}

module.exports = { StdioMCPClient, installedAgentDock, minimalEnvironment };
