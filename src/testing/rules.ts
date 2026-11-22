import { onTestFinished } from "vitest";
import claudeCode from "../harnesses/claude-code.js";
import { HARNESSES } from "../harnesses/index.js";
import type { Harness, RulesTarget } from "../harnesses/shared.js";
import { placeRules } from "../harnesses/rules.js";
import type { RulesFile } from "../harnesses/rules.js";
import fs from "node:fs";
import path from "node:path";
import { plantCase, skillsFolder } from "./plant.js";
import type { Sandbox } from "./sandbox.js";
import { readResults } from "./sandbox.js";

/**
 * Claude Code as a harness that also reports the rules it loaded. Claude Code's stream states no loaded rule, so the
 * real adapter's `reportedLoaded` is null; the fake harness states them in a `rules_loaded` event when its sandbox has
 * `report-rules`, and this test-only adapter reads that event. It is never exported from the package and is not in the
 * list of harnesses.
 */
export const reportingRules: Harness = {
  ...claudeCode,
  parse(stdout) {
    const parsed = claudeCode.parse(stdout);
    const reported = stdout
      .split("\n")
      .filter((line) => line.includes('"rules_loaded"'))
      .flatMap(
        (line) =>
          (JSON.parse(line) as { rules: { path: string; text: string }[] })
            .rules,
      );
    return reported.length === 0
      ? parsed
      : {
          ...parsed,
          loaded: {
            ...parsed.loaded,
            rules: reported.map((rule) => rule.path),
            ruleTexts: reported.map((rule) => rule.text),
          },
        };
  },
};

/**
 * Says where `workspaceRules` puts a rule: a directory of the workspace, which a case can have a file in.
 * @param files - The rule files and the instruction file.
 * @returns One place for each file.
 */
const inWorkspace = (files: RulesFile[]): RulesTarget[] =>
  files.map((file) => ({
    root: "workspace",
    path: `.agent-rules/${file.relative}`,
  }));

/** `reportingRules`, installing into the workspace, so that a case's own file can clash with a rule. */
export const workspaceRules: Harness = {
  ...reportingRules,
  rulesTargets: inWorkspace,
  installRules: (files, input) => placeRules(files, inWorkspace(files), input),
};

/**
 * Puts a test-only harness in the place of Claude Code in the list of harnesses until the test ends, so that the
 * command line runs it.
 * @param harness - The harness to run in its place.
 */
export function installInPlaceOfClaude(harness: Harness): void {
  const place = HARNESSES.findIndex(({ id }) => id === claudeCode.id);
  const before = HARNESSES[place] as Harness;
  HARNESSES[place] = harness;
  onTestFinished(() => {
    HARNESSES[place] = before;
  });
}

/**
 * Writes a skills folder that holds rules, and the config file that names them.
 * @param box - The sandbox.
 * @param rules - Rule file name to its text, written under `rules/` of the subject.
 * @param instruction - The text of an instruction file, `AGENTS.md`, or undefined for none.
 * @returns The subject directory.
 */
export function ruledSubject(
  box: Sandbox,
  rules: Record<string, string>,
  instruction?: string,
): string {
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  for (const [name, text] of Object.entries(rules)) {
    box.write(`skills/rules/${name}`, text);
  }
  if (instruction !== undefined) box.write("skills/AGENTS.md", instruction);
  box.write("skill-evals.config.json", {
    rules: "rules",
    ...(instruction === undefined ? {} : { instructionFile: "AGENTS.md" }),
  });
  return subject;
}

/**
 * Writes a skills folder with one skill and no rules.
 * @param box - The sandbox.
 * @returns The subject directory.
 */
export const plainSubject = (box: Sandbox): string =>
  skillsFolder(box, "skills", { bro: "# bro\n" });

/** One case to plant and score. */
interface Planted {
  checks: unknown;
  /** Other keys of the case file, such as `preconditions`. */
  more?: Record<string, unknown>;
}

/**
 * Plants one case, scores it once with the fake harness, and reads the records.
 * @param box - The sandbox, with its scripts already written.
 * @param subject - The subject directory.
 * @param planted - The case's checks and other keys.
 * @returns The command's result, and the run records; none when the command wrote no results.
 */
export async function scoredCase(
  box: Sandbox,
  subject: string,
  planted: Planted,
) {
  const cases = plantCase(box, planted.checks, planted.more ?? {});
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", subject, "--cases", cases],
    ...["--reps", "1", "--out", out],
  ]);
  const records = fs.existsSync(path.join(out, "results.json"))
    ? readResults(out).records
    : [];
  return { ran, records, record: records[0] };
}
