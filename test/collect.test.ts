import { describe, expect, test } from "bun:test";
import { collect } from "../src/collect";
import type { SessionEntryLike } from "../src/types";

function modelChange(model: string, role?: string, ts = "2026-01-01T00:00:00.000Z"): SessionEntryLike {
	return { type: "model_change", timestamp: ts, model, role };
}

function assistant(
	provider: string,
	model: string,
	overrides: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; duration: number; errorMessage: string }> = {},
	ts = "2026-01-01T00:00:01.000Z",
): SessionEntryLike {
	return {
		type: "message",
		timestamp: ts,
		message: {
			role: "assistant",
			provider,
			model,
			usage:
				overrides.errorMessage && overrides.input === undefined
					? undefined
					: {
							input: overrides.input ?? 100,
							output: overrides.output ?? 50,
							cacheRead: overrides.cacheRead ?? 0,
							cacheWrite: overrides.cacheWrite ?? 0,
							cost: { total: overrides.cost ?? 0.01 },
						},
			duration: overrides.duration,
			errorMessage: overrides.errorMessage,
		},
	};
}

function taskResult(details: unknown, ts = "2026-01-01T00:00:02.000Z"): SessionEntryLike {
	return {
		type: "message",
		timestamp: ts,
		message: { role: "toolResult", toolName: "task", details, isError: false },
	};
}

