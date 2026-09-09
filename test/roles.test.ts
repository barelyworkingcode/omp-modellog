import { describe, expect, test } from "bun:test";
import { labelForModelChange } from "../src/roles";

describe("labelForModelChange", () => {
	test("undefined role is treated as default, per omp's own doc comment", () => {
		expect(labelForModelChange({ role: undefined, model: "relay/vCode" }, undefined)).toEqual({
			role: "default",
			inferred: false,
		});
	});

	test("a real role name passes through verbatim", () => {
		expect(labelForModelChange({ role: "plan", model: "anthropic/claude-opus-5" }, undefined)).toEqual({
			role: "plan",
			inferred: false,
		});
	});

	test("the fallback sentinel is surfaced, not treated as a role", () => {
		expect(labelForModelChange({ role: "fallback", model: "openai/gpt-4o" }, undefined)).toEqual({
			role: "fallback",
			inferred: false,
		});
	});

	test("temporary resolves to a matching configured role when the resolver finds one", () => {
		const resolver = {
			resolve: (spec: string) => (spec === "@plan" ? { provider: "anthropic", id: "claude-opus-5" } : undefined),
		};
		expect(labelForModelChange({ role: "temporary", model: "anthropic/claude-opus-5" }, resolver)).toEqual({
			role: "plan",
			inferred: true,
		});
	});

	test("temporary falls back to 'custom' when no configured role matches", () => {
		const resolver = { resolve: () => undefined };
		expect(labelForModelChange({ role: "temporary", model: "openai/o1-preview" }, resolver)).toEqual({
			role: "custom",
			inferred: true,
		});
	});

	test("temporary with no resolver available still degrades to 'custom' without throwing", () => {
		expect(labelForModelChange({ role: "temporary", model: "openai/o1-preview" }, undefined)).toEqual({
			role: "custom",
			inferred: true,
		});
	});

	test("a resolver that throws is swallowed, not propagated", () => {
		const resolver = {
			resolve: () => {
				throw new Error("boom");
			},
		};
		expect(() => labelForModelChange({ role: "temporary", model: "openai/o1" }, resolver)).not.toThrow();
	});
});
