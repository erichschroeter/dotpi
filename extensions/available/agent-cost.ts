import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

const LOG_FILE = path.join(process.cwd(), ".pi/agents/agent-telemetry.jsonl");

export default function (pi: ExtensionAPI) {
  console.log("agent-cost extension loaded");
  console.log("Telemetry log path:", LOG_FILE);
  const sessionStarts = new Map<string, number>();

  // Ensure directory exists
  try {
    if (!fs.existsSync(path.dirname(LOG_FILE))) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    }
  } catch (err) {
    console.error("Failed to create telemetry directory:", err);
  }

  pi.on("before_agent_start", (data: any) => {
    console.log("Extension hook: before_agent_start fired");
    console.log("DEBUG: before_agent_start data:", JSON.stringify(data));
    sessionStarts.set(data.sessionId, Date.now());
  });

  pi.on("after_agent_response", (data: any) => {
    console.log("Extension hook: after_agent_response fired");
    console.log("DEBUG: after_agent_response data:", JSON.stringify(data));
    const startTime = sessionStarts.get(data.sessionId) || Date.now();
    const duration = Date.now() - startTime;

    const telemetryEntry = {
      timestamp: new Date().toISOString(),
      sessionId: data.sessionId,
      agent: data.agentName,
      duration_ms: duration,
      tokens: data.tokenUsage
        ? {
            promptTokens: data.tokenUsage.promptTokens,
            completionTokens: data.tokenUsage.completionTokens,
            totalTokens: data.tokenUsage.totalTokens,
          }
        : null,
      status: data.status
    };

    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(telemetryEntry) + "\n");
    } catch (err) {
      console.error("Failed to append to telemetry log:", err);
    }
  });

  pi.registerCommand("cost", {
    description: "Summarize telemetry for a specific session or all sessions",
    handler: async (args, ctx) => {
      const sessionId = args[0];
      if (!fs.existsSync(LOG_FILE)) {
        ctx.ui.notify("No telemetry data found.", "warning");
        return;
      }

      const lines = fs.readFileSync(LOG_FILE, "utf-8").split("\n");
      let totalTokens = 0;
      let totalDuration = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!sessionId || entry.sessionId === sessionId) {
            if (entry.tokens) {
              totalTokens += (entry.tokens.promptTokens || 0) + (entry.tokens.completionTokens || 0);
            }
            totalDuration += entry.duration_ms || 0;
          }
        } catch (e) {
          console.error("Failed to parse telemetry line:", line, e);
        }
      }

      const sessionLabel = sessionId ? `Session ${sessionId.substring(0,8)}...` : "All sessions";
      ctx.ui.notify(`${sessionLabel} Cost: ${totalTokens} tokens, ${Math.round(totalDuration / 1000)}s total time.`, "info");
    },
  });
}
