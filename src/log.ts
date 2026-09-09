import * as fs from "node:fs";
import * as path from "node:path";
import { formatHeadline, humanCost, humanDuration } from "./format";
import type { CollectResult } from "./types";

export interface SessionReportRecord {
	ts: string;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	reason: string;
	result: CollectResult;
}

/**
 * Synchronous, best-effort append. Called from session_shutdown /
 * session_before_switch, which get a hard ~2s budget and cannot reliably
 * paint TUI output by the time they fire — writing a file is the only
 * dependable channel at that point. Never throws.
 */
export function appendSessionReport(dir: string, record: SessionReportRecord): boolean {
	try {
		fs.mkdirSync(dir, { recursive: true });

		const jsonlPath = path.join(dir, "sessions.jsonl");
		fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");

		const headline = formatHeadline(record.result.rows);
		const t = record.result.totals;
		const summary = `${t.calls} call${t.calls === 1 ? "" : "s"} ${humanCost(t.cost)} ${humanDuration(t.durationMs)}`;
		const line = `${record.ts}  ${record.cwd ?? "?"}  [${record.reason}]  ${headline}  | ${summary}\n`;
		fs.appendFileSync(path.join(dir, "sessions.log"), line, "utf8");

		return true;
	} catch {
		return false;
	}
}

export function defaultLogDir(agentDir: string | undefined): string {
	if (process.env.OMP_MODELLOG_DIR) return process.env.OMP_MODELLOG_DIR;
	if (agentDir) return path.join(agentDir, "modellog");
	return path.join(process.env.HOME ?? ".", ".omp", "agent", "modellog");
}
