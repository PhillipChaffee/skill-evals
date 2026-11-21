import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { HARNESSES, findBin, namedHarnesses, selectHarnesses } from "./harnesses/index.mjs";
import { loadCases } from "./cases.mjs";
import { renderReport } from "./report.mjs";
import { invalidReason, runOnce } from "./run.mjs";
import { failedBars, isUnitScore, scoreSuites } from "./score.mjs";
import { UsageError } from "./scope.mjs";
import { resolveVariant } from "./variants.mjs";

const repoDir = path.resolve(import.meta.dirname, "..");

const USAGE = `Usage: skill-evals <command> [options]

  run    Run every case against kit A and kit B, score both, and print a comparison.
           --a <ref|path>         baseline kit (default: main)
           --b <ref|path>         changed kit (default: this checkout, uncommitted changes included)
  score  Run every case against one kit and print its scores.
           --kit <ref|path>       the kit (default: this checkout, uncommitted changes included)
  run and score also take:
           --harness <ids|all>    comma-separated harness ids (default: the first installed one)
           --case <glob>          case ids to run (default: *)
           --cases <dir>          directory that holds the cases (default: evals/cases)
           --reps <n>             runs for each variant and case (default: 3)
           --model <id>           passed to the harness (default: the harness's own default)
           --min-score <0..1>     exit 1 when the suite score of the kit (B for run) is lower
           --judge-harness <id>   harness that scores judged checks (default: the harness under test)
           --judge-model <id>     model that scores judged checks (default: --model)
           --out <dir>            where results go (default: a new temp directory)
  check  Run one small prompt in each installed harness and show what its adapter reports.
           --harness <ids|all>  (default: all)   --model <id>   --out <dir>
  list   Show harnesses in default-preference order, and the cases.
           --cases <dir>`;

const OPTIONS = {
	a: { type: "string", default: "main" },
	b: { type: "string", default: repoDir },
	kit: { type: "string", default: repoDir },
	harness: { type: "string" },
	case: { type: "string", default: "*" },
	cases: { type: "string", default: path.join(repoDir, "evals", "cases") },
	reps: { type: "string", default: "3" },
	model: { type: "string" },
	"min-score": { type: "string" },
	"judge-harness": { type: "string" },
	"judge-model": { type: "string" },
	out: { type: "string" },
};
const SUITE_OPTIONS = ["harness", "case", "cases", "reps", "model", "min-score", "judge-harness", "judge-model", "out"];

// The prompt names one small kit skill, so the adapter's skill-load signal shows up in the result.
const PROBE = {
	id: "hello",
	prompt: 'Use the bro skill on this sentence: "The cache is cold."',
	checks: [],
	timeoutSeconds: 300,
	workspaceDir: null,
};

function outputDir(requested) {
	if (!requested) return fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
	fs.mkdirSync(requested, { recursive: true });
	return path.resolve(requested);
}

/**
 * Runs the suite on each named version of the kit and scores it. The last version is the one under test.
 * @param {["a" | "b" | "kit", string][]} specs  label and ref or path of each version
 */
async function evaluate(options, specs) {
	const reps = Number(options.reps);
	if (!Number.isInteger(reps) || reps < 1) throw new UsageError("--reps must be a positive integer");
	const minScore = options["min-score"] === undefined ? undefined : Number(options["min-score"]);
	if (minScore !== undefined && !isUnitScore(minScore)) throw new UsageError("--min-score must be a number from 0 to 1");
	const selection = selectHarnesses(options.harness);
	const judgeHarness = options["judge-harness"] && selectHarnesses(options["judge-harness"]).chosen[0];
	const judgeModel = options["judge-model"] ?? options.model;
	const cases = loadCases(options.cases, options.case);
	const variants = [];
	try {
		for (const [label, spec] of specs) variants.push(resolveVariant(label, spec, repoDir));
		const outDir = outputDir(options.out);
		const records = [];
		for (const { harness, bin } of selection.chosen) {
			const judge = { ...(judgeHarness ?? { harness, bin }), model: judgeModel };
			for (const caseDef of cases) {
				for (let rep = 1; rep <= reps; rep++) {
					for (const variant of variants) {
						const record = await runOnce({ harness, bin, variant, caseDef, rep, model: options.model, judge, outDir });
						records.push(record);
						const outcome = invalidReason(record) ?? `score ${record.score.toFixed(2)}`;
						console.error(`${harness.id} ${caseDef.id} ${variant.label}${rep}: ${outcome}`);
					}
				}
			}
		}
		const labels = variants.map((variant) => variant.label);
		const suites = scoreSuites(
			selection.chosen.map(({ harness }) => harness.id),
			cases,
			records,
			labels,
		);
		const belowBar = failedBars(suites, labels.at(-1), minScore);
		const judgeNote = `${judgeHarness?.harness.id ?? "the harness under test"}, model ${judgeModel ?? "the harness default"}`;
		const summary = variants.map(({ label, spec, dir, commit }) => ({ label, spec, dir, commit }));
		fs.writeFileSync(
			path.join(outDir, "results.json"),
			JSON.stringify({ variants: summary, model: options.model ?? null, judge: judgeNote, reps, suites, belowBar, records }, null, "\t"),
		);
		console.log(renderReport({ variants, selection, cases, records, suites, belowBar, judgeNote, reps, model: options.model, outDir }));
		return records.some(invalidReason) || belowBar.length ? 1 : 0;
	} finally {
		for (const variant of variants) variant.dispose();
	}
}

