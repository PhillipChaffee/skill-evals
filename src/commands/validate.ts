import { blindingNotes } from "../blinding-notes.js";
import { scanCases } from "../blinding-case.js";
import { deepLints } from "../blinding-deep.js";
import { DEFAULT_BLINDING_WORDS } from "../blinding.js";
import { QUESTION_CHECKS } from "../question.js";
import { allChecks } from "../case-checks.js";
import { applicabilityUnder, hostCapabilities } from "../applicability.js";
import { requireHistoryMode } from "../evaluate-setup.js";
import type { HistoryMode } from "../history-types.js";
import { EXIT } from "../exit-codes.js";
import type { Case } from "../cases.js";
import { scopeTest } from "../checks/tree.js";
import { exclusionsOf } from "../exclusions.js";
import { installedOf } from "../harnesses/index.js";
import type { Located } from "../harnesses/index.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { loadSelection, selectionOf } from "../select.js";
import { UsageError } from "../scope.js";
import { snapshot } from "../snapshot.js";
import { resolveSubject } from "../subject.js";
import { rulesClashes } from "../rules-clash.js";
import type { Subject } from "../subject.js";
import type { Options } from "../usage.js";

/** One thing `validate` has to say about a suite. */
export interface Lint {
  /** A problem makes the command exit 2; a warning does not. */
  level: "problem" | "warning";
  /** The case's id, or the cases directory for a fault of the suite as a whole. */
  caseId: string;
  text: string;
}

/** What a lint may look at besides the cases. */
export interface LintContext {
  /** The subject whose skills the cases name; `kind` is "none" when no skill names can be checked, and null when it could not be resolved (already a problem). */
  subject: Subject | null;
  /** Every harness that is installed on this machine. */
  harnesses: Located[];
  project: Project;
  /** The absolute path of the cases directory. */
  casesDir: string;
  /** The share of a case's weight that judge and decision checks may carry before a warning. Default: 0.5. */
  maxJudgedWeightShare?: number;
  /** The `historyMode` of the config or `--history-mode`; undefined leaves each harness its own. */
  historyMode?: HistoryMode | undefined;
  /** The config's `blindingWords`; absent: `DEFAULT_BLINDING_WORDS`. */
  blindingWords?: string[] | undefined;
}

/** A check of the loaded cases. */
export type LintRule = (cases: Case[], context: LintContext) => Lint[];

// The check types that may name a skill the subject does not have: they pass when it is absent.
const MAY_NAME_ABSENT = new Set(["skill_not_loaded", "skill_not_available"]);

/**
 * Warns about names of skills that the subject does not have, and, for the baseline subject, that none was checked.
 * @param cases - The loaded cases.
 * @param context - The subject.
 * @returns One warning for each `targets` entry and each check `skill` that is not a skill of the subject, except on
 *   the checks that expect a skill to be absent; for the subject "none", one line saying names were not checked.
 */
function skillNames(cases: Case[], context: LintContext): Lint[] {
  const { subject, casesDir } = context;
  if (subject === null || subject.kind === "none") {
    const why = subject ? "the subject is none" : "the subject did not resolve";
    return [
      {
        level: "warning",
        caseId: casesDir,
        text: `${why}, so skill names were not checked`,
      },
    ];
  }
  const known = `skills of the subject: ${subject.skills.join(", ") || "none"}`;
  const unknown = (name: string): boolean => !subject.skills.includes(name);
  const why = (name: string): string =>
    name.includes(":")
      ? `"${name}" is plugin-prefixed; checks name skills without the plugin prefix`
      : `names the skill "${name}", which is not a skill of the subject (${known})`;
  return cases.flatMap((one) => [
    ...one.targets.filter(unknown).map((name): Lint => ({
      level: "warning",
      caseId: one.id,
      text: `targets names "${name}", which is not a skill of the subject (${known})`,
    })),
    ...allChecks(one).flatMap((check) =>
      check.skill !== undefined &&
      !MAY_NAME_ABSENT.has(check.type) &&
      unknown(check.skill)
        ? [
            {
              level: "warning",
              caseId: one.id,
              text: `a ${check.type} check ${why(check.skill)}`,
            } satisfies Lint,
          ]
        : [],
    ),
  ]);
}

/**
 * Warns about the cases that an installed harness would not run.
 * @param cases - The loaded cases.
 * @param context - The installed harnesses.
 * @returns One warning for each harness and case that is not applicable there, with what is missing.
 */
