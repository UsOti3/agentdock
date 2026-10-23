"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { PolicyError, resolveWorkspace } = require("./policy");

function getId(obj, name) {
  if (!obj || typeof obj !== "object" || typeof obj[name] !== "string" || !obj[name]) {
    throw new Error("AgentDock did not return " + name);
  }
  return obj[name];
}

class HandoffManager {
  constructor(config, mcp) {
    this.config = config;
    this.mcp = mcp;
    this.runs = new Map();
    this.activeId = null;
  }

  start(plan, workspace) {
    if (!this.config.allowHandoff) throw new PolicyError("DISABLED", "Multi-step handoff is disabled in local config");
    if (typeof plan !== "string" || !plan.trim() || plan.length > 12000) {
      throw new PolicyError("ARGS", "plan must contain 1-12000 characters");
    }
    if (this.activeId) throw new PolicyError("BUSY", "A multi-step run is already active");
    const cwd = resolveWorkspace(this.config, workspace);
    const id = crypto.randomUUID();
    const run = { id, status: "starting", backend: this.config.backend,
      workspace: workspace || "w0", startedAt: new Date().toISOString(),
      remoteRunId: null, sessionId: null, cursor: 0, output: "", exitCode: null };
    this.runs.set(id, run);
    this.activeId = id;
    // Neither the browser nor the bridge sends data to the web automatically.
    if (this.config.backend === "dsh") this.startDsh(run, cwd, plan);
    else void this.startACP(run, cwd, plan);
    // Bound in-memory state; never save raw agent output to a public directory.
    if (this.runs.size > 20) {
      for (const [oldId, oldRun] of this.runs) {
        if (oldId !== this.activeId && oldRun.status !== "running" && oldRun.status !== "starting") {
          this.runs.delete(oldId);
          break;
        }
      }
    }
    return { id, status: run.status, backend: run.backend };
  }

  finish(run, status, note) {
    if (run.status === "cancelled" && status !== "cancelled") return;
    run.status = status;
    if (note) run.output = String(note).slice(-6000);
    run.finishedAt = new Date().toISOString();
    if (this.activeId === run.id) this.activeId = null;
  }

  async startACP(run, cwd, plan) {
    try {
      const session = await this.mcp.call("acp_session", {
        action: "new", cwd, profile_id: this.config.acpProfile,
      }, 60000);
      run.sessionId = getId(session, "session_id");
      if (run.status === "cancelled") return;
      const prompt = await this.mcp.call("acp_prompt", {
        action: "start", session_id: run.sessionId, profile_id: this.config.acpProfile,
        prompt: [{ type: "text", text: plan }],
      }, 60000);
      run.remoteRunId = getId(prompt, "run_id");
      if (run.status === "cancelled") {
        await this.mcp.call("acp_prompt", { action: "cancel", run_id: run.remoteRunId,
          session_id: run.sessionId, profile_id: this.config.acpProfile });
        return;
      }
      run.status = "running";
    } catch (err) {
      this.finish(run, "failed", "ACP initialization or prompt failed: " + String(err.message).slice(0, 500));
    }
  }

  startDsh(run, cwd, plan) {
    let child;
    try {
      // Never propagate the bridge's upstream authentication token to a child process.
      const childEnv = {};
      for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "LANG"]) {
        if (process.env[key]) childEnv[key] = process.env[key];
      }
      child = spawn(this.config.dshExecutable, ["--profile", "headless", plan], {
        cwd, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.finish(run, "failed", "DSH process could not start: " + err.message);
      return;
    }
    run.child = child;
    run.status = "running";
    const append = (chunk) => { run.output = (run.output + chunk.toString("utf8")).slice(-6000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => this.finish(run, "failed", "DSH error: " + err.message));
    child.on("close", (code) => {
      run.exitCode = code;
      this.finish(run, code === 0 ? "done" : "failed");
    });
  }

  async get(id) {
    const run = this.runs.get(id);
    if (!run) throw new PolicyError("NOT_FOUND", "Unknown or expired run");
    if (run.status === "running" && run.backend === "acp" && !run.polling) {
      run.polling = true;
      try {
        const events = await this.mcp.call("acp_prompt", {
          action: "events", profile_id: this.config.acpProfile, run_id: run.remoteRunId,
          after_seq: run.cursor, limit: 50, wait_ms: 0,
        }, 30000);
        if (typeof events.next_seq === "number") run.cursor = events.next_seq;
        for (const e of events.events || []) {
          const eText = JSON.stringify(e);
          if (eText) run.output = (run.output + "\n" + eText).slice(-6000);
        }
        const status = String(events.status || "");
        if (["completed", "done", "succeeded"].includes(status)) this.finish(run, "done");
        if (["failed", "error", "cancelled", "canceled"].includes(status)) this.finish(run, "failed");
      } catch (err) {
        this.finish(run, "failed", "ACP events failed: " + String(err.message).slice(0, 300));
      } finally {
        run.polling = false;
      }
    }
    return this.publicState(run);
  }

  publicState(run) {
    return {
      id: run.id, status: run.status, backend: run.backend, workspace: run.workspace,
      startedAt: run.startedAt, finishedAt: run.finishedAt || null,
      output: run.output.slice(-6000), exitCode: run.exitCode,
    };
  }

  async cancel(id) {
    const run = this.runs.get(id);
    if (!run) throw new PolicyError("NOT_FOUND", "Unknown run");
    if (!["starting", "running"].includes(run.status)) return this.publicState(run);
    this.finish(run, "cancelled", "Cancelled by user");
    if (run.backend === "acp" && run.remoteRunId) {
      await this.mcp.call("acp_prompt", {
        action: "cancel", run_id: run.remoteRunId, session_id: run.sessionId,
        profile_id: this.config.acpProfile,
      });
    } else if (run.backend === "dsh" && run.child && run.child.pid) {
      // Windows child-process tree termination when available, without shell interpolation.
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(run.child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        run.child.kill("SIGTERM");
      }
    }
    return this.publicState(run);
  }
}

module.exports = { HandoffManager };