// What an adapter can fill in a run record; `check` shows which of these a harness delivered.
const FILLABLE = {
	finalText: (record) => record.finalText !== "",
	toolCalls: (record) => record.toolCalls.length > 0,
	tokens: (record) => record.tokens !== null,
	costUsd: (record) => record.costUsd !== null,
};
const KIT_LOADED = { true: "yes", false: "NO", null: "this harness gives no evidence" };

async function check(options) {
	const located = namedHarnesses(options.harness).map((harness) => ({ harness, bin: findBin(harness) }));
	const variant = resolveVariant("b", repoDir, repoDir);
	const outDir = located.some((entry) => entry.bin) ? outputDir(options.out) : "nothing ran";
	const rows = [];
	let failed = false;
	for (const { harness, bin } of located) {
		if (!bin) {
			rows.push([harness.id, `no ("${harness.bin}" not found)`, "", "", "", ""]);
			continue;
		}
		const record = await runOnce({ harness, bin, variant, caseDef: PROBE, rep: 1, model: options.model, outDir });
		failed ||= invalidReason(record) !== null;
		rows.push([
			harness.id,
			"yes",
			record.error ? `NO: ${record.error.replace(/\s+/g, " ").slice(0, 200)}` : "yes",
			KIT_LOADED[record.kitLoaded],
			record.skillsLoaded.join(", ") || "none",
			Object.keys(FILLABLE)
				.filter((field) => FILLABLE[field](record))
				.join(", ") || "none",
		]);
	}
	console.log(
		[
			`Kit: ${variant.dir}`,
			`Output: ${outDir}`,
			"",
			"| Harness | Installed | Ran | Kit loaded from this checkout | Skills loaded | Record fields filled |",
			"| --- | --- | --- | --- | --- | --- |",
			...rows.map((row) => `| ${row.map((text) => text.replaceAll("|", "\\|")).join(" | ")} |`),
		].join("\n"),
	);
	return failed ? 1 : 0;
}

function list(options) {
	const installed = HARNESSES.map((harness) => ({ harness, bin: findBin(harness) }));
	const first = installed.find((entry) => entry.bin);
	const cases = fs.existsSync(options.cases)
		? loadCases(options.cases).map((caseDef) => `- ${caseDef.id}: ${caseDef.checks.length} checks`)
		: ["- none: the directory does not exist"];
	console.log(
		[
			"Harnesses, in default-preference order:",
			...installed.map(
				({ harness, bin }) => `- ${harness.id}: ${bin ? `installed (${bin})` : `not installed ("${harness.bin}" not found)`}`,
			),
			`Default harness: ${first ? first.harness.id : "none installed"}`,
			"",
			`Cases in ${options.cases}:`,
			...cases,
		].join("\n"),
	);
	return 0;
}

const COMMANDS = {
	run: {
		handler: (options) =>
			evaluate(options, [
				["a", options.a],
				["b", options.b],
			]),
		options: ["a", "b", ...SUITE_OPTIONS],
	},
	score: { handler: (options) => evaluate(options, [["kit", options.kit]]), options: ["kit", ...SUITE_OPTIONS] },
	check: { handler: check, options: ["harness", "model", "out"] },
	list: { handler: list, options: ["cases"] },
};

/** @returns {Promise<number>} the exit code */
export async function main([name, ...args]) {
	try {
		const command = COMMANDS[name];
		if (!command) throw new UsageError(`${name ? `unknown command "${name}"` : "missing command"}\n\n${USAGE}`);
		const options = Object.fromEntries(command.options.map((key) => [key, OPTIONS[key]]));
		return await command.handler(parseArgs({ args, options }).values);
	} catch (error) {
		if (!(error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS"))) throw error;
		console.error(`skill-evals: ${error.message}`);
		return 2;
	}
}
