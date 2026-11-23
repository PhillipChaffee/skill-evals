import path from "node:path";
import {
  applicabilityUnder,
  askedBy,
  hostCapabilities,
} from "../applicability.js";
import { requireHistoryMode } from "../evaluate-setup.js";
import type { HistoryMode } from "../history-types.js";
import type { Applicability } from "../applicability.js";
import type { Case } from "../cases.js";
import { loadWhere } from "../cases.js";
import { CHECKS } from "../checks/index.js";
import { withDefaults } from "../checks/defaults.js";
import { discover } from "../discover.js";
import { EXIT } from "../exit-codes.js";
import { installedOf } from "../harnesses/index.js";
import type { Project } from "../project.js";
import type { CaseRoot } from "../case-roots.js";
import { dirsOf, prefixOf, rootsOf } from "../case-roots.js";
import { withConfig } from "../project.js";
import { UsageError } from "../scope.js";
import type { Options } from "../usage.js";

const FENCE = "```";
const JSON_INDENT = 2;

/**
 * Finds the cases that an id names: the case itself, or one variant of it.
 * @param roots - The cases directories; with more than one, an id starts with its directory's name.
 * @param id - A case id, or `<case id>@<variant id>`.
 * @param lenient - Whether a key that a case file does not take is dropped instead of an error.
 * @returns The case, or each of its variants, held-out ones included.
 * @throws {UsageError} When no case has the id; the message lists the ids that exist.
 */
function resolve(roots: CaseRoot[], id: string, lenient: boolean): Case[] {
  const base = id.split("@")[0];
  const found = roots
    .flatMap((root) =>
      loadWhere(root.dir, (each) => each === base, {
        lenient,
        prefix: prefixOf(root, roots),
        heldout: root.heldout,
      }),
    )
    .filter((one) => one.id === id || one.base === id);
  if (found.length > 0) return found;
  const known = roots
    .flatMap((root) => discover(root.dir, prefixOf(root, roots)?.split("/")))
    .map((one) => one.id)
    .sort();
  throw new UsageError(
    `no case "${id}" in ${dirsOf(roots).join(", ")}; cases: ${known.join(", ") || "none"}`,
  );
}

// What `resolved` rewrites: the paths and the checks, which it shows in their own form.
const REWRITTEN = new Set([
  "checks",
  "preconditions",
  "fixtureDirs",
  "workspaceDir",
  "fixtureDir",
  "graderDir",
  "homeDir",
  "dir",
]);

/**
 * Builds the object that `explain` prints for one case: every setting as a run will read it.
 * @param one - The case, as loaded.
 * @param casesDirs - The cases directories; the paths are shown relative to the one that holds the case.
 * @returns The case with its defaults written out: `timeoutSeconds`, `onTimeout`, the defaults of each check, the
 *   layers of files in the order a run lays them down (shared fixtures, then `workspace/`), the setup steps, and
 *   the capabilities the case and its checks need.
 */
function resolved(one: Case, casesDirs: string[]): object {
  const casesDir = casesDirs.find((dir) => one.dir?.startsWith(dir)) ?? "";
  const shown = (dir: string): string =>
    path.relative(casesDir, dir).split(path.sep).join("/");
  const orNull = (dir: string | null): string | null =>
    dir === null ? null : shown(dir);
  return {
    ...Object.fromEntries(
      Object.entries(one).filter(([key]) => !REWRITTEN.has(key)),
    ),
    onTimeout: one.onTimeout ?? "invalid",
    files: {
      layers: [
        ...one.fixtureDirs.map((dir) => ({
          layer: "fixture",
          path: shown(dir),
        })),
        ...(one.workspaceDir === null
          ? []
          : [{ layer: "workspace", path: shown(one.workspaceDir) }]),
      ],
      setupFixture: orNull(one.fixtureDir),
      home: orNull(one.homeDir),
      grader: orNull(one.graderDir),
    },
    requiredCapabilities: [...new Set(askedBy([one]))],
    checks: one.checks.map((check) => withDefaults(check, CHECKS[check.type])),
    ...(one.preconditions && {
      preconditions: one.preconditions.map((check) =>
        withDefaults(check, CHECKS[check.type]),
      ),
    }),
    turns:
      one.turns?.map((turn) => ({
        ...turn,
        checks: turn.checks.map((check) =>
          withDefaults(check, CHECKS[check.type]),
        ),
      })) ?? null,
  };
}

/**
 * Says whether one installed harness runs a case, from what it declares and what is on `PATH`.
 * @param name - The harness's id and where it is installed.
 * @param verdict - What `applicability` said.
 * @returns One line of the list.
 */
function line(name: string, verdict: Applicability): string {
  if (!verdict.applicable)
    return `- ${name}: not applicable, ${verdict.reason}`;
  const skipped =
    verdict.skipped.length === 0
      ? ""
      : `, skipping checks ${verdict.skipped.map((index) => `#${String(index + 1)}`).join(", ")}`;
  return `- ${name}: applicable${skipped}`;
}

/**
 * Renders one case as Markdown.
 * @param one - The case.
 * @param context - Where the paths are shown from, and what is installed.
 * @param context.casesDirs - The cases directories.
 * @param context.harnesses - The installed harnesses, each with its path.
 * @param context.host - The host capabilities that are present.
 * @param context.forced - The `historyMode` of the config or flag; undefined leaves each harness its own.
 * @returns The section: a heading, the resolved case as JSON, and the harness list.
 */
function section(
  one: Case,
  context: {
    casesDirs: string[];
    harnesses: ReturnType<typeof installedOf>;
    host: ReturnType<typeof hostCapabilities>;
    forced: HistoryMode | undefined;
  },
): string[] {
  const { casesDirs, harnesses, host } = context;
  return [
    `## ${one.id}${one.heldout ? " (held out)" : ""}`,
    "",
    `${FENCE}json`,
    JSON.stringify(resolved(one, casesDirs), null, JSON_INDENT),
    FENCE,
    "",
    "Applicability, from what each installed harness declares and what is on `PATH`:",
    "",
    ...(harnesses.length === 0
      ? ["- no harness is installed"]
      : harnesses.map(({ harness, bin }) =>
          line(
            `${harness.id} (${bin})`,
            applicabilityUnder(harness, one, { host, forced: context.forced }),
          ),
        )),
    "",
  ];
}

/**
 * The `explain` command: prints a case as a run reads it, as JSON in Markdown. It starts no harness: what is
 * installed comes from a lookup on `PATH`.
 * @param options - The command line's options: `cases`, `heldoutCases` and `lenient`.
 * @param project - Where the config file and the default cases directory are.
 * @param args - The case id, or `<case id>@<variant id>`.
 * @returns The exit code, always 0; a fault throws.
 * @throws {UsageError} For an id that names no case.
 */
export function explain(
  options: Options,
  project: Project,
  args: string[],
): number {
  const id = String(args[0]);
  const merged = withConfig(project, options);
  const roots = rootsOf(merged);
  const cases = resolve(roots, id, merged.lenient ?? false);
  const context = {
    casesDirs: dirsOf(roots),
    harnesses: installedOf(),
    host: hostCapabilities(cases),
    forced: requireHistoryMode(merged),
  };
  console.log(
    [
      `# ${id}`,
      "",
      ...(cases.every((one) => one.variant === null)
        ? []
        : [
            `${String(cases.length)} variants: ${cases.map((one) => `\`${one.id}\``).join(", ")}`,
            "",
          ]),
      ...cases.flatMap((one) => section(one, context)),
    ].join("\n"),
  );
  return EXIT.ok;
}
