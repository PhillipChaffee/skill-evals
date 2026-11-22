import { applicability, hostCapabilities } from "../applicability.js";
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
    ...one.checks.flatMap((check) =>
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
      const verdict = applicability(harness, one, host);
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
    const total = one.checks.reduce((sum, { weight }) => sum + weight, 0);
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
 * Every lint, in the order its lines are written. A later task adds a lint by appending a function here.
 */
export const LINTS: LintRule[] = [
  skillNames,
  notApplicable,
  vacuousUnchanged,
  judgedShare,
  filesOutside,
];

const line = ({ level, caseId, text }: Lint): string =>
  `${level} ${caseId}: ${text}`;

/**
 * Checks a suite without running it, and prints every problem and warning at once. No harness is started and no model
 * is called.
 * @param given - The options of the command line: `subject`, `cases`, `lenient`, `heldout` and the selection.
 * @param project - Where the config file and the default cases directory are.
 * @returns The exit code: 2 when any case does not load or a lint finds a problem, else 0.
 */
export function validate(given: Options, project: Project): number {
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
    });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    problem(spec, error.message);
  }
  try {
    const harnesses = installedOf();
    const context: LintContext = {
      subject,
      harnesses,
      project,
      casesDir,
      ...(options.maxJudgedWeightShare === undefined
        ? {}
        : { maxJudgedWeightShare: options.maxJudgedWeightShare }),
    };
    for (const lint of LINTS) found.push(...lint(cases, context));
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
