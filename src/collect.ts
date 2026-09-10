import { labelForModelChange, type ModelResolver } from "./roles";
import {
	isAssistantMessage,
	isAsyncResultDetails,
	isCustomMessageEntry,
	isHubToolDetails,
	isMessageEntry,
	isModelChangeEntry,
	isModelUsageEntry,
	isTaskToolDetails,
	isToolResultMessage,
	type AgentProgressLike,
	type AsyncResultJobLike,
	type CollectResult,
	type HubJobLike,
	type RoleUsage,
	type SessionEntryLike,
	type SingleResultLike,
} from "./types";

/** A subagent's own real per-turn usage, read from its own session file. See subagent-usage.ts. */
export type SubagentUsageReader = (jobId: string) => { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; calls: number } | undefined;

/** Per-collect() state for reconciling async subagent jobs across `task` and `hub` tool results. */
interface SubagentTracker {
	rows: Map<string, RoleUsage>;
	/** job id -> its row, so a later `hub` completion can update the row a `task` pending entry already created. */
	rowById: Map<string, RoleUsage>;
	/** job ids whose numbers have been folded in exactly once — guards every settlement path against double-counting a repeated snapshot of the same job. */
	settledIds: Set<string>;
	getSubagentUsage: SubagentUsageReader | undefined;
}

function emptyRow(role: string, modelKey: string, modelShort: string, inferred: boolean, origin: RoleUsage["origin"], originDetail?: string): RoleUsage {
	return {
		role,
		modelKey,
		modelShort,
		inferred,
		origin,
		originDetail,
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		approxTokens: 0,
		cost: 0,
		durationMs: 0,
		durationSamples: 0,
		errors: 0,
	};
}

function rowFor(rows: Map<string, RoleUsage>, role: string, modelKey: string, origin: RoleUsage["origin"], inferred: boolean, originDetail?: string): RoleUsage {
	const key = `${role} ${modelKey} ${origin}`;
	let row = rows.get(key);
	if (!row) {
		const modelShort = modelKey.includes("/") ? (modelKey.split("/").pop() ?? modelKey) : modelKey;
		row = emptyRow(role, modelKey, modelShort, inferred, origin, originDetail);
		rows.set(key, row);
	}
	return row;
}

function addUsage(row: RoleUsage, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined) {
	if (!usage) return;
	row.input += usage.input ?? 0;
	row.output += usage.output ?? 0;
	row.cacheRead += usage.cacheRead ?? 0;
	row.cacheWrite += usage.cacheWrite ?? 0;
	row.cost += usage.cost?.total ?? 0;
}

/**
 * Single chronological pass over session entries. Map insertion order is
 * relied on to reproduce "first called" order for the headline — never sort
 * rows for display, only for secondary presentation (e.g. a totals footer).
 */
