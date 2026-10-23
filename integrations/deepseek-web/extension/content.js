"use strict";
(() => {
  // The webpage cannot access the pairing token. It lives in extension storage.
  // All operations and result transfers require deliberate user clicks.
  if (document.getElementById("agentdock-deepseek-host")) return;
  const OPEN = "\u27E6AD\u27E7";
  const CLOSE = "\u27E6/AD\u27E7";
  const host = document.createElement("div");
  host.id = "agentdock-deepseek-host";
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}*,*:before,*:after{box-sizing:border-box}",
    ".wrap{width:315px;max-height:70vh;overflow:auto;background:#fff;color:#263242;border:1px solid #c9d3e0;border-radius:12px;box-shadow:0 4px 24px #14233c38;padding:12px;font:12px/1.5 system-ui,Arial,sans-serif}",
    ".title{font-weight:700;font-size:14px;margin-bottom:6px}",
    ".meta{color:#66758a;margin-bottom:9px}",
    ".buttons{display:flex;flex-wrap:wrap;gap:6px}",
    "button{background:#eef3ff;color:#25488f;border:1px solid #cbd9f8;border-radius:6px;padding:6px 9px;cursor:pointer}",
    "button:disabled{opacity:.45;cursor:default}",
    "textarea{margin-top:8px;width:100%;min-height:75px;max-height:180px;resize:vertical;border:1px solid #c7cfdd;border-radius:5px;font:11px/1.5 Consolas,monospace;padding:6px}",
    "pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:auto;margin:8px 0;background:#f7f9fd;padding:6px;border-radius:4px}",
    ".warning{color:#a1431c;margin-top:8px}"
  ].join("\n");
  const panel = document.createElement("section");
  panel.className = "wrap";
  panel.innerHTML = [
    '<div class="title">AgentDock · DeepSeek Web</div>',
    '<div class="meta" id="ad-status">未连接。先在扩展图标中配对。</div>',
    '<div class="buttons">',
    '<button id="ad-check">连接测试</button>',
    '<button id="ad-protocol">复制协议</button>',
    '<button id="ad-scan">检查 AI 工具请求</button>',
    '<button id="ad-execute" disabled>确认执行</button>',
    '<button id="ad-poll" disabled>查询进度</button>',
    '<button id="ad-cancel" disabled>停止任务</button>',
    '<button id="ad-copy" disabled>复制结果</button>',
    '</div>',
    '<pre id="ad-preview">每一步均需手动确认，结果不会自动发送给 DeepSeek。</pre>',
    '<textarea id="ad-output" readonly placeholder="工具结果会显示在这里，确认无敏感信息后手动复制到聊天框。"></textarea>',
    '<div class="warning">请勿回传公司秘密、财务数据或个人信息。ACP / dsh 任务有电脑用户权限，不等于系统沙箱。</div>'
  ].join("");
  shadow.append(style, panel);
  document.documentElement.appendChild(host);

  const get = (id) => shadow.getElementById(id);
  let candidate = null;
  let candidateKey = null;
  let lastExecutedKey = null;
  let activeRunId = null;
  let connected = false;
  const status = (text) => { get("ad-status").textContent = text; };
  const preview = (text) => { get("ad-preview").textContent = String(text).slice(0, 1800); };
  const output = (value) => {
    get("ad-output").value = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    get("ad-copy").disabled = !get("ad-output").value;
  };

  async function bridge(method, path, body) {
    const r = await chrome.runtime.sendMessage({ type: "bridge", method, path, body });
    if (!r?.ok) {
      const error = (r?.json?.error?.message || r?.json?.error || r?.error || r?.status || "unknown");
      throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    }
    return r.json;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      status("已复制。请核对后手动粘贴发送。");
    } catch {
      output(text);
      get("ad-output").focus();
      get("ad-output").select();
      status("未获得剪贴板权限，请手动复制文本框。");
    }
  }

  const protocol = [
    "[AgentDock Web 本地工具协议：需人工逐次批准]",
    "当需要在已授权本地工作区调用工具时，只输出一个工具调用标记：",
    OPEN + '{"tool":"ad_tree","args":{"path":".","depth":2},"workspace":"w0"}' + CLOSE,
    "工具列表：",
    "- ad_tree {path?: 相对路径,depth?:1..3}；查看目录",
    "- ad_read {path: 相对路径,start?:1,lines?:80}；读取文本",
    "- ad_search {query:文本,path?:相对路径}；查找文字",
    "- ad_edit {path,oldText,newText}；仅在本地开启写权限后可用",
    "- ad_handoff {plan:完整任务计划}；本地启用后可交给 AgentDock ACP 或 dsh headless",
    "严格规则：所有路径相对于工作区，最多一个工具调用；不生成 shell 命令。",
    "每次调用由用户在扩展中人工确认，结果也由用户审查后手动发送。",
    "不要请求凭据、令牌、隐私或敏感业务文件，也不要声称工具已执行，除非收到真实结果。",
    "调用后停止输出并等待用户提供工具结果。"
  ].join("\n");

  function extractCall(text) {
    const start = text.lastIndexOf(OPEN);
    if (start < 0) return null;
    const end = text.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) return null;
    const raw = text.slice(start + OPEN.length, end);
    if (raw.length > 13000) throw new Error("Tool request too large");
    const obj = JSON.parse(raw.trim());
    if (!obj || typeof obj.tool !== "string" || !/^ad_(tree|read|search|edit|handoff)$/.test(obj.tool)) {
      throw new Error("Tool not allowlisted");
    }
    if (obj.workspace !== undefined && !/^w[0-9]+$/.test(obj.workspace)) throw new Error("Invalid workspace");
    return { tool: obj.tool, args: obj.args || {}, workspace: obj.workspace || "w0" };
  }

  function lastAssistantText() {
    // Selectors are best-effort because DeepSeek does not publish a stable DOM API.
    const selectors = [
      ".ds-markdown", ".markdown", ".markdown-body",
      '[data-testid="assistant-message"]', '[class*="markdown"]'
    ];
    const matches = [];
    for (const s of selectors) {
      for (const node of document.querySelectorAll(s)) {
        if (node.closest("#agentdock-deepseek-host")) continue;
        const text = node.textContent || "";
        if (text.includes(OPEN) && text.includes(CLOSE)) matches.push({ node, text });
      }
    }
    if (!matches.length) return "";
    // Document order: newest matching response wins; never parse our own panel.
    matches.sort((a, b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return matches[matches.length - 1].text;
  }

  get("ad-check").addEventListener("click", async () => {
    try {
      const response = await bridge("GET", "/health");
      connected = true;
      status("已连接；工作区：" + response.workspaces.join(", ") +
        "；写入：" + (response.allowWrites ? "开启" : "关闭") +
        "；多步：" + (response.allowHandoff ? response.backend : "关闭"));
    } catch (e) { connected = false; status("连接失败：" + e.message); }
  });
  get("ad-protocol").addEventListener("click", async () => {
    try {
      const available = new Set((await bridge("GET", "/tools")).tools.map((item) => item.name));
      const text = protocol.split("\n").filter((line) => {
        const match = /^- (ad_[a-z]+)/.exec(line);
        return !match || available.has(match[1]);
      }).join("\n");
      await copy(text);
    } catch (e) { status("协议读取失败：" + e.message); }
  });
  get("ad-scan").addEventListener("click", () => {
    try {
      const responseText = lastAssistantText();
      const key = responseText.length + ":" + responseText.slice(-300);
      if (key === lastExecutedKey) {
        candidate = null;
        get("ad-execute").disabled = true;
        preview("这条回复已经执行过一次，请等待新的 AI 回复，防止重复写入或重复交接任务。");
        return;
      }
      candidate = extractCall(responseText);
      if (!candidate) { preview("最新回复没有找到完整的 " + OPEN + " 工具请求。"); return; }
      candidateKey = key;
      preview(JSON.stringify(candidate, null, 2));
      get("ad-execute").disabled = false;
      status("检查路径和任务后，点击确认执行。");
    } catch (e) {
      candidate = null;
      get("ad-execute").disabled = true;
      status("工具请求解析失败：" + e.message);
    }
  });
  get("ad-execute").addEventListener("click", async () => {
    if (!candidate) return;
    get("ad-execute").disabled = true;
    const current = candidate;
    candidate = null;
    lastExecutedKey = candidateKey; // Mark before invoking; failures may still have side effects.
    candidateKey = null;
    status("正在调用本地 AgentDock…");
    try {
      const result = await bridge("POST", "/tool", current);
      output({ tool: current.tool, ok: result.ok, data: result.data });
      activeRunId = current.tool === "ad_handoff" && result.data?.id || null;
      get("ad-poll").disabled = !activeRunId;
      get("ad-cancel").disabled = !activeRunId;
      status(activeRunId ? "任务已开始。点击查询进度，完成后再审查结果。" : "已取得结果；未自动发送。");
    } catch (e) {
      output({ ok: false, error: e.message });
      status("调用失败：" + e.message);
    }
  });
  get("ad-poll").addEventListener("click", async () => {
    if (!activeRunId) return;
    try {
      const { run } = await bridge("GET", "/runs/" + activeRunId);
      output(run);
      if (!["starting", "running"].includes(run.status)) {
        activeRunId = null;
        get("ad-poll").disabled = true;
        get("ad-cancel").disabled = true;
      }
      status("任务状态：" + run.status);
    } catch (e) { status("查询失败：" + e.message); }
  });
  get("ad-cancel").addEventListener("click", async () => {
    if (!activeRunId) return;
    try {
      const { run } = await bridge("POST", "/runs/" + activeRunId + "/cancel");
      output(run);
      activeRunId = null;
      get("ad-poll").disabled = true;
      get("ad-cancel").disabled = true;
      status("已提交停止请求。");
    } catch (e) { status("停止失败：" + e.message); }
  });
  get("ad-copy").addEventListener("click", () => copy(get("ad-output").value));
})();
