import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished } from "vitest";
import { scoreSubject } from "./runs.js";
import { sandbox } from "./sandbox.js";

// The target cases of the design: real cases kept in test/target, each played by scripts that stand in for the agent.
export const TARGET = path.resolve(import.meta.dirname, "../../test/target");
export const CASES = path.join(TARGET, "cases");
export const BLINDING =
  /eval|test|judge|experiment|rubric|score|compare|benchmark|candidate|arena/i;

/** What a target script runs with, besides its own name. */
interface Setting {
  /** The subject directory. `$SOURCE_SUBJECT` in the script stands for it. Default: the target subject. */
  subject?: string;
  /** More flags of `score`, such as `--history-mode native`. Default: none. */
  flags?: string[];
  /** The cases directory. Default: the target cases. */
  cases?: string;
  /** The project's config file. Default: none. */
  config?: Record<string, unknown>;
  /** Files to plant in the sandbox, from path to text. Default: none. */
  files?: Record<string, string>;
}

/**
 * Runs one script of a target case, and returns the command's whole result.
 * @param name - The script's file name below `test/target/scripts`, without `.json`; the case is the part before the
 *   first dot.
 * @param setting - The subject, flags, config file and sandbox files; see `Setting`.
 * @returns The exit status, standard error and records of the command.
 */
export function runWith(name: string, setting: Setting = {}) {
  const subject = setting.subject ?? path.join(TARGET, "subject");
  const box = sandbox();
  if (setting.config) box.write("skill-evals.config.json", setting.config);
  for (const [file, text] of Object.entries(setting.files ?? {})) {
    box.write(file, text);
  }
  box.write(
    `fake/scripts/${name}.json`,
    fs
      .readFileSync(path.join(TARGET, "scripts", `${name}.json`), "utf8")
      .replaceAll("$SOURCE_SUBJECT", subject),
  );
  return scoreSubject(box, {
    subject,
    cases: setting.cases ?? CASES,
    only: name.split(".")[0] ?? "",
    flags: setting.flags ?? [],
    // The setup steps run bash and git, which the sandbox's own PATH leaves out.
    env: { PATH: `${String(box.env["PATH"])}:/usr/local/bin:/usr/bin:/bin` },
  });
}

/**
 * Runs one script of a target case against a subject, and returns the command's whole result.
 * @param name - The script's file name, as for `runWith`.
 * @param subject - The subject directory. Default: the target subject.
 * @param flags - More flags of `score`, such as `--history-mode native`. Default: none.
 * @returns The exit status, standard error and records of the command.
 */
export const run = (
  name: string,
  subject = path.join(TARGET, "subject"),
  flags: string[] = [],
) => runWith(name, { subject, flags });

/**
 * Plays one script of a target case against its subject.
 * @param name - The script's file name, as for `run`.
 * @param flags - More flags of `score`, as for `run`. Default: none.
 * @param more - The config file and sandbox files, as for `runWith`. Default: none.
 * @returns The run record.
 */
export async function play(
  name: string,
  flags: string[] = [],
  more: Omit<Setting, "subject" | "flags"> = {},
) {
  const ran = await runWith(name, { ...more, flags });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = ran.records;
  if (!record) throw new Error("no record");
  return record;
}

/**
 * Reads the score of each check of a record.
 * @param record - A run record.
 * @param record.checks - Its checks, each with a score.
 * @returns The scores, in the order of the checks.
 */
export const scores = (record: { checks: { score: number | null }[] }) =>
  record.checks.map(({ score }) => score);

/**
 * Copies the case into a temp cases directory with a build that takes two seconds. The case the agent gets takes
 * eighty and has no way to shorten it; only this copy, which no agent-facing run reads, is quick.
 * @param name - The case's directory name.
 * @returns The temp cases directory.
 */
export function quickCases(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quick-"));
  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(path.join(CASES, name), path.join(root, name), { recursive: true });
  const build = path.join(root, name, "workspace/build.sh");
  fs.writeFileSync(
    build,
    fs.readFileSync(build, "utf8").replace("seconds=80", "seconds=2"),
  );
  return root;
}
