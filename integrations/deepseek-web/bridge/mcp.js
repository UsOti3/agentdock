"use strict";

// MCP Streamable HTTP JSON-response client. AgentDock currently uses a stateless endpoint.
class MCPClient {
  constructor(url, token = "", fetchImpl = globalThis.fetch) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.id = 0;
    this.initialized = false;
  }

  async request(method, params, timeoutMs = 30000) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    const response = await this.fetchImpl(this.url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("AgentDock MCP HTTP " + response.status);
    if (!String(response.headers.get("content-type") || "").includes("application/json")) {
      throw new Error("AgentDock did not return a JSON MCP response");
    }
    const payload = await response.json();
    if (payload.error) throw new Error("AgentDock MCP: " + (payload.error.message || "request failed"));
    if (!payload.result) throw new Error("AgentDock MCP returned no result");
    return payload.result;
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "agentdock-deepseek-web", version: "0.1.0" },
    });
    this.initialized = true;
    return response;
  }

  async call(name, args = {}, timeoutMs = 30000) {
    if (!this.initialized) await this.initialize();
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (result.isError) {
      const message = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      throw new Error("AgentDock tool rejected request: " + message.slice(0, 500));
    }
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const contents = (result.content || []).filter((c) => c.type === "text").map((c) => c.text);
    if (contents.length === 1) {
      try { return JSON.parse(contents[0]); } catch { return { text: contents[0] }; }
    }
    return { content: contents };
  }
}

module.exports = { MCPClient };