export function collect(entries: SessionEntryLike[], resolver: ModelResolver | undefined, getSubagentUsage?: SubagentUsageReader): CollectResult {
	const rows = new Map<string, RoleUsage>();
	const warnings: string[] = [];
	const subagents: SubagentTracker = { rows, rowById: new Map(), settledIds: new Set(), getSubagentUsage };

	let currentRole = "default";
	let currentModelKey: string | undefined;
	let currentInferred = false;

	let sessionStart: string | undefined;
	let sessionEnd: string | undefined;

	for (const entry of entries) {
		if (!sessionStart) sessionStart = entry.timestamp;
		sessionEnd = entry.timestamp;

		try {
			if (isModelChangeEntry(entry)) {
				const label = labelForModelChange({ role: entry.role, model: entry.model }, resolver);
				currentRole = label.role;
				currentInferred = label.inferred;
				currentModelKey = entry.model;
				continue;
			}

			if (isModelUsageEntry(entry)) {
				const modelKey = entry.provider && entry.model ? `${entry.provider}/${entry.model}` : (entry.model ?? "unknown");
				const role = entry.role ?? entry.purpose ?? "aux";
				const row = rowFor(rows, role, modelKey, "aux", entry.role === undefined, entry.purpose);
				row.calls += 1;
				addUsage(row, entry.usage);
				if (entry.errorMessage) row.errors += 1;
				continue;
			}

			if (isCustomMessageEntry(entry)) {
				if (entry.customType === "async-result" && isAsyncResultDetails(entry.details)) {
					for (const job of entry.details.jobs ?? []) reconcileAsyncResult(subagents, job, entry.content);
				}
				continue;
			}

			if (isMessageEntry(entry)) {
				const message = entry.message;

				if (isAssistantMessage(message)) {
					const modelKey = message.provider && message.model ? `${message.provider}/${message.model}` : (message.model ?? currentModelKey ?? "unknown");
					const row = rowFor(rows, currentRole, modelKey, "main", currentInferred);
					row.calls += 1;
					addUsage(row, message.usage);
					if (typeof message.duration === "number") {
						row.durationMs += message.duration;
						row.durationSamples += 1;
					}
					if (message.errorMessage) row.errors += 1;
					continue;
				}

				if (isToolResultMessage(message)) {
					if (message.toolName === "task" && isTaskToolDetails(message.details)) {
						const details = message.details;
						for (const r of details.results ?? []) addSubagentResult(subagents, r);
						for (const p of details.progress ?? []) addSubagentProgress(subagents, p);
						continue;
					}

					// This build's `task` tool spawns async by default: completion (resolved
					// model, duration, status) is reported later via a `hub` tool result keyed
					// by the same job id as the pending `task` progress entry — see types.ts.
					if (message.toolName === "hub" && isHubToolDetails(message.details)) {
						for (const job of message.details.jobs ?? []) reconcileHubJob(subagents, job);
						continue;
					}
				}
			}
		} catch (err) {
			warnings.push(`modellog: skipped an entry it could not parse (${entry.type}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, approxTokens: 0, cost: 0, durationMs: 0 };
	for (const row of rows.values()) {
		totals.calls += row.calls;
		totals.input += row.input;
		totals.output += row.output;
		totals.cacheRead += row.cacheRead;
		totals.cacheWrite += row.cacheWrite;
		totals.approxTokens += row.approxTokens;
		totals.cost += row.cost;
		totals.durationMs += row.durationMs;
	}

	return { rows: [...rows.values()], totals, sessionStart, sessionEnd, warnings };
}

/**
 * Find or create the row for a subagent job id. If a placeholder row already
 * exists for this id (created by an earlier pending `task` progress entry),
 * reuse it — and upgrade its model key / label in place — instead of
 * creating a second, disconnected row for the same job.
 */
function upsertSubagentRow(t: SubagentTracker, id: string | undefined, role: string, modelKey: string, originDetail: string | undefined): RoleUsage {
	const existing = id ? t.rowById.get(id) : undefined;
	if (existing) {
		if (existing.modelKey === "unknown" && modelKey !== "unknown") {
			existing.modelKey = modelKey;
			existing.modelShort = modelKey.includes("/") ? (modelKey.split("/").pop() ?? modelKey) : modelKey;
		}
		// Later sightings (e.g. a hub completion) are more authoritative than the
		// pending placeholder that first created this row — keep the label fresh.
		if (originDetail) existing.originDetail = originDetail;
		return existing;
	}
	const row = rowFor(t.rows, role, modelKey, "subagent", false, originDetail);
	if (id) t.rowById.set(id, row);
	return row;
}

interface SettleData {
	calls?: number;
	/** Authoritative per-turn usage (own session file, or a populated `results[]` entry). Preferred over fallback numbers. */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** Used only when `usage` is unavailable — a flat, unsplit token/cost count reported alongside the job itself. */
	fallbackTokens?: number;
	fallbackCost?: number;
	durationMs?: number;
	errored?: boolean;
}

/**
 * Folds a job's final numbers into its row exactly once, no matter how many
 * times (task result, task progress, repeated hub polls) that job's
 * settlement is observed — `settledIds` makes every path but the first a
 * no-op. This is the only place row.calls/usage/durationMs/errors are
 * written for a subagent, which is what makes the double-counting question
 * tractable: nothing here is ever additive across multiple sightings of the
 * same id, only across *different* ids sharing a row.
 */
function settleSubagent(t: SubagentTracker, id: string | undefined, row: RoleUsage, data: SettleData) {
	if (id) {
		if (t.settledIds.has(id)) return;
		t.settledIds.add(id);
	}

	row.calls += data.calls ?? 1;
	if (data.usage) {
		row.input += data.usage.input;
		row.output += data.usage.output;
		row.cacheRead += data.usage.cacheRead;
		row.cacheWrite += data.usage.cacheWrite;
		row.cost += data.usage.cost;
	} else {
		if (typeof data.fallbackTokens === "number") row.approxTokens += data.fallbackTokens;
		if (typeof data.fallbackCost === "number") row.cost += data.fallbackCost;
	}
	if (typeof data.durationMs === "number") {
		row.durationMs += data.durationMs;
		row.durationSamples += 1;
	}
	if (data.errored) row.errors += 1;
}

/**
 * A subagent's own session file (when readable) is authoritative over
 * anything the parent's tool-result payload reports — see subagent-usage.ts
 * for why the parent-side numbers are frequently just absent.
 */
function realUsageFor(t: SubagentTracker, id: string | undefined): ReturnType<SubagentUsageReader> {
	if (!id || !t.getSubagentUsage) return undefined;
	try {
		return t.getSubagentUsage(id);
	} catch {
		return undefined;
	}
}

/** A completed (or failed/aborted) single-agent result — from a synchronous `task` result. */
function addSubagentResult(t: SubagentTracker, r: SingleResultLike) {
	const role = r.modelRole ?? "task";
	const modelKey = r.resolvedModelIdentity ?? r.resolvedModel ?? "unknown";
	const row = upsertSubagentRow(t, r.id, role, modelKey, r.agent);

	const real = realUsageFor(t, r.id);
	const usage = real ?? (r.usage ? { input: r.usage.input ?? 0, output: r.usage.output ?? 0, cacheRead: r.usage.cacheRead ?? 0, cacheWrite: r.usage.cacheWrite ?? 0, cost: r.usage.cost?.total ?? 0 } : undefined);

	settleSubagent(t, r.id, row, {
		calls: real?.calls ?? r.requests ?? 1,
		usage,
		fallbackTokens: usage ? undefined : r.tokens,
		durationMs: r.durationMs,
		errored: !!(r.error || r.aborted),
	});
}

/**
 * `completed`/`failed`/`aborted` are the terminal statuses documented by the
 * hub tool itself; `cancelled` (an explicit `hub cancel`, or a stalled job
 * killed by the orchestrator) is just as final but easy to miss since it
 * isn't mentioned alongside the other three anywhere — confirmed empirically
 * against a live session where a cancelled multi-launch pm-worker job ran
 * for real (tens of minutes, real tokens) before being killed, and without
 * this would settle as nothing at all, forever.
 */
function isTerminalStatus(status: string | undefined): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "cancelled";
}

function isNonSuccessStatus(status: string | undefined): boolean {
	return status === "failed" || status === "aborted" || status === "cancelled";
}

/**
 * A `task` progress snapshot (from `details.progress[]`). A non-terminal
 * status only creates/updates the placeholder row (model key, label) — it is
 * never settled, since its counters are all-zero anyway (verified
 * empirically) and would just have to be un-done once the real numbers
 * arrive. A terminal status settles it directly, for the rarer case where a
 * `task` result reports completion without ever needing a `hub` round-trip.
 */
function addSubagentProgress(t: SubagentTracker, p: AgentProgressLike) {
	const role = p.modelRole ?? "task";
	const modelKey = p.resolvedModelIdentity ?? p.resolvedModel ?? "unknown";
	const originDetail = p.agent ? `${p.agent} (${p.status ?? "running"})` : p.status;
	const row = upsertSubagentRow(t, p.id, role, modelKey, originDetail);

	if (!isTerminalStatus(p.status)) return;

	const real = realUsageFor(t, p.id);
	settleSubagent(t, p.id, row, {
		calls: real?.calls,
		usage: real,
		fallbackTokens: real ? undefined : p.tokens,
		fallbackCost: real ? undefined : p.cost,
		durationMs: p.durationMs,
		errored: isNonSuccessStatus(p.status),
	});
}

/**
 * A `hub jobs`/`hub wait` snapshot. Reconciles against the row a pending
 * `task` progress entry already created for this job id (the common async
 * case), or creates one if `hub` is the first sighting of this job at all.
 * A non-terminal status still updates the row's resolved model in place
 * (upsertSubagentRow) but settles nothing yet.
 */
function reconcileHubJob(t: SubagentTracker, job: HubJobLike) {
	if (!job.id) return;

	// Preserve the agent name a `task` progress placeholder already recorded
	// ("sonic (pending)" -> "sonic (completed)"); hub itself reports no agent name.
	const existing = t.rowById.get(job.id);
	const agentPrefix = existing?.originDetail?.split(" (")[0];
	const label = agentPrefix ? `${agentPrefix} (${job.status ?? "settled"})` : job.status;

	const modelKey = job.resolvedModelIdentity ?? job.resolvedModel ?? "unknown";
	const row = upsertSubagentRow(t, job.id, "task", modelKey, label);

	if (!isTerminalStatus(job.status)) return;

	const real = realUsageFor(t, job.id);
	settleSubagent(t, job.id, row, {
		calls: real?.calls,
		usage: real,
		durationMs: job.durationMs,
		errored: isNonSuccessStatus(job.status),
	});
}

/**
 * An `async-result` custom_message — a subagent's result delivered directly
 * because nothing consumed it via a `hub` snapshot first (see
 * CustomMessageEntryLike). This shape carries no role, model, or status of
 * its own: role/model come from whatever row an earlier `task`/`hub`
 * sighting already created for this job id (falling back to "task"/"unknown"
 * for the rare case of an id never seen before), and status is scraped
 * best-effort from the `<task-result ... status="X">` tag in the free-text
 * `content` (defaulting to "completed", since that's the only status this
 * delivery path is documented to fire for).
 */
function reconcileAsyncResult(t: SubagentTracker, job: AsyncResultJobLike, content: unknown) {
	const id = job.jobId ?? job.id;
	if (!id) return;

	const existing = t.rowById.get(id);
	const role = existing?.role ?? "task";
	const modelKey = existing?.modelKey ?? "unknown";
	const status = statusFromTaskResultTag(content) ?? "completed";
	const agentPrefix = existing?.originDetail?.split(" (")[0];
	const originDetail = agentPrefix ? `${agentPrefix} (${status})` : status;
	const row = upsertSubagentRow(t, id, role, modelKey, originDetail);

	const real = realUsageFor(t, id);
	settleSubagent(t, id, row, {
		calls: real?.calls,
		usage: real,
		durationMs: job.durationMs,
		errored: isNonSuccessStatus(status),
	});
}

/** Best-effort scrape of `status="..."` from a `<task-result ... status="X">` tag. Never throws; undefined on anything but a matching plain string. */
function statusFromTaskResultTag(content: unknown): string | undefined {
	if (typeof content !== "string") return undefined;
	return content.match(/<task-result\b[^>]*\bstatus="([a-z]+)"/)?.[1];
}
