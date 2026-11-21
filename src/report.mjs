import { describeCheck, isJudged } from "./cases.mjs";
import { invalidReason } from "./run.mjs";
import { formatScore } from "./score.mjs";
import { describeVariant } from "./variants.mjs";

const METRICS = [
	{ title: "Duration", value: (record) => record.durationMs / 1000, format: (v) => `${v.toFixed(1)} s` },
	{ title: "Input tokens", value: (record) => record.tokens?.input ?? null, format: (v) => String(Math.round(v)) },
	{ title: "Output tokens", value: (record) => record.tokens?.output ?? null, format: (v) => String(Math.round(v)) },
	{ title: "Cost", value: (record) => record.costUsd, format: (v) => `$${v.toFixed(4)}` },
];

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((x, y) => x - y);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One value for each variant, and the change from the first to the second when there are two. */
function versus(values, format) {
	if (values.every((value) => value === null)) return "n/a";
	const shown = values.map((value) => (value === null ? "n/a" : format(value))).join(" / ");
	if (values.length < 2 || values.includes(null)) return shown;
	const delta = values[1] - values[0];
	return `${shown} (${delta < 0 ? "-" : "+"}${format(Math.abs(delta))})`;
}

/** A deterministic check as the share of runs that passed it, a judged check as its mean score. */
function checkRate(check, index, records) {
	if (records.length === 0) return "n/a";
	const total = records.reduce((sum, record) => sum + record.checks[index].score, 0);
	return isJudged(check) ? formatScore(total / records.length) : `${total}/${records.length}`;
}

function judgeLine(records) {
	const judged = records.map((record) => record.judge).filter(Boolean);
	if (judged.length === 0) return [];
	const sum = (value) => judged.reduce((total, usage) => total + (value(usage) ?? Number.NaN), 0);
	const parts = [
		`${sum((usage) => usage.calls)} calls`,
		...METRICS.map((metric) => ({ metric, total: sum(metric.value) }))
			.filter(({ total }) => !Number.isNaN(total))
			.map(({ metric, total }) => `${metric.title.toLowerCase()} ${metric.format(total)}`),
	];
	return ["", `Judge, in total and not counted in the table: ${parts.join(", ")}`];
}

const cell = (text) => text.replaceAll("|", "\\|");

function harnessSection(suite, cases, records, labels) {
	const mine = records.filter((record) => record.harness === suite.harness);
	const tag = (label) => (labels.length > 1 ? `${label.toUpperCase()} ` : "");
	const heading = (title) => (labels.length > 1 ? `${title}, A / B (B - A)` : title);
	const rows = cases.map((caseDef, caseIndex) => {
		const valid = labels.map((label) =>
			mine.filter((record) => record.caseId === caseDef.id && record.variant === label && !invalidReason(record)),
		);
		const checks = caseDef.checks.map(
			(check, index) =>
				`\`${describeCheck(check)}\` ${labels.map((label, at) => tag(label) + checkRate(check, index, valid[at])).join(", ")}`,
		);
		const cells = [
			caseDef.id,
			versus(Object.values(suite.cases[caseIndex].scores), formatScore),
			checks.join("<br>"),
			...METRICS.map((metric) =>
				versus(
					valid.map((runs) => median(runs.map(metric.value).filter((value) => value !== null))),
					metric.format,
				),
			),
		];
		return `| ${cells.map(cell).join(" | ")} |`;
	});
	const invalid = mine.filter(invalidReason).map((record) => {
		const reason = invalidReason(record).replace(/\s+/g, " ").slice(0, 300);
		return `- ${record.variant.toUpperCase()} \`${record.caseId}\` rep ${record.rep}: ${reason}`;
	});
	return [
		`## ${suite.harness}`,
		"",
		`| Case | ${heading("Score")} | Checks | ${METRICS.map((metric) => heading(metric.title)).join(" | ")} |`,
		`| ${Array(METRICS.length + 3)
			.fill("---")
			.join(" | ")} |`,
		...rows,
		"",
		`Suite score: ${versus(Object.values(suite.suite), formatScore)}`,
		...judgeLine(mine),
		...(invalid.length ? ["", "Invalid runs, not counted above:", "", ...invalid] : []),
	].join("\n");
}

/**
 * @param {{ variants: import("./variants.mjs").Variant[],
 *   selection: ReturnType<typeof import("./harnesses/index.mjs").selectHarnesses>,
 *   cases: import("./cases.mjs").Case[], records: import("./run.mjs").RunRecord[],
 *   suites: import("./score.mjs").SuiteScore[], belowBar: string[], judgeNote: string,
 *   reps: number, model?: string, outDir: string }} run
 */
export function renderReport({ variants, selection, cases, records, suites, belowBar, judgeNote, reps, model, outDir }) {
	const labels = variants.map((variant) => variant.label);
	const judged = cases.some((caseDef) => caseDef.checks.some(isJudged));
	return [
		variants.length > 1 ? "# Kit comparison" : "# Kit scores",
		"",
		...variants.map((variant) => `- ${variant.label.toUpperCase()}: ${describeVariant(variant)}`),
		`- Harness: ${selection.chosen.map(({ harness }) => harness.id).join(", ")} (${selection.reason})`,
		`- Model: ${model ?? "the harness default"}`,
		...(judged ? [`- Judge: ${judgeNote}`] : []),
		`- Reps: ${reps} for each ${variants.length > 1 ? "variant and case" : "case"}`,
		`- Output: ${outDir}`,
		"",
		suites.map((suite) => harnessSection(suite, cases, records, labels)).join("\n\n"),
		...(belowBar.length ? ["", "Below the pass bar:", "", ...belowBar.map((line) => `- ${line}`)] : []),
		"",
	].join("\n");
}
