import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, script, skillsFolder } from "./plant.js";
import { readResults, sandbox } from "./sandbox.js";

/** The fields of a stream event that these tests read. */
interface Event {
  type: string;
  subtype?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  message?: { content: { id: string; name: string }[] };
}

/**
 * Reads the stream the run kept.
 * @param outDir - The output directory of the command.
 * @returns Its events, in order.
 */
const eventsOf = (outDir: string): Event[] =>
  fs
    .readFileSync(
      path.join(outDir, "claude-code/restate/subject1.stream.jsonl"),
      "utf8",
    )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);

/**
 * Scores the planted case once, with a skills folder as the subject.
 * @param box - The sandbox with the scripts already written.
 * @param checks - The checks of the case.
 * @returns The results, and where the run's files are.
 */
async function scored(box: ReturnType<typeof sandbox>, checks: unknown) {
  const cases = plantCase(box, checks);
  const outDir = path.join(box.root, "results");
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  const result = await box.cli([
    "score",
    "--subject",
    subject,
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    outDir,
  ]);
  expect(result.status, result.stderr).toBe(0);
  return { records: readResults(outDir).records, outDir };
}

test("parallel dispatches share one message, and each child names its own dispatch as its parent", async () => {
  const box = sandbox();
  script(box, "pair", {
    turns: [
      [
        {
          parallel: [
            {
              agent: {
                type: "researcher",
                prompt: "a",
                model: "opus",
                steps: [{ call: { name: "Read", input: { file_path: "a" } } }],
              },
            },
            {
              agent: {
                type: "researcher",
                prompt: "b",
                steps: [{ call: { name: "Read", input: { file_path: "b" } } }],
              },
            },
          ],
        },
      ],
    ],
  });
  const { outDir } = await scored(box, [
    { type: "output_contains", text: "x" },
  ]);
  const events = eventsOf(outDir);
  const dispatches = events.filter(
    (event) =>
      event.type === "assistant" &&
      event.message?.content.some((block) => block.name === "Agent"),
  );
  expect(dispatches).toHaveLength(1);
  const ids = (dispatches[0]?.message?.content ?? []).map((block) => block.id);
  expect(ids).toHaveLength(2);
  const children = events
    .filter((event) => event.parent_tool_use_id)
    .map((event) => event.parent_tool_use_id);
  expect(new Set(children)).toEqual(new Set(ids));
  expect(JSON.stringify(dispatches[0])).toContain('"model":"opus"');
});
