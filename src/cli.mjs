import fs from "node:fs";
import { parseArgs } from "node:util";
import { HARNESSES, findBin, namedHarnesses } from "./harnesses/index.mjs";
import { loadCases } from "./cases.mjs";
import { evaluate } from "./index.mjs";
import { findProject, withConfig } from "./project.mjs";
import { renderReport } from "./report.mjs";
import { invalidReason, runOnce } from "./run.mjs";
import { UsageError, outputDir, requireSupportedPlatform } from "./scope.mjs";
import { describeSubject, resolveSubject } from "./subject.mjs";

const USAGE = `Usage: skill-evals <command> [options]

  run    Run every case against subject A and subject B, score both, and print a comparison.
           --a <subject>          the baseline (default: main)
           --b <subject>          the change (default: the project, uncommitted changes included)
  score  Run every case against one subject and print its scores.
           --subject <subject>    (default: the project, uncommitted changes included)
  run and score also take:
           --harness <ids|all>    comma-separated harness ids (default: the first installed one)
           --case <glob>          case ids to run (default: *)
           --cases <dir>          directory that holds the cases (default: evals/cases in the project)
           --reps <n>             runs for each subject and case (default: 3)
           --model <id>           passed to the harness (default: the harness's own default)
           --min-score <0..1>     exit 1 when the suite score of the subject (B for run) is lower
           --judge-harness <id>   harness that scores judged checks (default: the harness under test)
           --judge-model <id>     model that scores judged checks (default: --model)
           --out <dir>            where results go (default: a new temp directory)
  check  Run one small prompt in each installed harness and show what its adapter reports.
           --subject <subject>  --harness <ids|all>  (default: all)   --model <id>   --out <dir>
  list   Show harnesses in default-preference order, and the cases.
           --cases <dir>

A subject is what a run loads: a directory, a git ref of the project, or "none" for no skills at all.
A directory or ref with a plugin manifest is loaded as a plugin. Any other is a folder of skills.
The project is the git repository that holds the working directory, or the working directory itself.
skill-evals.config.json in the project can set a default for cases, harness, reps, model, judgeHarness,
judgeModel, and minScore.`;

// Flag -> the option it sets (its own name when `as` is absent) and how its text is read.
const FLAGS = {
	a: {},
	b: {},
	subject: {},
	harness: {},
	case: { as: "caseGlob" },
	cases: {},
	reps: { read: Number },
	model: {},
	"min-score": { as: "minScore", read: Number },
	"judge-harness": { as: "judgeHarness" },
	"judge-model": { as: "judgeModel" },
	out: { as: "outDir" },
};
const SUITE_FLAGS = ["harness", "case", "cases", "reps", "model", "min-score", "judge-harness", "judge-model", "out"];

/**
 * The prompt names one skill of the subject, so the adapter's skill-load signal shows up in the result.
 * @param {import("./subject.mjs").Subject} subject
 */
const probe = (subject) => ({
	id: "hello",
	prompt: subject.skills.length ? `Use the ${subject.skills[0]} skill on this sentence: "The cache is cold."` : "Reply with the single word: pong",
	checks: [],
	timeoutSeconds: 300,
	workspaceDir: null,
});

/** Runs the suite, prints its report, and returns the exit code. */
async function suite(options) {
	const onRun = (record) => {
		const outcome = invalidReason(record) ?? `score ${record.score.toFixed(2)}`;
		console.error(`${record.harness} ${record.caseId} ${record.subject}${record.rep}: ${outcome}`);
	};
	const evaluation = await evaluate({ ...options, onRun });
	console.log(renderReport(evaluation));
	return evaluation.invalid.length || evaluation.belowBar.length ? 1 : 0;
}

// What an adapter can fill in a run record; `check` shows which of these a harness delivered.
const FILLABLE = {
	finalText: (record) => record.finalText !== "",
	toolCalls: (record) => record.toolCalls.length > 0,
	tokens: (record) => record.tokens !== null,
	costUsd: (record) => record.costUsd !== null,
};
const SUBJECT_LOADED = { true: "yes", false: "NO", null: "no evidence from this harness" };

async function check(given, project) {
	const options = withConfig(project, given);
	const located = namedHarnesses(options.harness).map((harness) => ({ harness, bin: findBin(harness) }));
	const subject = resolveSubject("subject", options.subject ?? project.root, project);
	try {
		const outDir = located.some((entry) => entry.bin) ? outputDir(options.outDir, project.cwd) : "nothing ran";
		const rows = [];
		let failed = false;
		for (const { harness, bin } of located) {
			if (!bin) {
				rows.push([harness.id, `no ("${harness.bin}" not found)`, "", "", "", ""]);
				continue;
			}
			const record = await runOnce({ harness, bin, subject, caseDef: probe(subject), rep: 1, model: options.model, outDir });
			failed ||= invalidReason(record) !== null;
			rows.push([
				harness.id,
				"yes",
				record.error ? `NO: ${record.error.replace(/\s+/g, " ").slice(0, 200)}` : "yes",
				subject.kind === "none" ? "nothing to load" : SUBJECT_LOADED[record.subjectLoaded],
				record.skillsLoaded.join(", ") || "none",
				Object.keys(FILLABLE)
					.filter((field) => FILLABLE[field](record))
					.join(", ") || "none",
			]);
		}
		console.log(
			[
				`Subject: ${describeSubject(subject)}`,
				`Output: ${outDir}`,
				"",
				"| Harness | Installed | Ran | Reported the subject as loaded | Skills the agent loaded | Record fields filled |",
				"| --- | --- | --- | --- | --- | --- |",
				...rows.map((row) => `| ${row.map((text) => text.replaceAll("|", "\\|")).join(" | ")} |`),
			].join("\n"),
		);
		return failed ? 1 : 0;
	} finally {
		subject.dispose();
	}
}

function list(given, project) {
	const options = withConfig(project, given);
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
		handler: ({ a = "main", b, ...options }, project) => suite({ ...options, subjects: [a, b ?? project.root] }),
		flags: ["a", "b", ...SUITE_FLAGS],
	},
	score: {
		handler: ({ subject, ...options }, project) => suite({ ...options, subjects: [subject ?? project.root] }),
		flags: ["subject", ...SUITE_FLAGS],
	},
	check: { handler: check, flags: ["subject", "harness", "model", "out"] },
	list: { handler: list, flags: ["cases"] },
};

/** @returns {Promise<number>} the exit code */
export async function main([name, ...args]) {
	try {
		requireSupportedPlatform();
		const command = COMMANDS[name];
		if (!command) throw new UsageError(`${name ? `unknown command "${name}"` : "missing command"}\n\n${USAGE}`);
		const { values } = parseArgs({ args, options: Object.fromEntries(command.flags.map((flag) => [flag, { type: "string" }])) });
		const options = Object.fromEntries(
			Object.entries(values).map(([flag, text]) => [FLAGS[flag].as ?? flag, (FLAGS[flag].read ?? String)(text)]),
		);
		return await command.handler(options, findProject(process.cwd()));
	} catch (error) {
		if (!(error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS"))) throw error;
		console.error(`skill-evals: ${error.message}`);
		return 2;
	}
}
