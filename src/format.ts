import type { CollectResult, RoleUsage } from "./types";

export function humanTokens(n: number): string {
	if (n === 0) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

export function humanCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

export function humanDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds % 60);
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function totalTokens(row: RoleUsage): number {
	return row.input + row.output + row.cacheRead + row.cacheWrite;
}

/** "plan -> opus, task -> vCode, default -> gpt-5.6-luna", first-called order. */
export function formatHeadline(rows: RoleUsage[]): string {
	if (rows.length === 0) return "Models used: (none yet)";
	const parts = rows.map((r) => `${r.role} -> ${r.modelShort}${r.inferred ? "*" : ""}`);
	return `Models used: ${parts.join(", ")}`;
}

export function formatStatusLine(rows: RoleUsage[], totals: CollectResult["totals"]): string {
	if (rows.length === 0) return "modellog: no calls yet";
	const parts = rows.map((r) => `${r.role}>${r.modelShort}`);
	return `${parts.join(" ")} ${humanCost(totals.cost)}`;
}

export function formatTable(result: CollectResult): string[] {
	const lines: string[] = [];
	lines.push(formatHeadline(result.rows));
	lines.push("");

	if (result.rows.length === 0) {
		lines.push("(no model activity recorded yet)");
		return lines;
	}

	const header = ["role", "model", "calls", "in", "out", "cache r", "cache w", "cost", "time", "origin"];
	const dataRows = result.rows.map((r) => [
		r.inferred ? `${r.role}*` : r.role,
		r.modelShort,
		String(r.calls),
		humanTokens(r.input),
		humanTokens(r.output),
		humanTokens(r.cacheRead),
		humanTokens(r.cacheWrite),
		r.cost > 0 || r.input + r.output > 0 ? humanCost(r.cost) : "-",
		r.durationSamples > 0 ? humanDuration(r.durationMs) + (r.approxTokens > 0 ? "" : "") : r.approxTokens > 0 ? "~" : "-",
		r.origin === "main" ? "" : r.origin === "subagent" ? `subagent${r.originDetail ? `: ${r.originDetail}` : ""}` : `aux${r.originDetail ? `: ${r.originDetail}` : ""}`,
	]);

	const widths = header.map((h, i) => Math.max(h.length, ...dataRows.map((row) => (row[i] ?? "").length)));
	const fmtRow = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");

	lines.push(fmtRow(header));
	lines.push(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of dataRows) lines.push(fmtRow(row));

	lines.push(widths.map((w) => "-".repeat(w)).join("  "));
	const t = result.totals;
	lines.push(
		fmtRow([
			"total",
			"",
			String(t.calls),
			humanTokens(t.input),
			humanTokens(t.output),
			humanTokens(t.cacheRead),
			humanTokens(t.cacheWrite),
			humanCost(t.cost),
			humanDuration(t.durationMs),
			t.approxTokens > 0 ? `+${humanTokens(t.approxTokens)} approx` : "",
		]),
	);

	if (result.rows.some((r) => r.inferred)) {
		lines.push("");
		lines.push("* role inferred from the current model->role config, not recorded structurally.");
	}
	if (result.rows.some((r) => r.approxTokens > 0)) {
		lines.push("(some subagent rows report only a flat token/cost count with no in/out split, or are still running)");
	}

	return lines;
}

export function formatJson(result: CollectResult): string {
	return JSON.stringify(
		{
			headline: formatHeadline(result.rows),
			rows: result.rows.map((r) => ({ ...r, totalTokens: totalTokens(r) })),
			totals: result.totals,
			sessionStart: result.sessionStart,
			sessionEnd: result.sessionEnd,
			warnings: result.warnings,
		},
		null,
		2,
	);
}
