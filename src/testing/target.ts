import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { scoreSubject } from "./runs.js";
import { sandbox } from "./sandbox.js";

// The target cases of the design: real cases kept in test/target, each played by scripts that stand in for the agent.
export const TARGET = path.resolve(import.meta.dirname, "../../test/target");
export const CASES = path.join(TARGET, "cases");
export const BLINDING =
  /eval|test|judge|experiment|rubric|score|compare|benchmark|candidate|arena/i;

/**
 * Plays one script of a target case against its subject.
 * @param name - The script's file name below `test/target/scripts`, without `.json`; the case is the part before the
 *   first dot.
 * @returns The run record.
 */
export async function play(name: string) {
  const box = sandbox();
  box.write(
    `fake/scripts/${name}.json`,
    fs.readFileSync(path.join(TARGET, "scripts", `${name}.json`), "utf8"),
  );
  const ran = await scoreSubject(box, {
    subject: path.join(TARGET, "subject"),
    cases: CASES,
    only: name.split(".")[0] ?? "",
    // The setup steps run bash and git, which the sandbox's own PATH leaves out.
    env: { PATH: `${String(box.env["PATH"])}:/usr/local/bin:/usr/bin:/bin` },
  });
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