function modelUsage(purpose: string, role: string | undefined, provider: string, model: string, ts = "2026-01-01T00:00:00.500Z"): SessionEntryLike {
	return { type: "model_usage", timestamp: ts, purpose, role, provider, model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
}

function hubResult(details: unknown, ts = "2026-01-01T00:00:03.000Z"): SessionEntryLike {
	return {
		type: "message",
		timestamp: ts,
		message: { role: "toolResult", toolName: "hub", details, isError: false },
	};
}

describe("collect", () => {
	test("labels an assistant turn with the role from the preceding model_change", () => {
		const result = collect([modelChange("anthropic/claude-opus-5", "plan"), assistant("anthropic", "claude-opus-5")], undefined);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.role).toBe("plan");
		expect(result.rows[0]?.modelShort).toBe("claude-opus-5");
		expect(result.rows[0]?.calls).toBe(1);
		expect(result.rows[0]?.input).toBe(100);
		expect(result.rows[0]?.cost).toBeCloseTo(0.01);
	});

	test("an assistant message before any model_change still gets a row, defaulted to 'default'", () => {
		const result = collect([assistant("relay", "vCode")], undefined);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.role).toBe("default");
	});

	test("preserves first-called order across role switches, not alphabetical or by volume", () => {
		const result = collect(
			[
				modelChange("openai-codex/gpt-5.6-luna", "default"),
				assistant("openai-codex", "gpt-5.6-luna"),
				modelChange("anthropic/claude-opus-5", "plan"),
				assistant("anthropic", "claude-opus-5"),
				modelChange("openai-codex/gpt-5.6-luna", "default"),
				assistant("openai-codex", "gpt-5.6-luna"), // second call to a role seen before: no new row, no reorder
			],
			undefined,
		);

		expect(result.rows.map((r) => r.role)).toEqual(["default", "plan"]);
		expect(result.rows[0]?.calls).toBe(2);
	});

	test("aggregates tokens and cost across multiple calls to the same role/model", () => {
		const result = collect(
			[modelChange("relay/vCode", "task"), assistant("relay", "vCode", { input: 200, output: 40, cost: 0.02 }), assistant("relay", "vCode", { input: 300, output: 60, cost: 0.03 })],
			undefined,
		);
		expect(result.rows[0]?.calls).toBe(2);
		expect(result.rows[0]?.input).toBe(500);
		expect(result.rows[0]?.output).toBe(100);
		expect(result.rows[0]?.cost).toBeCloseTo(0.05);
	});

	test("a message with no usage at all does not throw and contributes zero tokens", () => {
		const result = collect([modelChange("relay/vCode"), assistant("relay", "vCode", { errorMessage: "boom", input: undefined as unknown as number })], undefined);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.errors).toBe(1);
		expect(result.rows[0]?.input).toBe(0);
	});

	test("model_usage entries surface as an 'aux' row labeled by role or purpose", () => {
		const result = collect([modelUsage("auto-thinking", "tiny", "relay", "vCode"), modelUsage("auto-thinking", undefined, "relay", "vCode")], undefined);
		expect(result.rows.some((r) => r.role === "tiny" && r.origin === "aux")).toBe(true);
		expect(result.rows.some((r) => r.role === "auto-thinking" && r.origin === "aux")).toBe(true);
	});

	test("a completed task-tool subagent contributes a subagent row labeled by modelRole", () => {
		const details = {
			results: [
				{
					id: "a1",
					agent: "sonic",
					modelRole: "task",
					resolvedModelIdentity: "relay/vCode",
					requests: 3,
					durationMs: 12_000,
					usage: { input: 900, output: 300, cacheRead: 200, cacheWrite: 0, cost: { total: 0.04 } },
				},
			],
		};
		const result = collect([taskResult(details)], undefined);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({ role: "task", modelShort: "vCode", origin: "subagent", calls: 3, input: 900, output: 300, cost: 0.04 });
	});

	test("an async task with only progress[] (no results yet) still contributes an approximate row", () => {
		const details = {
			progress: [{ id: "b1", agent: "scout", status: "running", modelRole: "smol", resolvedModelIdentity: "relay/vCode", tokens: 1200, cost: 0.01, durationMs: 4000 }],
		};
		const result = collect([taskResult(details)], undefined);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.role).toBe("smol");
		expect(result.rows[0]?.approxTokens).toBe(1200);
		expect(result.rows[0]?.cost).toBeCloseTo(0.01);
	});

	test("progress entries already represented in results are not double-counted", () => {
		const details = {
			results: [{ id: "c1", agent: "scout", modelRole: "smol", resolvedModelIdentity: "relay/vCode", requests: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }],
			progress: [{ id: "c1", agent: "scout", status: "completed", modelRole: "smol", resolvedModelIdentity: "relay/vCode", tokens: 15, cost: 0 }],
		};
		const result = collect([taskResult(details)], undefined);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.calls).toBe(1);
	});

	test("an async task (pending progress, then resolved later via a hub result) reconciles into one row", () => {
		// Reproduces the real sequence observed against a live omp session: the
		// `task` toolResult is a "pending" placeholder with no resolved model,
		// and the actual model/duration/status arrive later via a `hub` result
		// keyed by the same job id.
		const pending = taskResult({
			results: [],
			progress: [{ id: "EchoHello", agent: "sonic", modelRole: "smol", status: "pending", tokens: 0, cost: 0, durationMs: 0 }],
		});
		const hubWait = hubResult({
			jobs: [{ id: "EchoHello", status: "completed", durationMs: 13_660, resolvedModel: "relay/vCode:xhigh", resolvedModelIdentity: "relay/vCode" }],
		});

		const result = collect([pending, hubWait], undefined);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({ role: "smol", modelShort: "vCode", origin: "subagent", calls: 1, durationMs: 13_660 });
	});

	test("a repeated hub snapshot of an already-completed job is not double-counted", () => {
		const pending = taskResult({ progress: [{ id: "j1", agent: "scout", modelRole: "task", status: "pending" }] });
		const firstWait = hubResult({ jobs: [{ id: "j1", status: "completed", durationMs: 5000, resolvedModelIdentity: "relay/vCode" }] });
		const secondWait = hubResult({ jobs: [{ id: "j1", status: "completed", durationMs: 5000, resolvedModelIdentity: "relay/vCode" }] });

		const result = collect([pending, firstWait, secondWait], undefined);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.calls).toBe(1);
		expect(result.rows[0]?.durationMs).toBe(5000);
	});

	test("a hub completion with no prior task progress sighting still creates a row", () => {
		const hubOnly = hubResult({ jobs: [{ id: "solo", status: "completed", durationMs: 2000, resolvedModelIdentity: "anthropic/claude-haiku-4-5" }] });
		const result = collect([hubOnly], undefined);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({ role: "task", modelShort: "claude-haiku-4-5", origin: "subagent" });
	});

	test("a toolResult from a non-task tool, or malformed details, is ignored without throwing", () => {
		const result = collect(
			[
				{ type: "message", timestamp: "t", message: { role: "toolResult", toolName: "bash", details: { stdout: "hi" }, isError: false } },
				{ type: "message", timestamp: "t", message: { role: "toolResult", toolName: "task", details: "not-an-object", isError: false } },
				{ type: "message", timestamp: "t", message: { role: "toolResult", toolName: "task", details: null, isError: false } },
			],
			undefined,
		);
		expect(result.rows).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	test("an entry that throws mid-parse is recorded as a warning and does not abort the pass", () => {
		const poison: SessionEntryLike = {
			type: "message",
			timestamp: "t",
			get message(): never {
				throw new Error("poisoned getter");
			},
		} as unknown as SessionEntryLike;

		const result = collect([modelChange("relay/vCode", "plan"), poison, assistant("relay", "vCode")], undefined);
		expect(result.warnings.length).toBe(1);
		expect(result.rows).toHaveLength(1); // the assistant call after the poisoned entry still lands
	});

	test("empty input produces an empty, well-formed result", () => {
		const result = collect([], undefined);
		expect(result.rows).toEqual([]);
		expect(result.totals.calls).toBe(0);
	});
});
