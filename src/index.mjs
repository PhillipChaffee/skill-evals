import fs from "node:fs";
import path from "node:path";
import { selectHarnesses } from "./harnesses/index.mjs";
import { loadCases } from "./cases.mjs";
import { findProject, withConfig } from "./project.mjs";
import { invalidReason, runOnce } from "./run.mjs";
import { failedBars, isUnitScore, scoreSuites } from "./score.mjs";
import { UsageError, outputDir, requireSupportedPlatform } from "./scope.mjs";
import { resolveSubject } from "./subject.mjs";

export { loadCases } from "./cases.mjs";
export { HARNESSES } from "./harnesses/index.mjs";

/**
 * Runs every case against each subject, scores the runs, and writes `results.json` and each run's files to outDir.
 * One subject is scored on its own. With two, the first is the baseline and the second is the one under test,
 * which the pass bars apply to. Unset options take their value from the project's config file.
 * It prints nothing and never calls process.exit. A wrong option, case file, or config file throws a UsageError.
 * While it runs, SIGINT and SIGTERM end the process with exit code 130 after the cleanup.
 *
 * @typedef {Pick<import("./subject.mjs").Subject, "label" | "spec" | "kind" | "dir" | "skills" | "commit">} SubjectSummary
 * @typedef {{ records: import("./run.mjs").RunRecord[], suites: import("./score.mjs").SuiteScore[], belowBar: string[],
 *   invalid: string[], outDir: string, subjects: SubjectSummary[], cases: import("./cases.mjs").Case[],
 *   harnesses: string[], harnessReason: string, judge: string, reps: number, model: string | null }} Evaluation
 *   belowBar: the pass bars that were not reached; invalid: the runs that do not count, each with its reason.
 *   The evaluation succeeded when both are empty.
 *
 * @param {{ cwd?: string, subjects: string[], harness?: string, cases?: string, caseGlob?: string, reps?: number,
 *   model?: string, judgeHarness?: string, judgeModel?: string, minScore?: number, outDir?: string,
 *   onRun?: (record: import("./run.mjs").RunRecord) => void }} options
 *   cwd: the working directory, which sets the project and what relative paths resolve against (default: the process's)
 *   subjects: one or two of a directory, a git ref of the project, or "none"
 *   onRun: called with each run's record as soon as the run ends
 * @returns {Promise<Evaluation>}
 */
export async function evaluate({ cwd = process.cwd(), subjects: specs, onRun, ...given }) {
	requireSupportedPlatform();
	if (!Array.isArray(specs) || specs.length < 1 || specs.length > 2) throw new UsageError("subjects must hold one or two subjects");
	const project = findProject(cwd);
	const options = withConfig(project, given);
	const { reps = 3, minScore, model } = options;
	if (!Number.isInteger(reps) || reps < 1) throw new UsageError("reps must be a positive integer");
	if (minScore !== undefined && !isUnitScore(minScore)) throw new UsageError("minScore must be a number from 0 to 1");
	const selection = selectHarnesses(options.harness);
	const judgeHarness = options.judgeHarness && selectHarnesses(options.judgeHarness).chosen[0];
	const judgeModel = options.judgeModel ?? model;
	const cases = loadCases(options.cases, options.caseGlob);
	const labels = specs.length === 1 ? ["subject"] : ["a", "b"];
	const subjects = [];
	try {
		for (const [index, spec] of specs.entries()) subjects.push(resolveSubject(labels[index], spec, project));
		const outDir = outputDir(options.outDir, cwd);
		const records = [];
		for (const { harness, bin } of selection.chosen) {
			const judge = { ...(judgeHarness ?? { harness, bin }), model: judgeModel };
			for (const caseDef of cases) {
				for (let rep = 1; rep <= reps; rep++) {
					for (const subject of subjects) {
						const record = await runOnce({ harness, bin, subject, caseDef, rep, model, judge, outDir });
						records.push(record);
						onRun?.(record);
					}
				}
			}
		}
		const harnesses = selection.chosen.map(({ harness }) => harness.id);
		const suites = scoreSuites(harnesses, cases, records, labels);
		const evaluation = {
			subjects: subjects.map(({ label, spec, kind, dir, skills, commit }) => ({ label, spec, kind, dir, skills, commit })),
			harnesses,
			harnessReason: selection.reason,
			model: model ?? null,
			judge: `${judgeHarness?.harness.id ?? "the harness under test"}, model ${judgeModel ?? "the harness default"}`,
			reps,
			suites,
			belowBar: failedBars(suites, labels.at(-1), minScore),
			invalid: records
				.filter(invalidReason)
				.map((record) => `${record.harness} ${record.caseId} ${record.subject}${record.rep}: ${invalidReason(record)}`),
			records,
		};
		fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(evaluation, null, "\t"));
		return { ...evaluation, cases, outDir };
	} finally {
		for (const subject of subjects) subject.dispose();
	}
}
