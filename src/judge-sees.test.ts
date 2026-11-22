import { expect, test } from "vitest";
import { CONFIG_FILE } from "./project.js";
import { decisionServer, yesNo } from "./testing/decision-server.js";
import { SCORE_ONE, judgedWith } from "./testing/judged.js";
import { plantCase, plugin, script } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";

const RAN = "Ran a command.";
const TRANSCRIPT = "transcript";

const SCRIPTED = {
  turns: [
    [
      { call: { name: "Bash", input: { command: "echo hi" }, exec: true } },
      {
        call: {
          name: "Edit",
          input: { file_path: "notes.txt" },
          write: { path: "notes.txt", content: "fixed\n" },
        },
      },
      { final: "It is fixed now." },
    ],
  ],
};

test("sees transcript puts tool calls in the judge prompt", async () => {
  const { ran, prompts } = await judgedWith(
    { rubric: RAN, sees: ["final", "transcript"] },
    [SCORE_ONE],
    { plant: (box) => script(box, "agent", SCRIPTED) },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const [prompt] = prompts;
  expect(prompt).toContain(`<${TRANSCRIPT}>`);
  expect(prompt).toMatch(/assistant tool_call: Bash \{"command":"echo hi"\}/);
  expect(prompt).toMatch(/tool tool_result: hi/);
  expect(prompt).toContain("<answer>\nIt is fixed now.\n</answer>");
});

test("sees without final leaves the answer section out", async () => {
  const { prompts } = await judgedWith(
    { rubric: RAN, sees: [TRANSCRIPT] },
    [SCORE_ONE],
    { plant: (box) => script(box, "agent", SCRIPTED) },
  );
  expect(prompts[0]).toContain("<transcript>");
  expect(prompts[0]).not.toContain("<answer>");
});

test("sees files includes the named file and not others", async () => {
  const { prompts, ran } = await judgedWith(
    { rubric: "Wrote it.", sees: ["final", "files"], files: ["notes.txt"] },
    [SCORE_ONE],
    {
      plant: (box) => box.write("cases/restate/workspace/other.txt", "hidden"),
    },
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(prompts[0]).toContain('<file path="notes.txt">\nplanted\n\n</file>');
  expect(prompts[0]).not.toContain("other.txt");
});

test("sees files with no match says so and the check still runs", async () => {
  const { prompts, check } = await judgedWith(
    { rubric: "r", sees: ["files"], files: ["none/*.md"] },
    ['{"score": 0.5}'],
  );
  expect(prompts[0]).toContain("No file matches: none/*.md");
  expect(check?.score).toBe(0.5);
});

test("a rendering over maxChars says what it left out", async () => {
  const many = {
    turns: [
      [
        ...Array.from({ length: 12 }, (_, at) => ({
          call: {
            name: "Bash",
            input: { command: `echo ${String(at)}` },
            output: `out${String(at)}-${"z".repeat(600)}`,
          },
        })),
        { final: "done" },
      ],
    ],
  };
  const { prompts } = await judgedWith(
    { rubric: "r", sees: [TRANSCRIPT], maxChars: 2500 },
    [SCORE_ONE],
    { plant: (box) => script(box, "agent", many) },
  );
  expect(prompts[0]).toMatch(/\[… \d+ tool outputs omitted …\]/);
});

test("decision with sees transcript carries the rendering; with final only the request is unchanged", async () => {
  const box = sandbox();
  const server = await decisionServer([{ answers: { q1: yesNo(1) } }]);
  const owned = plugin(box, "plugin-owned", { answer: "x" });
  script(box, "agent", SCRIPTED);
  const cases = plantCase(box, [
    {
      type: "decision",
      question: "Did it run?",
      expect: "yes",
      sees: ["final", "transcript"],
    },
  ]);
  box.write(CONFIG_FILE, { env: ["BASETEN_API_KEY"] });
  const ran = await box.cli(
    [
      ...["score", "--subject", owned, "--cases", cases, "--reps", "1"],
      ...[
        "--out",
        `${box.root}/o`,
        "--decision-model",
        "d",
        "--decision-url",
        server.url,
      ],
    ],
    { BASETEN_API_KEY: "k" },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const state = server.received[0]?.body.state;
  expect(state).toContain("<transcript>");
  expect(state).toContain('Bash {"command":"echo hi"}');
});
