"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { minimalEnvironment } = require("./stdio");
const { PolicyError, resolveWorkspace } = require("./policy");
const LIVE = new Set(["starting", "running", "cancelling"]);
function getId(obj, name) {
  if (!obj || typeof obj[name] !== "string" || !obj[name]) throw new Error("Missing " + name);
  return obj[name];
}

class HandoffManager {
  constructor(config, mcp) {
    this.config = config; this.mcp = mcp;
    this.runs = new Map(); this.activeId = null; this.closing = null;
  }

  start(plan, workspace) {
    if (!this.config.allowHandoff) throw new PolicyError("DISABLED", "Multi-step handoff is disabled in local config");
    if (typeof plan !== "string" || !plan.trim() || plan.length > 12000) throw new PolicyError("ARGS", "plan must contain 1-12000 characters");
    if (this.activeId || this.closing) throw new PolicyError("BUSY", "A multi-step run is already active or stopping");
    const cwd = resolveWorkspace(this.config, workspace);
    const id = crypto.randomUUID();
    const run = { id, status: "starting", backend: this.config.backend, workspace: workspace || "w0",
      startedAt: new Date().toISOString(), cursor: 0, output: "", exitCode: null, cancelTarget: null };
    this.runs.set(id, run); this.activeId = id;
    run.timer = setTimeout(() => { void this.cancel(id, "timed_out").catch(() => {}); }, this.config.handoffTimeoutMs || 180000);
    run.timer.unref();
    const approvedPlan = "Execute the user-approved task below in the current workspace. Do not read credentials or unrelated files.\n\n" + plan;
    if (run.backend === "dsh") this.startDsh(run, cwd, approvedPlan);
    else void this.startACP(run, cwd, approvedPlan);
    while (this.runs.size > 20) {
      const old = [...this.runs.values()].find((r) => !LIVE.has(r.status));
      if (!old) break;
      this.runs.delete(old.id);
    }
    return { id, status: run.status, backend: run.backend };
  }

  finish(run, status, note) {
    if (run.finishedAt) return;
    clearTimeout(run.timer);
    run.status = status;
    if (note) run.output = (run.output + "\n" + note).slice(-6000);
    run.finishedAt = new Date().toISOString();
    if (this.activeId === run.id) this.activeId = null;
  }

  async startACP(run, cwd, plan) {
    try {
      run.sessionId = getId(await this.mcp.call("acp_session", { action: "new", cwd, profile_id: this.config.acpProfile }, 60000), "session_id");
      if (run.cancelTarget) {
        await this.mcp.call("acp_session", { action: "close", session_id: run.sessionId, profile_id: this.config.acpProfile });
        this.finish(run, run.cancelTarget); return;
      }
      run.remoteRunId = getId(await this.mcp.call("acp_prompt", { action: "start", session_id: run.sessionId,
        profile_id: this.config.acpProfile, prompt: [{ type: "text", text: plan }] }, 60000), "run_id");
      run.status = run.cancelTarget ? "cancelling" : "running";
      if (run.cancelTarget) await this.requestACPCancel(run);
    } catch { this.finish(run, "failed", "ACP start failed; inspect the local AgentDock status."); }
  }

  startDsh(run, cwd, plan) {
    const env = minimalEnvironment();
    if (this.config.dshElectron) env.ELECTRON_RUN_AS_NODE = "1";
    const args = this.config.dshScript ? [this.config.dshScript] : [];
    args.push("--profile", "headless");
    if (this.config.dshPatch) args.push("--patch", this.config.dshPatch);
    args.push("--json", plan);
    try {
      const child = spawn(this.config.dshExecutable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      run.child = child; run.status = "running";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (text) => { run.output = (run.output + text).slice(-6000); });
      }
      child.on("error", () => this.finish(run, "failed", "DSH process could not start."));
      child.on("close", (code) => { run.exitCode = code; this.finish(run, run.cancelTarget || (code === 0 ? "done" : "failed")); });
    } catch { this.finish(run, "failed", "DSH process could not start."); }
  }

  async get(id) {
    const run = this.runs.get(id);
    if (!run) throw new PolicyError("NOT_FOUND", "Unknown or expired run");
    if (["running", "cancelling"].includes(run.status) && run.backend === "acp" && run.remoteRunId && !run.polling) {
      run.polling = true;
      try {
        const result = await this.mcp.call("acp_prompt", { action: "events", profile_id: this.config.acpProfile,
          run_id: run.remoteRunId, after_seq: run.cursor, limit: 50, wait_ms: 0 });
        if (Number.isInteger(result.next_seq)) run.cursor = result.next_seq;
        for (const e of result.events || []) run.output = (run.output + "\n" + JSON.stringify(e)).slice(-6000);
        if (["completed", "done", "succeeded"].includes(result.status)) this.finish(run, run.cancelTarget || "done");
        else if (["failed", "error", "interrupted"].includes(result.status)) this.finish(run, "failed");
        else if (["cancelled", "canceled"].includes(result.status)) this.finish(run, run.cancelTarget || "cancelled");
        run.pollError = false;
      } catch { run.pollError = true; /* A polling failure does NOT prove the underlying task stopped. */ }
      finally { run.polling = false; }
    }
    return this.publicState(run);
  }

  publicState(run) {
    return { id: run.id, status: run.status, backend: run.backend, workspace: run.workspace,
      startedAt: run.startedAt, finishedAt: run.finishedAt || null, output: run.output.slice(-6000),
      exitCode: run.exitCode, pollingUnavailable: Boolean(run.pollError) };
  }

  async requestACPCancel(run) {
    await this.mcp.call("acp_prompt", { action: "cancel", run_id: run.remoteRunId,
      session_id: run.sessionId, profile_id: this.config.acpProfile });
  }

  async cancel(id, target = "cancelled") {
    const run = this.runs.get(id);
    if (!run) throw new PolicyError("NOT_FOUND", "Unknown run");
    if (!LIVE.has(run.status)) return this.publicState(run);
    run.cancelTarget = target; run.status = "cancelling";
    if (run.backend === "acp") {
      if (run.remoteRunId) await this.requestACPCancel(run);
      return this.get(id);
    }
    if (run.child && run.child.pid) {
      if (process.platform === "win32") {
        await new Promise((resolve, reject) => {
          const killer = spawn("taskkill", ["/PID", String(run.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
          killer.on("error", () => reject(new Error("Could not request process-tree termination")));
          killer.on("close", (code) => code === 0 || run.finishedAt ? resolve() : reject(new Error("Process-tree termination was not confirmed")));
        });
      } else if (!run.child.kill("SIGTERM")) throw new Error("Process termination was not confirmed");
      await new Promise((resolve) => {
        if (run.finishedAt) return resolve();
        const timer = setTimeout(resolve, 3000);
        run.child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    return this.publicState(run);
  }

  async shutdown() {
    if (!this.closing) this.closing = (async () => {
      if (this.activeId) {
        const run = await this.cancel(this.activeId);
        if (LIVE.has(run.status)) throw new PolicyError("BUSY", "Executor stop is not confirmed; bridge remains open");
      }
    })().catch((error) => { this.closing = null; throw error; });
    return this.closing;
  }
}
module.exports = { HandoffManager };
