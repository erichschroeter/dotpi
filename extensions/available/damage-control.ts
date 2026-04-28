// extensions/damage-control.ts

import { ExtensionAPI } from "@mariozechner/pi-agent-sdk";
import * as fs from "fs";
import * as path from "path";

export default function (pi: ExtensionAPI) {
  const DEFAULT_DANGEROUS_PATTERNS = [
    "rm -rf\\s+",
    "sudo\\s+",
    "mkfs\\.",
    "dd\\s+if=",
    "format\\s+",
  ];

  let dangerousPatterns: RegExp[] = [];
  let isEnabled: boolean = true;

  const loadSettings = (cwd: string) => {
    try {
      const settingsPath = path.join(cwd, "settings.json");
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const config = settings.damageControl;
        if (config) {
          isEnabled = config.enabled ?? true;
          const patterns = config.dangerousPatterns ?? DEFAULT_DANGEROUS_PATTERNS;
          dangerousPatterns = patterns.map((p: string) => new RegExp(p));
          console.log("Damage Control: Settings loaded from settings.json");
          return;
        }
      }
    } catch (err) {
      console.error("Damage Control: Failed to load settings:", err);
    }

    // Default settings if file not found or error
    isEnabled = true;
    dangerousPatterns = DEFAULT_DANGEROUS_PATTERNS.map((p) => new RegExp(p));
    console.log("Damage Control: Using default settings");
  };

  // Initialize with current directory, although it might change or not be ready
  // We'll reload in events that provide context
  loadSettings(process.cwd());

  pi.on("agent_start", async (event, ctx) => {
    if (ctx.cwd) {
      loadSettings(ctx.cwd);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as any).command;

      if (!isEnabled || !command) return undefined;
      
      const isDangerous = dangerousPatterns.some((pattern) => pattern.test(command));

      if (isDangerous) {
        if (!ctx.hasUI) {
          return { block: true, reason: "Potentially dangerous command blocked in non-interactive mode." };
        }

        const confirmed = await ctx.ui.confirm(
          "⚠️ Dangerous Command Warning",
          `The following command is flagged as dangerous:\n\n\`${command}\`\n\nDo you want to execute it?`
        );

        if (!confirmed) {
          return { block: true, reason: "Command execution cancelled by user." };
        }
      }
    }
    return undefined;
  });
}
