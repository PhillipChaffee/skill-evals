import fs from "node:fs";
import { binNeeds, hostCapabilities } from "./applicability.js";
import { exclusionsOf } from "./exclusions.js";
import type { Case } from "./cases.js";
import { loadCases } from "./cases.js";
import { findBin, namedHarnesses } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import type { Project } from "./project.js";
import { withConfig } from "./project.js";
import type { RunRecord } from "./run.js";
import { invalidReason, runOnce } from "./run.js";
import { UsageError, outputDir } from "./scope.js";
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
  base: "hello",
  variant: null,
  heldout: false,
  prompt: subject.skills[0]
    ? `Use the ${subject.skills[0]} skill on this sentence: "The cache is cold."`
    : "Reply with the single word: pong",
  checks: [],
  requires: [],
  weight: 1,
  timeoutSeconds: PROBE_TIMEOUT_SECONDS,
  workspaceDir: null,
  graderDir: null,
  setup: [],
  fixtureDirs: [],
  fixtureDir: null,
  homeDir: null,
  extensions: {},
  tags: [],
  targets: [],
  guard: false,
  env: {},
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
 * Says which executables the loaded cases ask for are on this machine.
 * @param cases - The cases the project holds, or why they could not be read.
 * @returns One line: the `bin:<name>` host capabilities that are present, or "none requested".
 */
function hostLine(cases: Case[] | string): string {
  if (typeof cases === "string")
    return `Host capabilities: cases not read (${cases})`;
  const asked = binNeeds(cases);
  if (asked.length === 0) return "Host capabilities: none requested";
  const present = [...hostCapabilities(cases)].sort();
  return `Host capabilities: ${present.join(", ") || `none present, of ${asked.join(", ")}`}`;
}

/**
 * Lists what each harness declares it can observe or do.
 * @param harnesses - The harnesses the command looked at.
 * @returns One line for each harness: its id, its status, and its capabilities.
 */
const capabilityLines = (harnesses: Harness[]): string[] =>
  harnesses.map(
    (harness) =>
      `- ${harness.id} (${harness.status}): ${[...harness.capabilities].join(", ") || "none"}`,
  );

/**
 * Lays out what the harnesses and the host can do, which decides whether a case applies.
 * @param cases - The cases the project holds, or why they could not be read.
 * @param harnesses - The harnesses the command looked at.
 * @returns The host line, and a line for each harness.
 */
const capabilityNotes = (
  cases: Case[] | string,
  harnesses: Harness[],
): string =>
  [
    hostLine(cases),
    "",
    "Capabilities of each harness. A case that needs more is not applicable there:",
    ...capabilityLines(harnesses),
  ].join("\n");

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
 * Loads the cases of the project for the host line, without letting a bad case stop the probe.
 * @param dir - The cases directory.
 * @param lenient - Whether a case file may hold unknown keys.
 * @returns The cases, or the reason they could not be read.
 */
function loadSafely(dir: string, lenient: boolean): Case[] | string {
  try {
    return loadCases(dir, undefined, { lenient, onWarning: () => undefined });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return error.message.replace(/\s+/g, " ").slice(0, SHOWN_ERROR_LENGTH);
  }
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
    const cases = fs.existsSync(options.cases)
      ? loadSafely(options.cases, options.lenient ?? false)
      : [];
    const harnesses = located.map((entry) => entry.harness);
    console.log(
      `${table(subject, outDir, rows)}\n\n${capabilityNotes(cases, harnesses)}`,
    );
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
