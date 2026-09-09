import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { collect } from "./collect";
import { formatHeadline, formatJson, formatStatusLine, formatTable } from "./format";
import { appendSessionReport, defaultLogDir } from "./log";
import type { ModelResolver } from "./roles";
import type { CollectResult, SessionEntryLike } from "./types";

const WIDGET_KEY = "modellog";
const WIDGET_TIMEOUT_MS = 45_000;

/**
 * Sub-agent (task tool) runs rebind the parent's prepared extensions, so this
 * factory also loads inside every `task` invocation. A sub-agent session
 * always carries a `session_init` entry; a main session never does — that's
 * the one authoritative, path-independent signal to skip commands/logging
 * there and avoid double-registering or double-flushing.
 */
function isSubagentSession(ctx: ExtensionContext): boolean {
	try {
		const entries = ctx.sessionManager.getEntries() as unknown as SessionEntryLike[];
		return entries.some((e) => e.type === "session_init");
	} catch {
		return false;
	}
}

function buildResolver(ctx: ExtensionContext): ModelResolver | undefined {
	if (!ctx.models || typeof ctx.models.resolve !== "function") return undefined;
	return {
		resolve(spec: string) {
			const model = ctx.models.resolve(spec);
			return model ? { provider: model.provider, id: model.id } : undefined;
		},
	};
}

function runCollect(ctx: ExtensionContext): CollectResult {
	const entries = ctx.sessionManager.getEntries() as unknown as SessionEntryLike[];
	return collect(entries, buildResolver(ctx));
}

function getAgentDir(pi: ExtensionAPI): string | undefined {
	try {
		const namespace = pi.pi as unknown as { getAgentDir?: () => string };
		return typeof namespace.getAgentDir === "function" ? namespace.getAgentDir() : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const flushedSessions = new Set<string>();

	function flushSessionReport(ctx: ExtensionContext, reason: string) {
		if (isSubagentSession(ctx)) return;
		if (process.env.OMP_MODELLOG_QUIET === "1") return;

		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}
		const dedupeKey = sessionId ?? ctx.cwd;
		if (dedupeKey) {
			if (flushedSessions.has(dedupeKey)) return;
			flushedSessions.add(dedupeKey);
		}

		try {
			const result = runCollect(ctx);
			if (result.rows.length === 0) return;

			let sessionFile: string | undefined;
			try {
				sessionFile = ctx.sessionManager.getSessionFile();
			} catch {
				sessionFile = undefined;
			}

			appendSessionReport(defaultLogDir(getAgentDir(pi)), {
				ts: new Date().toISOString(),
				sessionId,
				sessionFile,
				cwd: ctx.cwd,
				reason,
				result,
			});
		} catch {
			// Never let a reporting failure affect session teardown.
		}
	}

	pi.on("turn_end", (_event, ctx) => {
		if (isSubagentSession(ctx)) return;
		try {
			const result = runCollect(ctx);
			ctx.ui.setStatus(WIDGET_KEY, formatStatusLine(result.rows, result.totals));
		} catch {
			// Status line is best-effort; never break a turn over it.
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		flushSessionReport(ctx, "shutdown");
	});

	pi.on("session_before_switch", (event, ctx) => {
		flushSessionReport(ctx, `switch:${event.reason}`);
	});

	pi.registerCommand("modellog", {
		description: "Show which model roles were used this session, in call order, with tokens/cost/time",
		handler: async (args, ctx) => {
			if (isSubagentSession(ctx)) {
				ctx.ui.notify("modellog: not available inside a sub-agent session", "warning");
				return;
			}

			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			let result: CollectResult;
			try {
				result = runCollect(ctx);
			} catch (err) {
				const message = `modellog: could not read session entries (${err instanceof Error ? err.message : String(err)})`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else console.log(message);
				return;
			}

			if (sub === "roles") {
				const line = formatHeadline(result.rows);
				if (ctx.hasUI) ctx.ui.notify(line, "info");
				else console.log(line);
				return;
			}

			if (sub === "json") {
				const text = formatJson(result);
				if (ctx.hasUI) {
					ctx.ui.setWidget(WIDGET_KEY, text.split("\n"), { placement: "aboveEditor" });
					ctx.setTimeout(() => ctx.ui.setWidget(WIDGET_KEY, undefined), WIDGET_TIMEOUT_MS);
				} else {
					console.log(text);
				}
				return;
			}

			const lines = formatTable(result);
			if (ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
				ctx.setTimeout(() => ctx.ui.setWidget(WIDGET_KEY, undefined), WIDGET_TIMEOUT_MS);
			} else {
				console.log(lines.join("\n"));
			}
		},
	});
}
