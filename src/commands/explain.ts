import path from "node:path";
import { applicability, askedBy, hostCapabilities } from "../applicability.js";
import type { Applicability } from "../applicability.js";
import type { Case } from "../cases.js";
import { loadWhere } from "../cases.js";
import { withDefaults } from "../check-defaults.js";
import { discover } from "../discover.js";
import { EXIT } from "../exit-codes.js";
import { installedOf } from "../harnesses/index.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { UsageError } from "../scope.js";
import type { Options } from "../usage.js";

const FENCE = "```";
const JSON_INDENT = 2;

/**
 * Finds the cases that an id names: the case itself, or one variant of it.
 * @param casesDir - The cases directory.
 * @param id - A case id, or `<case id>@<variant id>`.
 * @param lenient - Whether a key that a case file does not take is dropped instead of an error.
 * @returns The case, or each of its variants, held-out ones included.
 * @throws {UsageError} When no case has the id; the message lists the ids that exist.
 */
function resolve(casesDir: string, id: string, lenient: boolean): Case[] {
  const base = id.split("@")[0];
  const found = loadWhere(casesDir, (each) => each === base, {
    lenient,
  }).filter((one) => one.id === id || one.base === id);
  if (found.length > 0) return found;
  const known = discover(casesDir)
    .map((one) => one.id)
    .sort();
  throw new UsageError(
    `no case "${id}" in ${casesDir}; cases: ${known.join(", ") || "none"}`,
  );
}

// What `resolved` rewrites: the paths and the checks, which it shows in their own form.
const REWRITTEN = new Set([
  "checks",
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
 * @param casesDir - What the paths are shown relative to.
 * @returns The case with its defaults written out: `timeoutSeconds`, `onTimeout`, the defaults of each check, the
 *   layers of files in the order a run lays them down (shared fixtures, then `workspace/`), the setup steps, and
 *   the capabilities the case and its checks need.
 */
function resolved(one: Case, casesDir: string): object {
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
    checks: one.checks.map(withDefaults),
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
 * @param context.casesDir - The cases directory.
 * @param context.harnesses - The installed harnesses, each with its path.
 * @param context.host - The host capabilities that are present.
 * @returns The section: a heading, the resolved case as JSON, and the harness list.
 */
function section(
  one: Case,
  context: {
    casesDir: string;
    harnesses: ReturnType<typeof installedOf>;
    host: ReturnType<typeof hostCapabilities>;
  },
): string[] {
  const { casesDir, harnesses, host } = context;
  return [
    `## ${one.id}${one.heldout ? " (held out)" : ""}`,
    "",
    `${FENCE}json`,
    JSON.stringify(resolved(one, casesDir), null, JSON_INDENT),
    FENCE,
    "",
    "Applicability, from what each installed harness declares and what is on `PATH`:",
    "",
    ...(harnesses.length === 0
      ? ["- no harness is installed"]
      : harnesses.map(({ harness, bin }) =>
          line(`${harness.id} (${bin})`, applicability(harness, one, host)),
        )),
    "",
  ];
}

/**
 * The `explain` command: prints a case as a run reads it, as JSON in Markdown. It starts no harness: what is
 * installed comes from a lookup on `PATH`.
 * @param options - The command line's options: `cases` and `lenient`.
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
  const cases = resolve(merged.cases, id, merged.lenient ?? false);
  const context = {
    casesDir: merged.cases,
    harnesses: installedOf(),
    host: hostCapabilities(cases),
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
