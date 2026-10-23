"use strict";

// Opt-in local bridge between a Chrome extension and an EXISTING AgentDock MCP server.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MCPClient } = require("./mcp");
const { StdioMCPClient } = require("./stdio");
const { searchCandidates } = require("./search-policy");
const { HandoffManager } = require("./handoff");
const { PolicyError, validateConfig, safePath, resolveWorkspace, isBlockedRelative, textForBrowser } = require("./policy");

const TOOL_NAMES = ["ad_tree", "ad_read", "ad_search", "ad_edit", "ad_handoff"];
const MAX_BODY = 48 * 1024;

function authenticated(header, token) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(String(header || ""));
  if (!match) return false;
  return crypto.timingSafeEqual(Buffer.from(match[1].toLowerCase()), Buffer.from(token.toLowerCase()));
}
function numberIn(value, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PolicyError("ARGS", "Numeric argument outside permitted range");
  }
  return value;
}
function stringArg(value, max, label) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new PolicyError("ARGS", "Invalid " + label);
  }
  return value;
}
function scrubNativeResult(value) {
  if (Array.isArray(value)) return value.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const p = entry.path || entry.file || entry.filename;
    return typeof p !== "string" || !isBlockedRelative(p);
  }).map(scrubNativeResult);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubNativeResult(v)]));
  }
  return value;
}

