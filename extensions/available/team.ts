/**
 * Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, agents/*.md.
 * Teams are defined in agents/teams.yml — on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
 *
 * Commands:
 *   /team                 — switch active team
 *   /team-list            — list loaded agents
 *   /team-grid N          — set column count (default 2)
 *   /team-lines N         — set output lines in card (default 3)
 *
 * Usage: pi -e extensions/team.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve } from "path";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
	model?: string;
}

const TOOL_MAPPINGS: Record<string, Record<string, string>> = {
	google: {
		shell: "bash",
		read: "read",
		write: "write",
		edit: "edit",
		search: "grep",
	},
	anthropic: {
		shell: "bash",
		read: "read",
		write: "write",
		edit: "edit",
		search: "grep",
	},
	openai: {
		shell: "bash",
		read: "read",
		write: "write",
		edit: "edit",
		search: "grep",
	},
	openrouter: {
		shell: "bash",
		read: "read",
		write: "write",
		edit: "edit",
		search: "grep",
	},
};

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	workLines: string[];
	contextPct: number;
	tokens: number;
	inputTokens: number;
	outputTokens: number;
	sessionFile: string | null;
	tmuxSessionName?: string;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Teams YAML Parser ────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
			model: frontmatter.model,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".gemini", "agents"),
		join(cwd, ".pi", "agents"),
		join(cwd, "agents", "available"),
		join(cwd, ".pi", "agents", "available"),
	];

	const teamsDir = join(cwd, "agents", "teams");
	const piTeamsDir = join(cwd, ".pi", "agents", "teams");
	for (const tDir of [teamsDir, piTeamsDir]) {
		if (existsSync(tDir)) {
			dirs.push(tDir);
			try {
				for (const file of readdirSync(tDir, { withFileTypes: true })) {
					if (file.isDirectory() || file.isSymbolicLink()) {
						dirs.push(join(tDir, file.name));
					}
				}
			} catch {}
		}
	}

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agentStates: Map<string, AgentState> = new Map();
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let outputLines = 3;
	let teamView: "default" | "minimal" | "powerline" | "hidden" = "default";
	let teamTmux = false;
	let widgetCtx: any;
	let sessionDir = "";
	let contextWindow = 0;
	let sessionStartTime = "";

	function getSettingsPath(cwd: string) {
		const profile = process.env.PI_PROFILE || "default";
		return join(cwd, ".pi", "profiles", profile, "settings.json");
	}

	function saveSetting(key: string, value: any) {
		if (!widgetCtx) return;
		const settingsPath = getSettingsPath(widgetCtx.cwd);

		let settings: Record<string, any> = {};
		if (existsSync(settingsPath)) {
			try {
				settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {}
		}

		settings[key] = value;

		try {
			mkdirSync(join(settingsPath, ".."), { recursive: true });
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		} catch {}
	}

	function getSessionDir(cwd: string) {
		if (sessionDir) return sessionDir;
		const purpose = (globalThis as any).piSessionPurpose;
		let suffix = "";
		if (purpose) {
			suffix = "-" + purpose.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30);
		}
		sessionDir = join(cwd, ".pi", "agents", "sessions", `${sessionStartTime}${suffix}`);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}
		return sessionDir;
	}

	function loadAgents(cwd: string) {
		// Load all agent definitions
		allAgentDefs = scanAgentDirs(cwd);

		// Load teams from agents/teams.yml or .yaml
		let teamsPath = "";
		const possibleTeamPaths = [
			join(cwd, "agents", "teams.yml"),
			join(cwd, "agents", "teams.yaml"),
			join(cwd, ".pi", "agents", "teams.yml"),
			join(cwd, ".pi", "agents", "teams.yaml"),
		];
		for (const p of possibleTeamPaths) {
			if (existsSync(p)) {
				teamsPath = p;
				break;
			}
		}

		if (teamsPath) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
			// Fallback: Check for team folders in agents/teams/
			for (const tDir of [join(cwd, "agents", "teams"), join(cwd, ".pi", "agents", "teams")]) {
				if (existsSync(tDir)) {
					try {
						for (const teamName of readdirSync(tDir)) {
							const teamPath = join(tDir, teamName);
							if (existsSync(teamPath)) {
								// For each team folder, list the symlinks/files
								const members: string[] = [];
								for (const file of readdirSync(teamPath)) {
									if (!file.endsWith(".md")) continue;
									const fullPath = resolve(teamPath, file);
									const def = parseAgentFile(fullPath);
									if (def) {
										members.push(def.name);
									}
								}
								if (members.length > 0) {
									teams[teamName] = members;
								}
							}
						}
					} catch {}
				}
			}
		}

		// If no teams defined, create a default "all" team
		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map(d => d.name) };
		}

		// Create single member teams for all global agents (directly in agents directory)
		const globalAgents = allAgentDefs.filter(d => d.file.match(/[\\/]\.?agents[\\/][^\\/]+\.md$/i));
		for (const def of globalAgents) {
			const teamName = def.name.toLowerCase();
			if (!teams[teamName]) {
				teams[teamName] = [def.name];
			}
		}
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const members = [...(teams[teamName] || [])];
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));

		// Ensure global agents (directly in agents directory) are available in all contexts
		const globalAgents = allAgentDefs.filter(d => d.file.match(/[\\/]\.?agents[\\/][^\\/]+\.md$/i));
		for (const def of globalAgents) {
			if (!members.some(m => m.toLowerCase() === def.name.toLowerCase())) {
				members.push(def.name);
			}
		}

		agentStates.clear();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			const key = def.name.toLowerCase().replace(/\s+/g, "-");
			let sessionFile: string | null = null;
			if (sessionDir) {
				const sf = join(sessionDir, `${key}.json`);
				if (existsSync(sf)) sessionFile = sf;
			}
			agentStates.set(def.name.toLowerCase(), {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				workLines: [],
				contextPct: 0,
				tokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				sessionFile,
				runCount: 0,
			});
		}

		// Auto-size grid columns based on team size
		const size = agentStates.size;
		gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w - 1)));
		const nameVisible = Math.min(name.length, w - 1);

		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		const statusStr = `${statusIcon} ${state.status}`;

		if (teamView === "powerline") {
			const combinedStr = `${name} | ${statusStr}${timeStr}`;
			const displayVisible = Math.min(combinedStr.length, w - 1);
			let displayFormatted = "";
			if (combinedStr.length > w - 1) {
				displayFormatted = theme.fg("accent", truncate(combinedStr, w - 1));
			} else {
				displayFormatted = theme.fg("accent", name) + theme.fg("dim", " | ") + theme.fg(statusColor, statusStr + timeStr);
			}
			return [
				theme.fg("dim", top),
				border(" " + displayFormatted, 1 + displayVisible),
				theme.fg("dim", bot)
			];
		}

		// Context bar: 5 blocks + percent
		const filled = Math.ceil(state.contextPct / 20);
		const bar = "#".repeat(filled) + "-".repeat(5 - filled);

		const cost = (state.inputTokens * (0.15 / 1_000_000)) + (state.outputTokens * (0.60 / 1_000_000));
		const costStr = `$${cost.toFixed(4)}`;

		// Combined status + context line: status left-aligned, ctx info right-aligned
		const rightStr = `[${bar}] ${Math.ceil(state.contextPct)}% (${state.tokens}t) ${costStr}`;
		const leftStr = `${statusIcon} ${state.status}${timeStr}`;
		const leftVisible = Math.min(leftStr.length, Math.max(0, w - 2 - rightStr.length));
		const actualLeft = leftStr.length > leftVisible ? leftStr.slice(0, leftVisible - 3) + "..." : leftStr;
		const rightVisible = Math.min(rightStr.length, Math.max(0, w - 2 - leftVisible));
		const gap = Math.max(1, w - 1 - leftVisible - rightVisible);
		const combinedStatusCtx =
			theme.fg(statusColor, actualLeft) +
			" ".repeat(gap) +
			theme.fg("dim", rightStr.slice(0, rightVisible));
		const combinedStatusCtxVisible = 1 + leftVisible + gap + rightVisible;

		const tmuxLine = state.tmuxSessionName ? theme.fg("dim", truncate(`tmux: ${state.tmuxSessionName}`, w - 1)) : "";
		const tmuxVisible = state.tmuxSessionName ? Math.min(`tmux: ${state.tmuxSessionName}`.length, w - 1) : 0;

		if (teamView === "minimal") {
			return [
				theme.fg("dim", top),
				border(" " + nameStr, 1 + nameVisible),
				border(" " + combinedStatusCtx, combinedStatusCtxVisible),
				tmuxLine ? border(" " + tmuxLine, 1 + tmuxVisible) : "",
				theme.fg("dim", bot),
			].filter(Boolean);
		}

		const cardLines = [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + combinedStatusCtx, combinedStatusCtxVisible),
		];
		if (tmuxLine) {
			cardLines.push(border(" " + tmuxLine, 1 + tmuxVisible));
		}

		const displayWorkLines = state.workLines.length > 0
			? state.workLines
			: [truncate(state.task || state.def.description, Math.min(50, w - 1))];

		for (let i = 0; i < outputLines; i++) {
			const text = displayWorkLines[i] || "";
			const workLine = theme.fg("muted", truncate(text, w - 1));
			cardLines.push(border(" " + workLine, 1 + Math.min(text.length, w - 1)));
		}

		cardLines.push(theme.fg("dim", bot));
		return cardLines;
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (teamView === "hidden") {
						text.setText("");
						return [];
					}

					if (agentStates.size === 0) {
						text.setText(theme.fg("dim", "No agents found. Add .md files to agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						const cardHeight = cards[0].length; 
						while (cards.length < cols) {
							cards.push(Array(cardHeight).fill(" ".repeat(colWidth)));
						}

						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || " ".repeat(colWidth)));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "running") {
			return Promise.resolve({
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.workLines = [];
		state.inputTokens = 0;
		state.outputTokens = 0;
		state.tokens = 0;
		state.runCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const targetModelStr = state.def.model || (ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview");

		const provider = targetModelStr.split("/")[0] || "google";

		// Translate tools based on provider
		const cleanedTools = state.def.tools.replace(/[\[\]"']/g, "");
		const rawTools = cleanedTools.split(",").map(t => t.trim());
		const translatedTools = rawTools.map(t => {
			return (TOOL_MAPPINGS[provider] && TOOL_MAPPINGS[provider][t]) ? TOOL_MAPPINGS[provider][t] : t;
		});
		const finalToolsArg = translatedTools.join(",");

		// Session file for this agent
		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(getSessionDir(ctx.cwd), `${agentKey}.json`);

			// Build args — first run creates session, subsequent runs resume
		const piArgs = [
			"--mode", "json",
			"-p",
			"--model", targetModelStr,
			"--tools", finalToolsArg,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			"--session", agentSessionFile,
		];

		// Continue existing session if we have one
		if (state.sessionFile) {
			piArgs.push("-c");
		}

		piArgs.push(task);

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];

		return new Promise((resolve) => {
			let proc;
			let tmuxSessionName = "";
			let tmuxExitCode: number | null = null;
			let tmuxCheckInterval: ReturnType<typeof setInterval> | undefined;
			let resolved = false;

			function finalize(exitCode: number) {
				if (resolved) return;
				resolved = true;

				if (tmuxCheckInterval) {
					clearInterval(tmuxCheckInterval);
					tmuxCheckInterval = undefined;
				}
				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = exitCode === 0 ? "done" : "error";

				if (exitCode === 0) {
					state.sessionFile = agentSessionFile;
				}

				const full = textChunks.join("");
				const stderr = stderrChunks.join("");
				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				const output = stderr ? `${full}\n\n[stderr]\n${stderr}` : full;
				resolve({
					output: state.tmuxSessionName ? `[tmux: ${state.tmuxSessionName}]\n${output}` : output,
					exitCode,
					elapsed: state.elapsed,
				});
			}

			if (!teamTmux) {
				state.tmuxSessionName = undefined;
				proc = spawn("pi", piArgs, {
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
				});
			} else {
				// Tmux implementation:
				tmuxSessionName = `pi-agent-${key}-${Date.now()}`;
				state.tmuxSessionName = tmuxSessionName;
				const tmpLog = join(getSessionDir(ctx.cwd), `${tmuxSessionName}.log`);
				const doneFile = join(getSessionDir(ctx.cwd), `${tmuxSessionName}.done`);
				const scriptFile = join(getSessionDir(ctx.cwd), `${tmuxSessionName}.sh`);
				const stderrLog = join(getSessionDir(ctx.cwd), `${tmuxSessionName}.stderr`);

				// Create log file before tail to avoid race condition
				writeFileSync(tmpLog, "", "utf-8");

				const shellEscape = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
				const escapedArgs = piArgs.map(a => shellEscape(a)).join(" ");

				// Export the current environment into the script so tmux sessions
				// (which inherit the server's env, not the spawner's) get API keys,
				// PATH, and other variables needed by pi.
				const envExports = Object.entries(process.env)
					.filter(([k, v]) => v !== undefined && k !== "_" && k !== "SHLVL")
					.map(([k, v]) => `export ${k}=${shellEscape(v!)}`)
					.join("\n");

				const script = [
					"#!/bin/bash",
					envExports,
					`pi ${escapedArgs} 2>${shellEscape(stderrLog)} | tee ${shellEscape(tmpLog)}`,
					`echo \${PIPESTATUS[0]} > ${shellEscape(doneFile)}`,
					"sleep 1",
				].join("\n");
				writeFileSync(scriptFile, script, { mode: 0o755 });

				const tmuxProc = spawn("tmux", ["new-session", "-d", "-s", tmuxSessionName, "bash", scriptFile], {
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
				});
				ctx.ui.notify(`Started tmux session: ${tmuxSessionName}`, "info");
				tmuxProc.on("error", (err) => {
					stderrChunks.push(`tmux spawn error: ${err.message}`);
					finalize(1);
				});
				tmuxProc.on("close", (code) => {
					if (code !== 0 && code !== null) {
						stderrChunks.push(`tmux exited with code ${code}`);
						finalize(1);
					}
				});

				proc = spawn("tail", ["-f", "-n", "+1", tmpLog], {
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
				});

				// Poll for doneFile to detect when pi finishes
				tmuxCheckInterval = setInterval(() => {
					if (existsSync(doneFile)) {
						clearInterval(tmuxCheckInterval!);
						tmuxCheckInterval = undefined;
						const codeStr = readFileSync(doneFile, "utf-8").trim();
						const code = parseInt(codeStr, 10);
						tmuxExitCode = isNaN(code) ? 1 : code;

						// Capture pi's stderr before cleanup
						try {
							const piStderr = readFileSync(stderrLog, "utf-8");
							if (piStderr.trim()) stderrChunks.push(piStderr);
						} catch {}

						// Kill tail — the close handler will use tmuxExitCode
						proc.kill();

						// Cleanup tmux session and temp files
						spawn("tmux", ["kill-session", "-t", tmuxSessionName]);
						try { unlinkSync(tmpLog); } catch {}
						try { unlinkSync(doneFile); } catch {}
						try { unlinkSync(scriptFile); } catch {}
						try { unlinkSync(stderrLog); } catch {}
					}
				}, 500);
			}

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
							}
							const full = (event.message?.full || "").trim();
							if (full) {
								const lines = full.split("\n").filter((l: string) => l.trim());
								state.workLines = lines.slice(-outputLines);
								state.lastWork = state.workLines[state.workLines.length - 1] || "";
								updateWidget();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							updateWidget();
						} else if (event.type === "message_end") {
							const msg = event.message;
							if (msg?.usage) {
								state.inputTokens = msg.usage.input || 0;
								state.outputTokens = msg.usage.output || 0;
								state.tokens = state.inputTokens + state.outputTokens;
								if (contextWindow > 0) state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						} else if (event.type === "agent_end") {
							const msgs = event.messages || [];
							const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
							if (last?.usage) {
								state.inputTokens = last.usage.input || 0;
								state.outputTokens = last.usage.output || 0;
								state.tokens = state.inputTokens + state.outputTokens;
								if (contextWindow > 0) state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			// Capture stderr for diagnostics (Bug 5 fix)
			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				stderrChunks.push(chunk);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				// For tmux path, use the real pi exit code instead of tail's (Bug 3 fix)
				const exitCode = tmuxExitCode !== null ? tmuxExitCode : (code ?? 1);
				finalize(exitCode);
			});

			proc.on("error", (err) => {
				stderrChunks.push(err.message);
				finalize(1);
			});
		});
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };

			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching" },
					});
				}

				const result = await dispatchAgent(agent, task, ctx);

				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;

				const status = result.exitCode === 0 ? "done" : "error";
				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

				return {
					content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
					details: {
						agent,
						task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("team", {
		description: "Select a team to work with",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				ctx.ui.notify("No teams defined in agents/teams.yml", "warning");
				return;
			}

			const options = teamNames.map(name => {
				const members = teams[name].map(m => displayName(m));
				return `${name} — ${members.join(", ")}`;
			});

			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			const name = teamNames[idx];
			activateTeam(name);
			updateWidget();
			ctx.ui.setStatus("team", `Team: ${name} (${agentStates.size})`);
			ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
			saveSetting("defaultTeam", name);
		},
	});

	pi.registerCommand("team-list", {
		description: "List all loaded agents",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const names = Array.from(agentStates.values())
				.map(s => {
					const session = s.sessionFile ? "resumed" : "new";
					return `${displayName(s.def.name)} (${s.status}, ${session}, runs: ${s.runCount}): ${s.def.description}`;
				})
				.join("\n");
			_ctx.ui.notify(names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("team-grid", {
		description: "Set grid columns: /team-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({
				value: n,
				label: `${n} columns`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
				saveSetting("teamGrid", gridCols);
			} else {
				_ctx.ui.notify("Usage: /team-grid <1-6>", "error");
			}
		},
	});

	pi.registerCommand("team-lines", {
		description: "Set output lines: /team-lines <number>",
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 10) {
				outputLines = n;
				_ctx.ui.notify(`Output lines set to ${outputLines}`, "info");
				updateWidget();
				saveSetting("outputLines", outputLines);
			} else {
				_ctx.ui.notify("Usage: /team-lines <1-10>", "error");
			}
		},
	});

	pi.registerCommand("team-view", {
		description: "Set team view: /team-view <default|minimal|powerline|hidden>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["default", "minimal", "powerline", "hidden"].map(v => ({
				value: v,
				label: `${v} view`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const v = args?.trim();
			if (v === "default" || v === "minimal" || v === "powerline" || v === "hidden") {
				teamView = v as "default" | "minimal" | "powerline" | "hidden";
				_ctx.ui.notify(`Team view set to ${v}`, "info");
				updateWidget();
				saveSetting("teamView", teamView);
			} else {
				_ctx.ui.notify("Usage: /team-view <default|minimal|powerline|hidden>", "error");
			}
		},
	});

	pi.registerCommand("team-tmux", {
		description: "Set tmux mode: /team-tmux <on|off>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["on", "off"].map(v => ({
				value: v,
				label: `tmux ${v}`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const v = args?.trim();
			if (v === "on" || v === "off") {
				teamTmux = v === "on";
				_ctx.ui.notify(`Team tmux set to ${teamTmux ? "on" : "off"}`, "info");
				saveSetting("teamTmux", teamTmux);
			} else {
				_ctx.ui.notify("Usage: /team-tmux <on|off>", "error");
			}
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!activeTeamName) {
			return {
				systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase.
Currently, NO TEAM is active. Ask the user to select a team using /team before you can dispatch work.`,
			};
		}

		// Build dynamic agent catalog from active team only
		const agentCatalog = Array.from(agentStates.values())
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
			.join("\n\n");

		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

		return {
			systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents outside this team.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Choose the right agent(s) for each sub-task
- Dispatch tasks using the dispatch_agent tool
- Review results and dispatch follow-up agents if needed
- If a task fails, try a different agent or adjust the task description
- Summarize the outcome for the user

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`,
		};
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// In headless mode (sub-agent dispatched via `pi -p`), do NOT activate
		// a team or override active tools. Otherwise this extension would clobber
		// the sub-agent's --tools selection with just ["dispatch_agent"], which
		// causes the LLM (especially Gemini) to error out when it tries to do
		// real work with tools the parent passed via --tools.
		const argv = process.argv.slice(2);
		const isHeadless =
			argv.includes("-p") ||
			argv.includes("--print") ||
			argv.some((a, i) => a === "--mode" && argv[i + 1] === "json");
		if (isHeadless) {
			return;
		}

		// Clear widgets from previous session
		if (widgetCtx) {
			widgetCtx.ui.setWidget("team", undefined);
		}
		widgetCtx = _ctx;
		contextWindow = _ctx.model?.contextWindow || 0;
		sessionStartTime = new Date().toISOString().replace(/[:.]/g, "-");

		loadAgents(_ctx.cwd);

		// Read default team from settings.json
		let defaultTeam = "";
		const settingsPath = getSettingsPath(_ctx.cwd);

		if (existsSync(settingsPath)) {
			try {
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
				if (settings.defaultTeam) defaultTeam = settings.defaultTeam;
				if (settings.teamView) teamView = settings.teamView;
				if (typeof settings.teamGrid === "number") gridCols = settings.teamGrid;
				if (typeof settings.outputLines === "number") outputLines = settings.outputLines;
				if (typeof settings.teamTmux === "boolean") teamTmux = settings.teamTmux;
			} catch {}
		}

		const teamNames = Object.keys(teams);
		if (defaultTeam && teamNames.includes(defaultTeam)) {
			activateTeam(defaultTeam);
		} else if (teamNames.length > 0) {
			activateTeam(teamNames[0]);
		} else {
			activeTeamName = "";
			gridCols = 1;
		}

		// Lock down to dispatcher-only (tool already registered at top level)
		pi.setActiveTools(["dispatch_agent"]);

		if (activeTeamName) {
			_ctx.ui.setStatus("team", `Team: ${activeTeamName} (${agentStates.size})`);
			const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
			_ctx.ui.notify(
				`Team: ${activeTeamName} (${members})\n` +
				`Team sets loaded from: agents/teams.yml or agents/teams/\n\n` +
				`/team                 Select a team\n` +
				`/team-list            List active agents and status\n` +
				`/team-grid <1-6>      Set grid column count\n` +
				`/team-lines <1-10>     Set output lines per card`,
				"info",
			);
		} else {
			_ctx.ui.setStatus("team", `Team: none`);
			_ctx.ui.notify(
				`No team loaded.\n` +
				`Set "defaultTeam" in settings.json, or use:\n` +
				`/team                 Select a team\n` +
				`/team-list            List active agents and status\n` +
				`/team-grid <1-6>      Set grid column count`,
				"info",
			);
		}
		updateWidget();

		// Footer: model | team | context bar
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", activeTeamName);
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
				},
				}));
				});
				}
