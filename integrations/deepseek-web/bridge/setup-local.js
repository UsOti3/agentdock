"use strict";
// Local setup only. Does not inspect existing credentials or change other applications.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { validateConfig } = require("./policy");
const { installedAgentDock } = require("./stdio");

function setup() {
  if (process.platform !== "win32") throw new Error("This setup helper currently supports Windows only");
  const configFile = path.join(__dirname, "config.local.json");
  if (fs.existsSync(configFile)) throw new Error("Local pairing already exists; existing settings were not changed");
  const data = path.join(process.env.LOCALAPPDATA, "AgentDockDeepSeekWeb");
  const workspace = path.join(data, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const demo = path.join(workspace, "demo.txt");
  if (!fs.existsSync(demo)) fs.writeFileSync(demo, "Synthetic test only.\n12 + 23 = 35\n", { flag: "wx" });
  const config = { port: 18461, token: crypto.randomBytes(32).toString("hex"),
    transport: "stdio", stateDir: path.join(data, "agentdock-state"), agentDockExecutable: installedAgentDock(),
    allowedRoots: [workspace], allowWrites: false, allowHandoff: false,
    backend: "dsh", handoffTimeoutMs: 300000,
  };
  const dsh = path.join(process.env.ProgramFiles || "C:\\Program Files", "DSH NEXT");
  const modules = path.join(dsh, "resources", "app.asar", "node_modules", "@deepseek-ai");
  const source = path.join(os.homedir(), ".dsh", "profiles", "desktop", "local-plugins", "dsh-vps-codex");
  let dshConfigured = false;
  if (fs.existsSync(path.join(dsh, "DSH NEXT.exe")) && fs.existsSync(path.join(source, "index.mjs"))) {
    let adapter = fs.readFileSync(path.join(source, "index.mjs"), "utf8");
    for (const name of ["dsh-llm", "dsh-attachment"]) {
      const old = "'@deepseek-ai/" + name + "'";
      if (!adapter.includes(old)) throw new Error("Installed VPS adapter format changed; review it before setup");
      adapter = adapter.replace(old, "'" + pathToFileURL(path.join(modules, name, "lib", "index.js")).href + "'");
    }
    if (!adapter.includes("'./core.mjs'")) throw new Error("Installed VPS transport format changed; review it before setup");
    adapter = adapter.replace("'./core.mjs'", "'" + pathToFileURL(path.join(source, "core.mjs")).href + "'");
    // Do not overwrite the existing desktop Bot's status file.
    adapter = adapter.replace("  status({phase:'loaded'});", "  process.stderr.write('[AgentDock Web] VPS adapter loaded\\n');");
    const localAdapter = path.join(data, "vps-headless-adapter.mjs");
    fs.writeFileSync(localAdapter, adapter, { mode: 0o600 });
    const patch = [
      { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: "openai-codex", model: "gpt-6.1-sol" } },
      { id: "llm-pi-ai", disabled: true },
      { insert: [{ id: "vps-codex", name: pathToFileURL(localAdapter).href }] },
      { id: "session-log-deepseek", config: { enabled: false } },
      { id: "session-telemetry-otel", disabled: true },
      { id: "session-title-llm", disabled: true },
    ];
    config.dshPatch = path.join(data, "headless-local.patch.yml");
    fs.writeFileSync(config.dshPatch, JSON.stringify(patch, null, 2) + "\n", { mode: 0o600 });
    config.dshExecutable = path.join(dsh, "DSH NEXT.exe");
    config.dshScript = path.join(modules, "dsh", "lib", "bin.js");
    config.dshElectron = true;
    dshConfigured = true;
  }
  validateConfig(config);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  // No token values leave this process. Pairing is copied locally by manage.js pair.
  console.log(JSON.stringify({ configured: true, workspace, transport: "stdio", dshConfigured,
    allowWrites: false, allowHandoff: false, credentialsInspected: false }));
}
if (require.main === module) { try { setup(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { setup };
