"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { safePath, resolveWorkspace } = require("./policy");

// Build an exact allowlist BEFORE AgentDock reads file contents. This also
// prevents recursive search from reaching hard links or sensitive basenames.
function searchCandidates(config, workspace, relative) {
  const root = resolveWorkspace(config, workspace);
  const base = safePath(config, workspace, relative || ".", true);
  const files = []; let visited = 0; let truncated = false;
  function inspect(abs, depth) {
    if (++visited > 600 || files.length >= 200 || depth > 4) { truncated = true; return; }
    const rel = path.relative(root, abs).split(path.sep).join("/") || ".";
    let vetted;
    try { vetted = safePath(config, workspace, rel, true); } catch { return; }
    const stat = fs.lstatSync(vetted);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(vetted, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        inspect(path.join(vetted, entry.name), depth + 1);
        if (visited > 600 || files.length >= 200) break;
      }
    } else if (stat.isFile() && stat.size <= 1024 * 1024) {
      const glob = path.relative(base, vetted).split(path.sep).join("/") || path.basename(vetted);
      // Exact include_globs only: do not let a filename become a wildcard.
      if (!/[?*\[\]{}]/.test(glob)) files.push(glob);
    }
  }
  inspect(base, 0);
  return { base, files, truncated };
}
module.exports = { searchCandidates };
