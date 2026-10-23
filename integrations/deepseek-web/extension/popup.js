"use strict";
const tokenEl = document.getElementById("token");
const statusEl = document.getElementById("status");
document.getElementById("save").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "savePair", token: tokenEl.value.trim() });
  statusEl.textContent = r.ok ? "本地配对信息已保存。" : "错误：" + (r.error || "unknown");
  tokenEl.value = "";
});
document.getElementById("check").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "bridge", method: "GET", path: "/health" });
  statusEl.textContent = r.ok ? "连接成功。工作区：" + r.json.workspaces.join(", ") +
    "\n写入：" + (r.json.allowWrites ? "已启用" : "禁用") +
    "\n多步任务：" + (r.json.allowHandoff ? r.json.backend : "禁用") :
    "连接失败：" + (r.error || (r.json && r.json.error) || r.status || "unknown");
});
