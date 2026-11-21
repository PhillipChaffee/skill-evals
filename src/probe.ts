import { exclusionsOf } from "./exclusions.js";
import type { Case } from "./cases.js";
import { findBin, namedHarnesses } from "./harnesses/index.js";
import type { Project } from "./project.js";
import { withConfig } from "./project.js";
import type { RunRecord } from "./run.js";
import { invalidReason, runOnce } from "./run.js";
import { outputDir } from "./scope.js";
import type { Subject } from "./subject.js";
import {
  SUBJECT_CHANGED_EXIT_CODE,
  changedAtSource,
  describeSubject,
  resolveSubject,
  sourceChangedMessage,
} from "./subject.js";

/** The options of the `check` command. */
export interface ProbeOptions {
  subject?: string | undefined;
  harness?: string | undefined;
  model?: string | undefined;
  outDir?: string | undefined;
}

const PROBE_TIMEOUT_SECONDS = 300;
const SHOWN_ERROR_LENGTH = 200;

/**
 * Writes the one small case that `check` runs.
 * @param subject - What the harness loads.
 * @returns A case with no checks. Its prompt names the subject's first skill, so the adapter's skill-load signal
 *   shows up in the result; with no skills it asks for a one-word reply.
 */
const probe = (subject: Subject): Case => ({
  id: "hello",
  prompt: subject.skills[0]
    ? `Use the ${subject.skills[0]} skill on this sentence: "The cache is cold."`
    : "Reply with the single word: pong",
  checks: [],
  weight: 1,
  timeoutSeconds: PROBE_TIMEOUT_SECONDS,
  workspaceDir: null,
  extensions: {},
});

// What an adapter can fill in a run record; `check` shows which of these a harness delivered.
const FILLABLE: Record<string, (record: RunRecord) => boolean> = {
  finalText: (record) => record.finalText !== "",
  toolCalls: (record) => record.toolCalls.length > 0,
  tokens: (record) => record.tokens !== null,
  costUsd: (record) => record.costUsd !== null,
};

const loadedText = (loaded: boolean | null): string => {
  if (loaded === null) return "no evidence from this harness";
  return loaded ? "yes" : "NO";
};

/**
 * Builds the table row of a harness that ran.
 * @param subject - What the harness was asked to load.
 * @param record - The record of the probe run.
 * @returns The cells after the harness id: installed, ran, subject loaded, skills loaded, and record fields filled.
 */
function ranRow(subject: Subject, record: RunRecord): string[] {
  const failure = record.error
    ?.replace(/\s+/g, " ")
    .slice(0, SHOWN_ERROR_LENGTH);
  const filled = Object.entries(FILLABLE)
    .filter(([, isFilled]) => isFilled(record))
    .map(([field]) => field);
  return [
    "yes",
    failure ? `NO: ${failure}` : "yes",
    subject.kind === "none"
      ? "nothing to load"
      : loadedText(record.subjectLoaded),
    record.skillsLoaded.join(", ") || "none",
    filled.join(", ") || "none",
  ];
}

/**
 * Lays out the `check` output.
 * @param subject - What the harnesses were asked to load.
 * @param outDir - Where the runs' files are, or "nothing ran".
 * @param rows - One row of cells for each harness.
 * @returns The subject, the output directory, and the table.
 */
function table(subject: Subject, outDir: string, rows: string[][]): string {
  return [
    `Subject: ${describeSubject(subject)}`,
    `Output: ${outDir}`,
    "",
    "| Harness | Installed | Ran | Reported the subject as loaded | Skills the agent loaded | Record fields filled |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.map((text) => text.replaceAll("|", "\\|")).join(" | ")} |`,
    ),
  ].join("\n");
}

/**
 * Runs one small prompt in each harness and prints what its adapter reports, as a table.
 * @param given - The options of the command line.
 * @param project - Where the config file and the default subject are.
 * @returns The exit code: 1 when any installed harness failed its run, else 0. A harness that is not installed is
 *   a row in the table, not a failure.
 */
export async function check(
  given: ProbeOptions,
  project: Project,
): Promise<number> {
  const options = withConfig(project, given);
  const located = namedHarnesses(options.harness).map((harness) => ({
    harness,
    bin: findBin(harness),
  }));
  const subject = resolveSubject("subject", options.subject ?? project.root, {
    ...project,
    left: exclusionsOf(options, project.cwd),
  });
  try {
    const outDir = located.some((entry) => entry.bin)
      ? outputDir(options.outDir, project.cwd)
      : "nothing ran";
    const rows: string[][] = [];
    let failed = false;
    for (const { harness, bin } of located) {
      if (!bin) {
        const missing = `no ("${harness.bin}" not found)`;
        rows.push([harness.id, missing, "", "", "", ""]);
        continue;
      }
      const record = await runOnce({
        harness,
        bin,
        subject,
        caseDef: probe(subject),
        rep: 1,
        model: options.model,
        // The probe has no judged check and no decision check, so neither model ever runs.
        judge: { harness, bin, model: options.model },
        decision: null,
        pass: options.env,
        outDir,
      });
      failed ||= invalidReason(record) !== null;
      rows.push([harness.id, ...ranRow(subject, record)]);
    }
    console.log(table(subject, outDir, rows));
    const changed = changedAtSource([subject]);
    if (changed.length > 0) {
      console.error(`skill-evals: ${sourceChangedMessage(changed)}`);
      return SUBJECT_CHANGED_EXIT_CODE;
    }
    return failed ? 1 : 0;
  } finally {
    subject.dispose();
  }
}