function notApplicable(cases: Case[], context: LintContext): Lint[] {
  const host = hostCapabilities(cases);
  return context.harnesses.flatMap(({ harness }) =>
    cases.flatMap((one): Lint[] => {
      const verdict = applicabilityUnder(harness, one, {
        host,
        forced: context.historyMode,
      });
      return verdict.applicable
        ? []
        : [
            {
              level: "warning",
              caseId: one.id,
              text: `not applicable on ${harness.id}: ${verdict.reason}`,
            },
          ];
    }),
  );
}

/**
 * Warns about reply turns that nothing checks the question of.
 * @param cases - The loaded cases.
 * @returns One warning for each reply turn of a case that has no `asked_user` or `ended_awaiting_user` check at case
 *   level or on an earlier turn: the reply may be skipped as "not asked" with nothing to say the agent should have asked.
 */
function unwatchedReplies(cases: Case[]): Lint[] {
  const asks = (check: { type: string }): boolean =>
    QUESTION_CHECKS.has(check.type);
  return cases.flatMap((one) =>
    (one.turns ?? []).flatMap((turn, index): Lint[] => {
      const earlier = (one.turns ?? []).slice(0, index);
      return "reply" in turn &&
        !one.checks.some(asks) &&
        !earlier.some(({ checks }) => checks.some(asks))
        ? [
            {
              level: "warning",
              caseId: one.id,
              text: `turn ${String(index + 1)} is a reply, and no asked_user or ended_awaiting_user check at case level or on an earlier turn says that the agent should ask: if it does not, the reply is skipped and its checks are not scored`,
            },
          ]
        : [];
    }),
  );
}

/**
 * Warns about `file_unchanged` checks that protect nothing.
 * @param cases - The loaded cases.
 * @returns One warning for each `file_unchanged` check on the workspace whose path or glob matches no file of the
 *   case's `workspace/` folder: it can only fail when the agent creates a file there. A case with no `workspace/` is
 *   left out, because a later setup step may fill it.
 */
function vacuousUnchanged(cases: Case[]): Lint[] {
  return cases.flatMap((one) => {
    if (one.workspaceDir === null) return [];
    const seed = snapshot(one.workspaceDir);
    return one.checks.flatMap((check): Lint[] => {
      if (check.type !== "file_unchanged" || check.root === "home") return [];
      const test = scopeTest(check.path ?? "", seed);
      return [...seed.keys()].some(test)
        ? []
        : [
            {
              level: "warning",
              caseId: one.id,
              text: `a file_unchanged check on "${check.path ?? ""}" matches no file of the case's workspace, so it protects nothing: it fails only if the agent creates a file there`,
            },
          ];
    });
  });
}

const OUTSIDE = /^(\/|\.\.([\\/]|$))/;

/**
 * Warns about `files` globs of a judge or decision check that start outside the workspace.
 * @param cases - The loaded cases.
 * @returns One warning for each such glob: it can never match, so the model is told that no file matches.
 */
function filesOutside(cases: Case[]): Lint[] {
  return cases.flatMap((one) =>
    one.checks.flatMap((check) =>
      (check.files ?? [])
        .filter((glob) => OUTSIDE.test(glob))
        .map((glob): Lint => ({
          level: "warning",
          caseId: one.id,
          text: `a ${check.type} check lists the file "${glob}", which starts outside the workspace and can never match`,
        })),
    ),
  );
}

const DEFAULT_JUDGED_SHARE = 0.5;
const PERCENT = 100;

/**
 * Warns about cases that a model scores for most of their weight.
 * @param cases - The loaded cases.
 * @param context - The limit, `maxJudgedWeightShare`.
 * @returns One warning for each case whose judge and decision checks carry more than the limit of its total check weight.
 */
function judgedShare(cases: Case[], context: LintContext): Lint[] {
  const limit = context.maxJudgedWeightShare ?? DEFAULT_JUDGED_SHARE;
  return cases.flatMap((one): Lint[] => {
    const total = allChecks(one).reduce((sum, { weight }) => sum + weight, 0);
    const judged = one.checks
      .filter(({ type }) => type === "judge" || type === "decision")
      .reduce((sum, { weight }) => sum + weight, 0);
    const share = judged / total;
    const percent = (value: number): string =>
      `${String(Math.round(value * PERCENT))}%`;
    return share > limit
      ? [
          {
            level: "warning",
            caseId: one.id,
            text: `judge and decision checks carry ${percent(share)} of the case's weight, above the limit of ${percent(limit)} (maxJudgedWeightShare)`,
          },
        ]
      : [];
  });
}

