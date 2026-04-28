/**
 * Purpose Gate — Forces the engineer to declare intent before working
 *
 * On session start, immediately asks "What is the purpose of this agent?"
 * via a text input dialog. A persistent widget shows the purpose for the
 * rest of the session, keeping focus. Blocks all prompts until answered.
 *
 * Usage: pi -e extensions/purpose-gate.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	let purpose: string | undefined;

	// Skip entirely in headless / sub-agent mode. The dispatcher in team.ts
	// launches sub-agents with `--mode json -p ...`; those sessions have no
	// interactive UI, so prompting for a purpose just crashes them with a
	// "stale extension ctx" error when the (unawaited) input promise tries
	// to use ctx.ui after the session has been replaced.
	const isHeadless = process.argv.some(
		(a) => a === "-p" || a === "--print" || (a === "--mode" && true),
	) || (() => {
		const i = process.argv.indexOf("--mode");
		return i >= 0 && process.argv[i + 1] === "json";
	})();

	async function askForPurpose(ctx: any) {
		try {
			while (!purpose) {
				const answer = await ctx.ui.input(
					"What is the purpose of this agent?",
					"e.g. Refactor the auth module to use JWT"
				);

				if (answer && answer.trim()) {
					purpose = answer.trim();
					(globalThis as any).piSessionPurpose = purpose;
				} else {
					ctx.ui.notify("Purpose is required.", "warning");
				}
			}

			ctx.ui.setWidget("purpose", (_tui: any, theme: any) => {
				return {
					render(width: number): string[] {
						const pad = theme.bg("customMessageBg", " ".repeat(width));
						const label = theme.fg("customMessageLabel", theme.bold("  PURPOSE: "));
						const msg = theme.fg("customMessageText", theme.bold(purpose!));
						const content = theme.bg("customMessageBg", truncateToWidth(label + msg + " ".repeat(width), width, ""));
						return [pad, content, pad];
					},
					invalidate() {},
				};
			});
		} catch (err) {
			// ctx became stale (e.g. session replaced/reloaded); abort the
			// prompt loop rather than crashing the host pi process.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isHeadless) return;
		void askForPurpose(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!purpose) return;
		return {
			systemPrompt: event.systemPrompt + `\n\n<purpose>\nYour singular purpose this session: ${purpose}\nStay focused on this goal. If a request drifts from this purpose, gently remind the user.\n</purpose>`,
		};
	});

	pi.on("input", async (_event, ctx) => {
		if (isHeadless) return { action: "continue" as const };
		if (!purpose) {
			try { ctx.ui.notify("Set a purpose first.", "warning"); } catch {}
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});
}
