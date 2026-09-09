import * as fs from "node:fs";
import * as path from "node:path";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	calls: number;
}

/**
 * A subagent's own turns are never aggregated into the parent's `task`/`hub`
 * tool-result payloads in this build (confirmed empirically: a fully
 * completed multi-turn subagent's `hub` completion carries only
 * duration/model/status, no usage at all — see README). But each subagent
 * runs as its own nested session, written to
 * `<parent session dir>/<jobId>.jsonl`, with full per-turn usage/cost just
 * like the parent session. That file is the authoritative source for a
 * subagent's real tokens/cost.
 */
export function resolveSubagentSessionFile(parentSessionFile: string, jobId: string): string | undefined {
	// jobId ultimately traces back to a task/agent name the model chose; treat
	// it as untrusted and refuse anything that isn't a plain filename segment.
	if (!/^[A-Za-z0-9._-]+$/.test(jobId) || jobId === "." || jobId === "..") return undefined;

	const dir = parentSessionFile.endsWith(".jsonl") ? parentSessionFile.slice(0, -".jsonl".length) : parentSessionFile;
	return path.join(dir, `${jobId}.jsonl`);
}

/** Pure: sums assistant-turn usage out of raw subagent-session JSONL text. Never throws. */
export function parseSubagentUsage(text: string): SubagentUsage | undefined {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let calls = 0;

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "message") continue;
		const message = e.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		const usage = message.usage as Record<string, unknown> | undefined;
		if (!usage) continue;

		calls += 1;
		input += typeof usage.input === "number" ? usage.input : 0;
		output += typeof usage.output === "number" ? usage.output : 0;
		cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
		const costObj = usage.cost as Record<string, unknown> | undefined;
		cost += costObj && typeof costObj.total === "number" ? costObj.total : 0;
	}

	return calls > 0 ? { input, output, cacheRead, cacheWrite, cost, calls } : undefined;
}

/** Reads and sums a subagent's own session file. Returns undefined on any failure (missing file, bad JSON, etc.) — never throws. */
export function readSubagentUsage(parentSessionFile: string | undefined, jobId: string | undefined): SubagentUsage | undefined {
	if (!parentSessionFile || !jobId) return undefined;
	const file = resolveSubagentSessionFile(parentSessionFile, jobId);
	if (!file) return undefined;
	try {
		return parseSubagentUsage(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
