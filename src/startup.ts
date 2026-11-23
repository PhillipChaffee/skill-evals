import type { Harness, Loaded, LoadedSubject } from "./harnesses/shared.js";
import { foreignOf, reportMissing, samePath } from "./harnesses/shared.js";
import { mcpProblems } from "./mcp/problems.js";
import type { Stripped } from "./subject-options.js";
import type { Confinement } from "./os-sandbox.js";
import type { Copy } from "./run-copy.js";
import type { SessionResult } from "./session.js";
import { session } from "./session.js";

// A judge answers in one message, with no tools: it reads text that the agent wrote, which may ask it to run something.
const JUDGE_LIMITS = { maxTurns: 1, timeoutSeconds: 300, noTools: true };
// The judge harnesses already warned about, once each for the process.
const warnedTools = new Set<string>();

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
  /** Why a case's mock MCP servers cannot be trusted; the run is invalid. Absent when there is nothing wrong. */
  mcpProblems?: string[];
  /** Agents and skills that the subject's options removed and the harness reported as loaded anyway. Absent when there are none. */
  strippedLoaded?: string[];
}

/**
 * Finds what the options removed from the subject and a harness still reports as loaded.
 * @param stripped - The agents and skills removed from the copy.
 * @param reported - What each harness process said it loaded.
 * @returns The removed names that were reported, once each; a plugin prefix (`plugin:name`) is ignored.
 */
function stillLoaded(stripped: Stripped, reported: Loaded[]): string[] {
  const last = (name: string): string => name.slice(name.lastIndexOf(":") + 1);
  const seen = (names: string[] | null, gone: string[]): string[] =>
    (names ?? []).map(last).filter((name) => gone.includes(name));
  return [
    ...new Set(
      reported.flatMap((each) => [
        ...seen(each.agents, stripped.agents),
        ...seen(each.skills, stripped.skills),
      ]),
    ),
  ];
}

/**
 * Judges what the harness reported as loaded.
 * @param run - The run's harness, and whether it was isolated.
 * @param run.harness - The adapter that ran.
 * @param run.isolated - Whether the run was started with `--isolated`.

 * @param ran - What the session produced: the report, and the home and placed skills that the adapter inspects.
 * @param copy - The run's copy of the subject; null for "none".
 * @returns The part of the run record that comes from the report.
 */
export function startupRecord(
  run: { harness: Harness; isolated?: boolean | undefined },
  ran: Pick<
    SessionResult,
    "home" | "placed" | "userTurns" | "mcpServers" | "mcpProblems"
  > & {
    parsed: { loaded: Loaded; mcpStatus?: Record<string, string> | null };
  },
  copy: Copy | null,
): StartupRecord {
  const { loaded } = ran.parsed;
  const reports = run.harness.capabilities.has("loadedReport");
  // Every harness process reports what it loaded, and each report is held to the same rule.
  const reported = ran.userTurns
    ? ran.userTurns.flatMap((turn) => turn.loaded ?? [])
    : [loaded];
  const subject = copy?.loaded ?? null;
  const loads = reported.map((each) =>
    copy && reports
      ? REPORTED_LOADED[copy.loaded.kind](copy.loaded, each)
      : null,
  );
  // The mock servers are part of the subject. Any other server the harness reports is still foreign.
  const mocks = new Set(ran.mcpServers);
  const foreign = reported.flatMap((each) =>
    foreignOf(
      run.harness,
      {
        ...each,
        mcpServers: each.mcpServers?.filter((name) => !mocks.has(name)) ?? null,
      },
      subject,
    ),
  );
  const unexpected = [...foreign, ...(run.harness.strays?.(ran) ?? [])];
  const problems = [
    ...mcpProblems(run.harness, {
      mocks: ran.mcpServers,
      reported,
      status: ran.parsed.mcpStatus,
      subject,
    }),
    ...ran.mcpProblems,
  ];
  const strippedLoaded = copy ? stillLoaded(copy.stripped, reported) : [];
  return {
    ...(strippedLoaded.length > 0 && { strippedLoaded }),
    ...(problems.length > 0 && { mcpProblems: [...new Set(problems)] }),
    subjectLoaded: loads.includes(false)
      ? false
      : (loads.find(Boolean) ?? null),
    loaded,
    isolated: run.isolated ?? false,
    reportMissing: reported.some((each) => reportMissing(run.harness, each)),
    unexpected: ran.userTurns ? [...new Set(unexpected)] : unexpected,
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
 * @param options.sandbox - Under `--sandbox`, the sandbox that the judge process runs in too.
 * @param problems - Receives why a judge session does not prove it loaded nothing.
 * @returns A function that sends one prompt to the judge, which is started with no tools and one turn. A harness that
 *   cannot be started with no tools gets one warning.
 */
export function judgeAsker(
  judge: JudgeHarness,
  options: {
    isolated: boolean;
    withhold: string[];
    pass: string[] | undefined;
    sandbox?: Confinement | undefined;
  },
  problems: string[],
) {
  const { harness } = judge;
  const isolated = options.isolated && harness.capabilities.has("isolated");
  if (harness.noTools !== true && !warnedTools.has(harness.id)) {
    warnedTools.add(harness.id);
    console.error(
      `skill-evals: warning: the judge harness ${harness.id} cannot be started with no tools, so the judge, which reads text the agent wrote, keeps its tools; use --sandbox, or a judge harness or judgeApi that has none`,
    );
  }
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
        sandbox: options.sandbox,
      },
      ({ parsed, error, durationMs, home, placed, stoppedBy }) => {
        const foreign = [
          ...foreignOf(harness, parsed.loaded, null),
          ...(harness.strays?.({ home, placed }) ?? []),
        ];
        if (isolated && reportMissing(harness, parsed.loaded)) {
          problems.push("the judge harness did not report what it loaded");
        } else if (isolated && foreign.length > 0) {
          problems.push(
            `the judge loaded outside the subject: ${foreign.join(", ")}`,
          );
        }
        return {
          finalText: parsed.finalText,
          // A judge that the runner stopped at its turn limit has no usable answer: it takes the path of any failed judge
          // session. A judge that timed out already has its timeout as the error.
          error:
            error ??
            (stoppedBy === "maxTurns"
              ? "the judge was stopped at maxTurns"
              : null),
          durationMs,
          tokens: parsed.tokens,
          costUsd: parsed.costUsd,
        };
      },
    );
}
