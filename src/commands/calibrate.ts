import fs from "node:fs";
import path from "node:path";
import { selectHarnesses } from "../harnesses/index.js";
import { NOISE_FILE, noiseOf } from "../noise.js";
import { noiseSubjectOf } from "../noise-subject.js";
import type { SubjectSummary } from "../subject.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { UsageError } from "../scope.js";
import type { Options } from "../usage.js";
import { execute } from "./suite.js";

// The reps of a calibration, when nothing sets them: a spread needs more runs than a comparison.
const CALIBRATION_REPS = 5;
const INDENT = "\t";

/**
 * The `calibrate` command: runs the subject against itself, as `run` would run two subjects, and writes how much the
 * scores move into `noise.json` beside `results.json`. `run --noise` reads that file.
 * @param options - The command line's options.
 * @param project - Where the config file and the default cases directory are.
 * @returns The exit code of the runs, as `run` gives it; no pass bar applies. 2 is raised, as an error, when more than
 *   one harness would run, because noise is a property of one harness.
 * @throws {UsageError} When more than one harness is chosen.
 */
export async function calibrate(
  options: Options,
  project: Project,
): Promise<number> {
  const { subject, ...rest } = options;
  const merged = withConfig(project, rest);
  if (selectHarnesses(merged.harness).chosen.length > 1) {
    throw new UsageError(
      "calibrate measures one harness: pass --harness <id>, not several or all",
    );
  }
  const spec = subject ?? project.root;
  const evaluation = await execute(
    {
      ...rest,
      reps: merged.reps ?? CALIBRATION_REPS,
      subjects: [spec, spec],
      sameSubject: true,
      cwd: project.cwd,
    },
    project,
  );
  const [harness] = evaluation.harnesses;
  const noise = noiseOf(evaluation.records, {
    harness: harness ?? "",
    reps: evaluation.reps,
    seed: evaluation.seed,
    caseIds: (evaluation.applied[harness ?? ""] ?? []).map((one) => one.id),
    weights: Object.fromEntries(
      evaluation.cases.map((one) => [one.id, one.weight]),
    ),
  });
  if (noise === null) {
    console.error(
      `skill-evals: no ${NOISE_FILE} written: no case has a valid run on both sides`,
    );
    return evaluation.exit;
  }
  // `execute` resolved the one subject, twice.
  const calibrated = evaluation.subjects[0] as SubjectSummary;
  const recorded = { ...noise, subject: noiseSubjectOf(calibrated) };
  const file = path.join(evaluation.outDir, NOISE_FILE);
  fs.writeFileSync(file, `${JSON.stringify(recorded, null, INDENT)}\n`);
  console.error(`skill-evals: wrote ${file}`);
  return evaluation.exit;
}
