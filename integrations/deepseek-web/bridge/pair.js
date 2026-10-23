"use strict";

// Run only in the user's own terminal: node pair.js "C:\\absolute\\workspace"
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateConfig } = require("./policy");

function main() {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: node pair.js <absolute-workspace-path>");
    process.exitCode = 2;
    return;
  }
  const file = path.join(__dirname, "config.local.json");
  if (fs.existsSync(file)) {
    console.error("Pairing already exists. No changes made to config.local.json.");
    process.exitCode = 2;
    return;
  }
  const config = {
    port: 18461,
    token: crypto.randomBytes(32).toString("hex"),
    allowedRoots: [path.resolve(root)],
    upstreamUrl: "http://127.0.0.1:8765/mcp",
    allowWrites: false,
    allowHandoff: false,
    backend: "acp",
    acpProfile: "codex"
  };
  validateConfig(config);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Paired locally. Config: " + file);
  console.log("Paste this token into the extension popup (never into DeepSeek chat):");
  console.log(config.token);
  console.log("Writes and multi-step handoff are DISABLED by default.");
}

if (require.main === module) main();
module.exports = { main };
