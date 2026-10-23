"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BLOCKED_PARTS = new Set([
  "config.local.json", ".git", ".ssh", ".aws", ".azure", ".gnupg", ".agentdock", ".codex",
  "node_modules", ".npm", ".config", ".dsh", ".dsh-pro", ".venv",
]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519|ecdsa)|.*(?:credential|secret|token|password|private.?key).*|.*\.(?:pem|p12|pfx|key|kdbx))$/i;
class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

function validateConfig(input) {
  if (!input || typeof input !== "object") throw new PolicyError("CONFIG", "Configuration is required");
  if (!/^[a-f0-9]{64}$/i.test(input.token || "")) throw new PolicyError("CONFIG", "A random 32-byte pairing token is required");
  const port = input.port === undefined ? 18461 : input.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new PolicyError("CONFIG", "Invalid bridge port");
  if (!Array.isArray(input.allowedRoots) || !input.allowedRoots.length) throw new PolicyError("CONFIG", "allowedRoots must contain an explicit workspace");
  const roots = input.allowedRoots.map((root) => {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new PolicyError("CONFIG", "Workspace must be an absolute path");
    const real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) throw new PolicyError("CONFIG", "Workspace is not a directory");
    return real;
  });
  const upstream = new URL(input.upstreamUrl || "http://127.0.0.1:8765/mcp");
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" ||
      upstream.pathname !== "/mcp" || upstream.username || upstream.password ||
      upstream.search || upstream.hash) {
    throw new PolicyError("CONFIG", "Upstream must be a local AgentDock /mcp endpoint");
  }
  const backend = input.backend || "acp";
  if (backend !== "acp" && backend !== "dsh") throw new PolicyError("CONFIG", "Unknown handoff backend");
  const transport = input.transport || "http";
  if (!["http", "stdio"].includes(transport)) throw new PolicyError("CONFIG", "Invalid transport");
  const stateDir = input.stateDir || path.join(require("node:os").homedir(), ".agentdock-deepseek-web", "runtime");
  if (!path.isAbsolute(stateDir)) throw new PolicyError("CONFIG", "stateDir must be absolute");
  const timeout = input.handoffTimeoutMs || 180000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 900000) throw new PolicyError("CONFIG", "Invalid handoff timeout");
  return {
    transport, stateDir, agentDockExecutable: input.agentDockExecutable || "",
    dshScript: input.dshScript || "", dshElectron: input.dshElectron === true,
    dshPatch: input.dshPatch || "", handoffTimeoutMs: timeout,
    port, token: input.token, allowedRoots: roots, upstreamUrl: upstream.href,
    allowWrites: input.allowWrites === true,
    allowHandoff: input.allowHandoff === true,
    backend, acpProfile: input.acpProfile || "codex",
    dshExecutable: input.dshExecutable || "dsh",
  };
}

function resolveWorkspace(config, alias) {
  const key = alias === undefined || alias === null || alias === "" ? "w0" : alias;
  if (typeof key !== "string" || !/^w(?:0|[1-9][0-9]*)$/.test(key)) throw new PolicyError("WORKSPACE", "Invalid workspace identifier");
  const n = Number(key.slice(1));
  if (!Number.isSafeInteger(n) || !config.allowedRoots[n]) throw new PolicyError("WORKSPACE", "Workspace not authorized");
  return config.allowedRoots[n];
}

function isBlockedRelative(rel) {
  return rel.split(/[\\/]+/).some((component) =>
    BLOCKED_PARTS.has(component.toLowerCase()) || SECRET_NAME.test(component));
}

function safePath(config, workspace, relative, allowRoot = false) {
  const base = resolveWorkspace(config, workspace);
  if (typeof relative !== "string" || !relative || relative.length > 700 || relative.includes("\0")) {
    throw new PolicyError("PATH", "Invalid relative path");
  }
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.startsWith("//") ||
      relative.startsWith("\\\\") || relative.includes(":")) {
    throw new PolicyError("PATH", "Absolute paths and drive paths are forbidden");
  }
  const parts = relative.replace(/\\/g, "/").split("/");
  if (parts.some((s) => s === ".." || s === "")) throw new PolicyError("PATH", "Path traversal is forbidden");
  const cleanParts = parts.filter((s) => s !== ".");
  if (cleanParts.some((s) => /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) {
    throw new PolicyError("PATH", "Reserved or ambiguous path component");
  }
  if (fs.lstatSync(base).isSymbolicLink() || fs.realpathSync(base) !== base) {
    throw new PolicyError("PATH", "Workspace root changed");
  }
  if (!allowRoot && !cleanParts.length) throw new PolicyError("PATH", "File path required");
  if (isBlockedRelative(cleanParts.join("/"))) throw new PolicyError("PATH", "Sensitive path is blocked");
  const target = path.resolve(base, ...cleanParts);
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new PolicyError("PATH", "Path outside allowed workspace");
  }
  let cursor = base;
  for (const component of cleanParts) {
    cursor = path.join(cursor, component);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new PolicyError("PATH", "Symlinks and junctions are blocked");
      if (stat.isFile() && stat.nlink > 1) throw new PolicyError("PATH", "Hard-linked files are blocked");
    } catch (err) {
      if (err instanceof PolicyError) throw err;
      if (err.code === "ENOENT") break;
      throw err;
    }
  }
  return target;
}

function textForBrowser(value, config) {
  let text = JSON.stringify(value);
  for (const root of config.allowedRoots) {
    text = text.split(root).join("<workspace>");
    // JSON-escaped Windows paths contain doubled backslashes.
    text = text.split(JSON.stringify(root).slice(1, -1)).join("<workspace>");
  }
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "<redacted>");
  if (text.length > 16000) return { truncated: true, preview: text.slice(0, 16000) };
  try { return JSON.parse(text); } catch { return { preview: text }; }
}

module.exports = { PolicyError, validateConfig, resolveWorkspace, safePath, isBlockedRelative, textForBrowser };
