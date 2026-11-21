import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, plugin, script, skillsFolder } from "./plant.js";
import { readResults, sandbox, seenBy } from "./sandbox.js";

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

test("a script's calls reach the run record in order", async () => {
  const box = sandbox();
  script(box, "calls", {
    turns: [
      [
        { text: "looking" },
        { call: { name: "Bash", input: { command: "ls" }, output: "a.txt" } },
        { call: { name: "Edit", input: { file_path: "a.txt" } } },
        { final: "done" },
      ],
    ],
  });
  const { records } = await scored(box, [
    { type: "output_contains", text: "done" },
  ]);
  expect(records[0]?.toolCalls.map((call) => call.name)).toEqual([
    "Bash",
    "Edit",
  ]);
  expect(records[0]?.finalText).toBe("done");
});

test("an exec call runs the command in the workspace", async () => {
  const box = sandbox();
  script(box, "exec", {
    turns: [
      [
        {
          call: {
            name: "Bash",
            input: { command: "cat notes.txt" },
            exec: true,
          },
        },
        {
          call: {
            name: "Write",
            input: { file_path: "made.txt" },
            write: { path: "made.txt", content: "made\n" },
          },
        },
      ],
    ],
  });
  const { outDir } = await scored(box, [
    { type: "file_exists", path: "made.txt" },
  ]);
  const events = eventsOf(outDir);
  const results = events
    .filter((event) => event.type === "user")
    .map((event) => JSON.stringify(event));
  expect(results[0]).toContain("planted");
  const ids = events
    .filter((event) => event.type === "assistant")
    .map((event) => JSON.stringify(event).match(/toolu_\w+/)?.[0]);
  expect(new Set(ids).size).toBe(2);
  expect(JSON.stringify(events)).toContain(`"tool_use_id":"${ids[0] ?? ""}"`);
});

test("parallel calls share one message and an agent's steps name their parent", async () => {
  const box = sandbox();
  script(box, "shapes", {
    init: { model: "scripted" },
    turns: [
      [
        {
          parallel: [
            { call: { name: "Read", input: { file_path: "a" } } },
            { call: { name: "Read", input: { file_path: "b" } } },
          ],
        },
        {
          agent: {
            type: "explore",
            prompt: "look",
            steps: [{ call: { name: "Grep", input: { pattern: "x" } } }],
          },
        },
        {
          hook: { event: "Stop", command: "check.sh", exit: 2, context: "no" },
        },
      ],
    ],
  });
  const { outDir, records } = await scored(box, [
    { type: "tool_called", name: "^Grep$" },
  ]);
  expect(records[0]?.toolCalls.map((call) => call.name)).toEqual([
    "Read",
    "Read",
    "Agent",
    "Grep",
  ]);
  const events = eventsOf(outDir);
  const assistants = events.filter((event) => event.type === "assistant");
  expect(assistants[0]?.message?.content).toHaveLength(2);
  const agent = assistants[1]?.message?.content[0];
  expect(agent?.name).toBe("Agent");
  expect(assistants[2]?.parent_tool_use_id).toBe(agent?.id);
  expect(events[0]?.model).toBe("scripted");
  expect(events.some((event) => event.subtype === "hook_response")).toBe(true);
});

test("a fail step ends the run with an error", async () => {
  const box = sandbox();
  script(box, "fail", { turns: [[{ fail: "boom" }]] });
  const cases = plantCase(box, [{ type: "output_contains", text: "x" }]);
  const outDir = path.join(box.root, "results");
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  await box.cli([
    "score",
    "--subject",
    subject,
    "--cases",
    cases,
    "--out",
    outDir,
  ]);
  const [record] = readResults(outDir).records;
  expect(record?.ok).toBe(false);
  expect(record?.error).toContain("boom");
});

test("a run with no matching script behaves as before", async () => {
  const box = sandbox();
  script(box, "other", {
    match: { prompt: "never said" },
    turns: [[{ final: "scripted" }]],
  });
  const { records } = await scored(box, [
    { type: "output_contains", text: "Seen" },
  ]);
  expect(seenBy(records[0]?.finalText ?? "").seed).toBe("planted");
});

test("match.plugin selects the arm", async () => {
  const box = sandbox();
  script(box, "a-plain", {
    match: { plugin: false },
    turns: [[{ final: "plain arm" }]],
  });
  script(box, "b-plugin", {
    match: { plugin: true },
    turns: [[{ final: "plugin arm" }]],
  });
  const loaded = plugin(box, "loaded", {});
  const outDir = path.join(box.root, "results");
  const cases = plantCase(box, [{ type: "output_contains", text: "arm" }]);
  const result = await box.cli([
    "run",
    "--a",
    "none",
    "--b",
    loaded,
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    outDir,
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(readResults(outDir).records.map((record) => record.finalText)).toEqual(
    ["plain arm", "plugin arm"],
  );
});
