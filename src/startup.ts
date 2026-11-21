import type { Harness, Loaded, LoadedSubject } from "./harnesses/shared.js";
import { foreignOf, reportMissing, samePath } from "./harnesses/shared.js";
import type { Copy } from "./run-copy.js";
import { session } from "./session.js";

// A judge answers in one message. The second turn is room for one stray tool call before the answer.
const JUDGE_LIMITS = { maxTurns: 2, timeoutSeconds: 300 };

// Subject kind -> whether the harness reported the subject as loaded, or null when it does not report that.
// A plugin is found by its directory and a skills folder by the name of every skill in it.
const REPORTED_LOADED = {
  plugin: (subject: LoadedSubject, { paths }: Loaded) =>
    paths && paths.some((loadedPath) => samePath(loadedPath, subject.dir)),
  skills: (subject: LoadedSubject, { skills }: Loaded) =>
    skills && subject.skills.every((name) => skills.includes(name)),
};

/** What a run keeps of the harness's report of what it loaded. */
export interface StartupRecord {
  /** Whether the subject is among what loaded; null when the harness reports no such thing, or nothing is loaded. */
  subjectLoaded: boolean | null;
  loaded: Loaded;
  isolated: boolean;
  /** True when the harness should report its plugins and skills and left one out. */
  reportMissing: boolean;
  /** The names of what does not come from the subject. */
  unexpected: string[];
}

/**
 * Judges what the harness reported as loaded.
 * @param run - The run's harness, and whether it was isolated.
 * @param run.harness - The adapter that ran.
 * @param run.isolated - Whether the run was started with `--isolated`.
 * @param loaded - What the harness reported.
 * @param copy - The run's copy of the subject; null for "none".
 * @returns The part of the run record that comes from the report.
 */
export function startupRecord(
  run: { harness: Harness; isolated?: boolean | undefined },
  loaded: Loaded,
  copy: Copy | null,
): StartupRecord {
  const reports = run.harness.capabilities.has("loadedReport");
  return {
    subjectLoaded:
      copy && reports
        ? REPORTED_LOADED[copy.loaded.kind](copy.loaded, loaded)
        : null,
    loaded,
    isolated: run.isolated ?? false,
    reportMissing: reportMissing(run.harness, loaded),
    unexpected: foreignOf(run.harness, loaded, copy?.loaded ?? null),
  };
}

/** The harness that scores judged checks. */
interface JudgeHarness {
  harness: Harness;
  bin: string;
  model?: string | undefined;
}

/**
 * Builds the function that asks the judge, which loads nothing. Under `--isolated` the judge is started isolated when
 * its harness can be, and what it reports as loaded is held to the same rule as the run's.
 * @param judge - The harness that answers.
 * @param options - How to start it.
 * @param options.isolated - Whether the run is isolated.
 * @param options.withhold - Variables the judge must not get.
 * @param options.pass - Names of variables the config passes on.
 * @param problems - Receives why a judge session does not prove it loaded nothing.
 * @returns A function that sends one prompt to the judge.
 */
export function judgeAsker(
  judge: JudgeHarness,
  options: {
    isolated: boolean;
    withhold: string[];
    pass: string[] | undefined;
  },
  problems: string[],
) {
  const { harness } = judge;
  const isolated = options.isolated && harness.capabilities.has("isolated");
  return (judgePrompt: string) =>
    session(
      {
        ...judge,
        subject: null,
        prompt: judgePrompt,
        ...JUDGE_LIMITS,
        isolated,
        withhold: options.withhold,
        pass: options.pass,
      },
      ({ parsed, error, durationMs }) => {
        const foreign = foreignOf(harness, parsed.loaded, null);
        if (isolated && reportMissing(harness, parsed.loaded)) {
          problems.push("the judge harness did not report what it loaded");
        } else if (isolated && foreign.length > 0) {
          problems.push(
            `the judge loaded outside the subject: ${foreign.join(", ")}`,
          );
        }
        return {
          finalText: parsed.finalText,
          error,
          durationMs,
          tokens: parsed.tokens,
          costUsd: parsed.costUsd,
        };
      },
    );
}
