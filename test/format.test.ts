import { describe, expect, test } from "bun:test";
import { collect } from "../src/collect";
import { formatHeadline, formatJson, formatTable, humanCost, humanDuration, humanTokens } from "../src/format";
import type { SessionEntryLike } from "../src/types";

describe("formatHeadline", () => {
	test("matches the requested 'role -> model' shape, in call order", () => {
		const entries: SessionEntryLike[] = [
			{ type: "model_change", timestamp: "t0", model: "anthropic/claude-opus-5", role: "plan" },
			{ type: "message", timestamp: "t1", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
			{ type: "model_change", timestamp: "t2", model: "relay/vCode", role: "task" },
			{ type: "message", timestamp: "t3", message: { role: "assistant", provider: "relay", model: "vCode", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
		];
		const result = collect(entries, undefined);
		expect(formatHeadline(result.rows)).toBe("Models used: plan -> claude-opus-5, task -> vCode");
	});

	test("marks inferred roles with a trailing asterisk", () => {
		const resolver = { resolve: (spec: string) => (spec === "@plan" ? { provider: "a", id: "m" } : undefined) };
		const entries: SessionEntryLike[] = [
			{ type: "model_change", timestamp: "t0", model: "a/m", role: "temporary" },
			{ type: "message", timestamp: "t1", message: { role: "assistant", provider: "a", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
		];
		const result = collect(entries, resolver);
		expect(formatHeadline(result.rows)).toBe("Models used: plan -> m*");
	});

	test("empty session says so instead of an empty string", () => {
		expect(formatHeadline([])).toBe("Models used: (none yet)");
	});
});

describe("human formatters", () => {
	test("humanTokens", () => {
		expect(humanTokens(0)).toBe("0");
		expect(humanTokens(999)).toBe("999");
		expect(humanTokens(1500)).toBe("1.5k");
		expect(humanTokens(25_000)).toBe("25k");
		expect(humanTokens(2_500_000)).toBe("2.5m");
	});

	test("humanCost shows extra precision for sub-cent amounts", () => {
		expect(humanCost(0)).toBe("$0");
		expect(humanCost(0.0038)).toBe("$0.0038");
		expect(humanCost(1.2)).toBe("$1.20");
	});

	test("humanDuration scales units", () => {
		expect(humanDuration(0)).toBe("0s");
		expect(humanDuration(1500)).toBe("1.5s");
		expect(humanDuration(65_000)).toBe("1m05s");
		expect(humanDuration(3_661_000)).toBe("1h01m");
	});
});

describe("formatTable / formatJson", () => {
	test("formatTable never throws on an empty result and says so", () => {
		const lines = formatTable({ rows: [], totals: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, approxTokens: 0, cost: 0, durationMs: 0 }, warnings: [] });
		expect(lines.join("\n")).toContain("no model activity");
	});

	test("formatJson round-trips the headline and totals", () => {
		const entries: SessionEntryLike[] = [
			{ type: "model_change", timestamp: "t0", model: "relay/vCode", role: "default" },
			{ type: "message", timestamp: "t1", message: { role: "assistant", provider: "relay", model: "vCode", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
		];
		const result = collect(entries, undefined);
		const parsed = JSON.parse(formatJson(result));
		expect(parsed.headline).toBe(formatHeadline(result.rows));
		expect(parsed.totals.input).toBe(10);
	});
});