function createBridge(rawConfig, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const mcp = dependencies.mcp || (config.transport === "stdio" ? new StdioMCPClient({
    executable: config.agentDockExecutable, stateDir: config.stateDir, workspace: config.allowedRoots[0],
  }) : new MCPClient(config.upstreamUrl, process.env.AGENTDOCK_WEB_UPSTREAM_TOKEN || ""));
  const handoff = new HandoffManager(config, mcp);
  const auditFile = dependencies.auditFile === undefined ? path.join(__dirname, "audit.jsonl") : dependencies.auditFile;
  let auditFailureReported = false;
  const requests = [];

  function audit(type, data) {
    if (!auditFile) return;
    try {
      // No token, plan, file body, tool result or raw model text in audit logs.
      fs.appendFileSync(auditFile, JSON.stringify({
        time: new Date().toISOString(), type,
        tool: TOOL_NAMES.includes(data.tool) ? data.tool : null,
        workspace: /^w[0-9]+$/.test(data.workspace || "") ? data.workspace : "w0",
        ok: Boolean(data.ok), code: data.code || null,
      }) + "\n");
    } catch {
      if (!auditFailureReported) {
        auditFailureReported = true;
        console.error("AgentDock Web: audit unavailable; operations will fail closed");
      }
      throw new PolicyError("AUDIT", "Audit cannot be written");
    }
  }

  async function toolCall(tool, args = {}, workspace) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new PolicyError("ARGS", "args must be an object");
    if (!TOOL_NAMES.includes(tool)) throw new PolicyError("TOOL", "Tool not allowlisted");
    let result;
    if (tool === "ad_tree") {
      const p = safePath(config, workspace, args.path || ".", true);
      result = await mcp.call("list_dir", {
        path: p, max_depth: numberIn(args.depth, 2, 1, 3), max_entries: 60,
        include_hidden: false, include_ignored: false,
        exclude_patterns: [".git/**", "**/.git/**", "node_modules/**", "**/node_modules/**",
          ".env*", "**/.env*", ".agentdock/**", "**/.agentdock/**"],
      });
    } else if (tool === "ad_read") {
      const p = safePath(config, workspace, stringArg(args.path, 700, "path"));
      const start = numberIn(args.start, 1, 1, 100000);
      const lines = numberIn(args.lines, 80, 1, 120);
      result = await mcp.call("read_file", {
        path: p, start_line: start, end_line: start + lines - 1, max_bytes: 12000,
      });
    } else if (tool === "ad_search") {
      const query = stringArg(args.query, 120, "query");
      const approved = searchCandidates(config, workspace, args.path || ".");
      result = approved.files.length ? await mcp.call("search_text", {
        path: approved.base, query, regex: false, max_results: 20,
        include_hidden: false, include_ignored: false, include_globs: approved.files,
      }) : { matches: [], count: 0 };
      result.policyTruncated = approved.truncated;
    } else if (tool === "ad_edit") {
      if (!config.allowWrites) throw new PolicyError("DISABLED", "Writes are disabled by local config");
      const p = safePath(config, workspace, stringArg(args.path, 700, "path"));
      const old = stringArg(args.oldText, 16000, "oldText");
      const replacement = typeof args.newText === "string" ? args.newText : null;
      if (replacement === null || replacement.length > 16000) throw new PolicyError("ARGS", "Invalid newText");
      result = await mcp.call("file_edit", {
        action: "replace", path: p, old, new: replacement, expected_matches: 1,
      });
    } else if (tool === "ad_handoff") {
      return handoff.start(stringArg(args.plan, 12000, "plan"), workspace);
    }
    return textForBrowser(scrubNativeResult(result), config);
  }

  function send(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    const actualPort = server.address().port;
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== "127.0.0.1:" + actualPort) return send(res, 403, { ok: false, error: "Invalid Host header" });
    const origin = String(req.headers.origin || "");
    if (origin && !/^chrome-extension:\/\/[a-z]{32}$/.test(origin)) {
      return send(res, 403, { ok: false, error: "Untrusted request origin" });
    }
    if (!authenticated(req.headers.authorization, config.token)) {
      return send(res, 401, { ok: false, error: "Not paired" });
    }
    const now = Date.now();
    while (requests.length && requests[0] < now - 60000) requests.shift();
    if (requests.length >= 90) return send(res, 429, { ok: false, error: "Rate limited" });
    requests.push(now);

    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && pathname === "/health") {
        if (typeof mcp.initialize === "function") await mcp.initialize();
        return send(res, 200, {
          ok: true, service: "agentdock-deepseek-web", version: "0.2.0",
          upstreamConnected: true, transport: config.transport,
          workspaces: config.allowedRoots.map((_, i) => "w" + i),
          allowWrites: config.allowWrites, allowHandoff: config.allowHandoff,
          backend: config.backend,
        });
      }
      if (req.method === "POST" && pathname === "/shutdown") {
        await server.cleanup();
        send(res, 200, { ok: true, stopping: true });
        setImmediate(() => server.close());
        return;
      }
      if (req.method === "GET" && pathname === "/tools") {
        return send(res, 200, { ok: true, tools: [
          { name: "ad_tree", args: "{path?:relative,depth?:1..3}" },
          { name: "ad_read", args: "{path:relative,start?:1,lines?:80}" },
          { name: "ad_search", args: "{query:text,path?:relative}" },
          ...(config.allowWrites ? [{ name: "ad_edit", args: "{path,oldText,newText}" }] : []),
          ...(config.allowHandoff ? [{ name: "ad_handoff", args: "{plan:text}" }] : []),
        ] });
      }
      const runMatch = /^\/runs\/([a-f0-9-]{36})(\/cancel)?$/.exec(pathname);
      if (runMatch && req.method === "GET" && !runMatch[2]) {
        return send(res, 200, { ok: true, run: textForBrowser(await handoff.get(runMatch[1]), config) });
      }
      if (runMatch && req.method === "POST" && runMatch[2]) {
        return send(res, 200, { ok: true, run: textForBrowser(await handoff.cancel(runMatch[1]), config) });
      }
      if (req.method !== "POST" || pathname !== "/tool") {
        return send(res, 404, { ok: false, error: "Unknown endpoint" });
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new PolicyError("ARGS", "Request too large");
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new PolicyError("ARGS", "Invalid JSON"); }
      if (!body || typeof body !== "object" || typeof body.tool !== "string") {
        throw new PolicyError("ARGS", "Tool name is required");
      }
      const tool = body.tool;
      const workspace = body.workspace || "w0";
      try {
        // Record an attempt BEFORE any write/handoff side effect. Audit failure blocks execution.
        audit("start", { tool, workspace, ok: false });
        const data = await toolCall(tool, body.args || {}, workspace);
        audit("tool", { tool, workspace, ok: true });
        return send(res, 200, { ok: true, tool, data });
      } catch (err) {
        audit("tool", { tool, workspace, ok: false, code: err.code || "UPSTREAM" });
        throw err;
      }
    } catch (err) {
      const code = err instanceof PolicyError ? err.code : "UPSTREAM";
      const message = err instanceof PolicyError ? err.message : "AgentDock operation failed (see local console)";
      const status = code === "UPSTREAM" ? 502 : code === "BUSY" ? 409 : code === "NOT_FOUND" ? 404 : 403;
      return send(res, status, { ok: false, error: { code, message } });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 8000;
  let cleanup;
  server.cleanup = () => {
    if (!cleanup) cleanup = (async () => {
      await handoff.shutdown();
      if (typeof mcp.close === "function") await mcp.close();
    })().catch((error) => { cleanup = null; throw error; });
    return cleanup;
  };
  server.on("close", () => { void server.cleanup().catch(() => console.error("Executor closure not confirmed")); });
  return server;
}

if (require.main === module) {
  const file = path.join(__dirname, "config.local.json");
  if (!fs.existsSync(file)) {
    console.error("Not paired. Run: node pair.js <absolute-workspace-path>");
    process.exit(1);
  }
  const server = createBridge(JSON.parse(fs.readFileSync(file, "utf8")));
  const stop = () => { void server.cleanup().then(() => server.close()).catch(() => console.error("Executor closure not confirmed; bridge remains open")); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(JSON.parse(fs.readFileSync(file, "utf8")).port || 18461, "127.0.0.1", () => {
    console.log("AgentDock DeepSeek bridge ready at http://127.0.0.1:" + server.address().port);
    console.log("This service is local-only. It will not change the existing AgentDock service.");
  });
}

module.exports = { createBridge, authenticated };