/**
 * Reports the files of a case that the subject's rules would be installed over, for each installed harness.
 * @param cases - The loaded cases.
 * @param context - The subject and the installed harnesses.
 * @returns One problem for each clash, as `score` and `plan` refuse it before a run.
 */
function rulesClash(cases: Case[], context: LintContext): Lint[] {
  if (context.subject === null) return [];
  return rulesClashes(
    context.harnesses.map(({ harness }) => ({ harness, cases })),
    [context.subject],
  ).map(({ caseId, text }): Lint => ({ level: "problem", caseId, text }));
}

/**
 * Warns about words that tell the agent it is being evaluated, in what it reads from the case.
 * @param cases - The loaded cases.
 * @param context - The config's `blindingWords`.
 * @returns One warning for each word in each place: prompts, turns, history, mock servers and paths. A case's
 *   `x-unblinded` silences its listed words.
 */
const blinding = (cases: Case[], context: LintContext): Lint[] => {
  const words = context.blindingWords ?? DEFAULT_BLINDING_WORDS;
  return [...blindingNotes({ ...context, words }), ...scanCases(cases, words)];
};

/**
 * Every lint, in the order its lines are written. A later task adds a lint by appending a function here.
 */
export const LINTS: LintRule[] = [
  skillNames,
  notApplicable,
  vacuousUnchanged,
  unwatchedReplies,
  judgedShare,
  filesOutside,
  rulesClash,
  blinding,
];

const line = ({ level, caseId, text }: Lint): string =>
  `${level} ${caseId}: ${text}`;

/**
 * Runs every lint on the loaded cases, and the deep scan of the setup paths when `--deep` is set.
 * @param cases - The loaded cases.
 * @param given - The resolved subject, the project, and the options after the config file was applied.
 * @param given.subject - The subject, or null when it did not resolve.
 * @param given.project - Where the config file and the default cases directory are.
 * @param given.options - The options of the command, with the config's `blindingWords`, `deep` and the limits.
 * @returns What the lints found.
 */
async function lintsOf(
  cases: Case[],
  given: {
    subject: Subject | null;
    project: Project;
    options: ReturnType<typeof withConfig<Options>>;
  },
): Promise<Lint[]> {
  const { subject, project, options } = given;
  const context: LintContext = {
    subject,
    harnesses: installedOf(),
    project,
    casesDir: options.cases,
    historyMode: requireHistoryMode(options),
    blindingWords: options.blindingWords,
    ...(options.maxJudgedWeightShare === undefined
      ? {}
      : { maxJudgedWeightShare: options.maxJudgedWeightShare }),
  };
  return [
    ...LINTS.flatMap((lint) => lint(cases, context)),
    ...(options.deep === true
      ? await deepLints(cases, options.blindingWords ?? DEFAULT_BLINDING_WORDS)
      : []),
  ];
}

/**
 * Checks a suite without running it, and prints every problem and warning at once. No harness is started and no model
 * is called.
 * @param given - The options of the command line: `subject`, `cases`, `lenient`, `deep`, `heldout` and the selection.
 * @param project - Where the config file and the default cases directory are.
 * @returns The exit code: 2 when any case does not load or a lint finds a problem, else 0. A blinding word is a warning;
 *   an `x-unblinded` without a `why` does not load.
 */
export async function validate(
  given: Options,
  project: Project,
): Promise<number> {
  const options = withConfig(project, given);
  const casesDir = options.cases;
  const found: Lint[] = [];
  const problem = (caseId: string, text: string): void => {
    found.push({ level: "problem", caseId, text });
  };
  const cases = loadSelection(casesDir, selectionOf(options), {
    lenient: options.lenient ?? false,
    onError: problem,
    onWarning: (text, caseId) => {
      found.push({ level: "warning", caseId, text });
    },
  });
  const spec = options.subject ?? project.root;
  let subject: Subject | null = null;
  try {
    subject = resolveSubject("subject", spec, {
      ...project,
      left: exclusionsOf(options, project.cwd),
      rules: {
        rules: options.rules,
        instructionFile: options.instructionFile,
      },
    });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    problem(spec, error.message);
  }
  try {
    found.push(...(await lintsOf(cases, { subject, project, options })));
  } finally {
    subject?.dispose();
  }
  const problems = found.filter(({ level }) => level === "problem");
  const warnings = found.filter(({ level }) => level === "warning");
  console.log(
    [
      ...[...problems, ...warnings].map(line),
      `${String(cases.length)} cases, ${String(problems.length)} problems, ${String(warnings.length)} warnings`,
    ].join("\n"),
  );
  return problems.length > 0 ? EXIT.usage : EXIT.ok;
}
