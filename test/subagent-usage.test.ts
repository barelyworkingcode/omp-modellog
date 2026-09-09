import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSubagentUsage, readSubagentUsage, resolveSubagentSessionFile } from "../src/subagent-usage";

describe("resolveSubagentSessionFile", () => {
	test("sits next to the parent session, in a directory named after it minus .jsonl", () => {
		const parent = "/Users/x/.omp/agent/sessions/-source-oneshot/2026-09-09T17-02-55-065Z_01a0871f.jsonl";
		expect(resolveSubagentSessionFile(parent, "PlanBigfootSvg")).toBe("/Users/x/.omp/agent/sessions/-source-oneshot/2026-09-09T17-02-55-065Z_01a0871f/PlanBigfootSvg.jsonl");
	});

	test("refuses a job id containing a path separator or traversal", () => {
		const parent = "/x/session.jsonl";
		expect(resolveSubagentSessionFile(parent, "../../etc/passwd")).toBeUndefined();
		expect(resolveSubagentSessionFile(parent, "a/b")).toBeUndefined();
		expect(resolveSubagentSessionFile(parent, "..")).toBeUndefined();
	});

	test("allows the plain filename-safe characters real job ids use", () => {
		const parent = "/x/session.jsonl";
		expect(resolveSubagentSessionFile(parent, "Implement_W1-final.v2")).toBe("/x/session/Implement_W1-final.v2.jsonl");
	});
});

describe("parseSubagentUsage", () => {
	test("sums usage across every assistant message, ignoring everything else", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 50, output: 10, cacheRead: 200, cacheWrite: 0, cost: { total: 0.005 } } } }),
			JSON.stringify({ type: "model_change", model: "a/b" }),
		].join("\n");

		expect(parseSubagentUsage(lines)).toEqual({ input: 150, output: 30, cacheRead: 200, cacheWrite: 0, cost: 0.015, calls: 2 });
	});

	test("returns undefined when there are no assistant messages at all", () => {
		expect(parseSubagentUsage(JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }))).toBeUndefined();
		expect(parseSubagentUsage("")).toBeUndefined();
	});

	test("skips malformed lines instead of throwing", () => {
		const lines = ["not json at all", JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 5, output: 1, cost: { total: 0 } } } }), "", "  "].join("\n");
		expect(parseSubagentUsage(lines)).toEqual({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 1 });
	});

	test("an assistant message with no usage field contributes zero, not a crash", () => {
		const lines = JSON.stringify({ type: "message", message: { role: "assistant" } });
		expect(parseSubagentUsage(lines)).toBeUndefined();
	});
});

describe("readSubagentUsage", () => {
	test("reads a real file end to end", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modellog-test-"));
		const parentFile = path.join(dir, "parent.jsonl");
		const childDir = path.join(dir, "parent");
		fs.mkdirSync(childDir);
		fs.writeFileSync(path.join(childDir, "Job1.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } } })}\n`);

		expect(readSubagentUsage(parentFile, "Job1")).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.002, calls: 1 });

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a missing file returns undefined, not a throw", () => {
		expect(readSubagentUsage("/nonexistent/parent.jsonl", "Job1")).toBeUndefined();
	});

	test("missing arguments return undefined", () => {
		expect(readSubagentUsage(undefined, "Job1")).toBeUndefined();
		expect(readSubagentUsage("/x/session.jsonl", undefined)).toBeUndefined();
	});
});
