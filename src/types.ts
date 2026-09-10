/**
 * Local structural types mirroring the slice of omp's session-entry and
 * task-tool shapes this extension reads. Declared locally (not imported at
 * runtime) so the extension has zero runtime dependency on omp's package —
 * every field is optionally-chained at the read site regardless, since these
 * are internal-ish shapes that can drift between omp versions.
 */

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface AssistantMessageLike {
	role: "assistant";
	provider?: string;
	model?: string;
	usage?: Usage;
	errorMessage?: string;
	timestamp?: number;
	duration?: number;
}

export interface ToolResultMessageLike {
	role: "toolResult";
	toolName?: string;
	details?: unknown;
	isError?: boolean;
}

export interface ModelChangeEntryLike {
	type: "model_change";
	timestamp: string;
	model?: string;
	role?: string;
	resolvedModelIsFallback?: boolean;
}

export interface ModelUsageEntryLike {
	type: "model_usage";
	timestamp: string;
	purpose?: string;
	role?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
	errorMessage?: string;
}

export interface MessageEntryLike {
	type: "message";
	timestamp: string;
	message: unknown;
}

export interface OtherEntryLike {
	type: string;
	timestamp: string;
}

/**
 * A subagent's result "auto-delivers" this way whenever the orchestrator
 * doesn't happen to consume it via an explicit `hub jobs`/`wait` snapshot
 * first — this build's default completion path for a background job, per
 * its own tool text ("result auto-delivers on yield unless a settled `hub
 * jobs`/`wait` snapshot consumes it first"). Confirmed empirically: a fully
 * completed subagent that is never polled via `hub` after it finishes shows
 * up ONLY as one of these, never as a `hub`-reported "completed" status —
 * so a reader that only watches `task`/`hub` toolResult entries (see
 * collect.ts) silently drops its cost/tokens entirely.
 */
export interface CustomMessageEntryLike {
	type: "custom_message";
	timestamp: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
}

export function isCustomMessageEntry(e: SessionEntryLike): e is CustomMessageEntryLike {
	return e.type === "custom_message";
}

/**
 * Deliberately NOT a single discriminated union with a catch-all `{type:
 * string}` member — a catch-all whose discriminant is the bare `string` type
 * is never excluded by an `entry.type === "literal"` check (every literal is
 * assignable to `string`), so it survives every narrowing branch and turns
 * property access back into `unknown`. Keep the specific shapes separate and
 * narrow with plain `if (entry.type === "...")` type assertions instead.
 */
export type SessionEntryLike = ModelChangeEntryLike | ModelUsageEntryLike | MessageEntryLike | CustomMessageEntryLike | OtherEntryLike;

/**
 * The `details` payload of an `async-result` custom_message. Unlike
 * `HubJobLike`/`AgentProgressLike`, this shape carries no role, resolved
 * model, or usage of its own — only enough to identify the job and its
 * elapsed time. Settling it therefore depends entirely on a row an earlier
 * `task`/`hub` sighting already created (for role/model) and on the
 * subagent's own session file (for usage) — see collect.ts.
 */
export interface AsyncResultJobLike {
	jobId?: string;
	id?: string;
	durationMs?: number;
}

export interface AsyncResultDetailsLike {
	jobs?: AsyncResultJobLike[];
}

export function isAsyncResultDetails(x: unknown): x is AsyncResultDetailsLike {
	if (!x || typeof x !== "object") return false;
	const jobs = (x as Record<string, unknown>).jobs;
	return jobs === undefined || Array.isArray(jobs);
}

export function isModelChangeEntry(e: SessionEntryLike): e is ModelChangeEntryLike {
	return e.type === "model_change";
}

export function isModelUsageEntry(e: SessionEntryLike): e is ModelUsageEntryLike {
	return e.type === "model_usage";
}

export function isMessageEntry(e: SessionEntryLike): e is MessageEntryLike {
	return e.type === "message";
}

export function isAssistantMessage(m: unknown): m is AssistantMessageLike {
	return !!m && typeof m === "object" && (m as { role?: unknown }).role === "assistant";
}

export function isToolResultMessage(m: unknown): m is ToolResultMessageLike {
	return !!m && typeof m === "object" && (m as { role?: unknown }).role === "toolResult";
}

export interface SingleResultLike {
	id?: string;
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	durationMs?: number;
	requests?: number;
	tokens?: number;
	usage?: Usage;
	error?: string;
	aborted?: boolean;
}

export interface AgentProgressLike {
	id?: string;
	agent?: string;
	status?: string;
	modelRole?: string;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	durationMs?: number;
	tokens?: number;
	cost?: number;
}

export interface TaskToolDetailsLike {
	results?: SingleResultLike[];
	progress?: AgentProgressLike[];
}

/**
 * This build's `task` tool spawns async by default: the toolResult recorded
 * at call time carries an empty `results: []` and a `progress: [{status:
 * "pending", ...}]` placeholder with no resolved model yet. The actual
 * completion (resolved model, duration, status) arrives later through a
 * separate `hub` tool result (`op: "wait"` or `op: "jobs"`), keyed by the
 * same job id as the pending progress entry — not through a second `task`
 * result. Confirmed empirically against a live session; not documented in
 * upstream pi-coding-agent's extensions/session-format docs.
 */
export interface HubJobLike {
	id?: string;
	status?: string;
	durationMs?: number;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
}

export interface HubToolDetailsLike {
	jobs?: HubJobLike[];
}

export function isHubToolDetails(x: unknown): x is HubToolDetailsLike {
	if (!x || typeof x !== "object") return false;
	const jobs = (x as Record<string, unknown>).jobs;
	return jobs === undefined || Array.isArray(jobs);
}

/** Row aggregated per (role, model) pair. Map iteration order == first-called order. */
export interface RoleUsage {
	role: string;
	modelKey: string;
	modelShort: string;
	inferred: boolean;
	origin: "main" | "subagent" | "aux";
	originDetail?: string; // e.g. task agent name, or model_usage purpose
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	approxTokens: number; // tokens known only as a flat count (no in/out split), e.g. in-flight subagents
	cost: number;
	durationMs: number;
	durationSamples: number;
	errors: number;
}

export interface CollectResult {
	rows: RoleUsage[]; // first-called order
	totals: {
		calls: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		approxTokens: number;
		cost: number;
		durationMs: number;
	};
	sessionStart?: string;
	sessionEnd?: string;
	warnings: string[];
}

export function isTaskToolDetails(x: unknown): x is TaskToolDetailsLike {
	if (!x || typeof x !== "object") return false;
	const d = x as Record<string, unknown>;
	return (d.results === undefined || Array.isArray(d.results)) && (d.progress === undefined || Array.isArray(d.progress));
}
