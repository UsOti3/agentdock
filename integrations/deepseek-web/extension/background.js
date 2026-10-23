"use strict";
const ENDPOINT = "http://127.0.0.1:18461";

function authorizedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const url = String(sender.url || "");
  return url.startsWith("https://chat.deepseek.com/") ||
    url.startsWith(chrome.runtime.getURL("popup.html"));
}

async function callLocal(method, path, body) {
  if (method !== "GET" && method !== "POST") throw new Error("Unsupported method");
  if (!/^\/(?:health|tools|tool|runs\/[a-f0-9-]{36}(?:\/cancel)?)$/.test(path)) {
    throw new Error("Unsupported local route");
  }
  const data = await chrome.storage.local.get(["pairToken"]);
  if (!/^[a-f0-9]{64}$/i.test(data.pairToken || "")) throw new Error("Pair in extension popup first");
  const response = await fetch(ENDPOINT + path, {
    method,
    headers: {
      Authorization: "Bearer " + data.pairToken,
      "Content-Type": "application/json"
    },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined
  });
  const json = await response.json();
  return { ok: response.ok && json.ok, status: response.status, json };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!authorizedSender(sender)) {
    sendResponse({ ok: false, error: "Unauthorized sender" });
    return false;
  }
  (async () => {
    if (message?.type === "savePair") {
      if (!String(sender.url || "").startsWith(chrome.runtime.getURL("popup.html"))) {
        throw new Error("Pairing is restricted to extension popup");
      }
      if (!/^[a-f0-9]{64}$/i.test(message.token || "")) throw new Error("Invalid token format");
      await chrome.storage.local.set({ pairToken: message.token });
      return { ok: true };
    }
    if (message?.type === "bridge") return await callLocal(message.method, message.path, message.body);
    throw new Error("Unknown message type");
  })().then(sendResponse, (err) => sendResponse({
    ok: false, error: String(err.message || err).slice(0, 300)
  }));
  return true;
});
