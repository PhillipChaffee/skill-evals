import { expect, test } from "vitest";
import { plantCase, script, skillsFolder } from "./testing/plant.js";
import { scoreSubject } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";

const ORDER = "tool_order";
const CALLED = "tool_called";
const SKILL = "skill_loaded";
const EDIT = { kind: "edit" };
const READ = { kind: "read" };

// Each check that must not load, with the one message that says why.
const BAD: [string, unknown, RegExp][] = [
  [
    "a matcher with a key that is not supported yet",
    { type: ORDER, before: { kind: "edit", by: {} }, after: READ },
    /"by" is not yet supported/,
  ],
  [
    "an inputLinesMax that is not supported yet",
    { type: "first_tool", matches: { kind: "edit", inputLinesMax: 3 } },
    /"inputLinesMax" is not yet supported/,
  ],
  [
    "a min above max",
    { type: CALLED, kind: "edit", min: 3, max: 2 },
    /"min" 3 is above "max" 2/,
  ],
  [
    "a min that is not a whole number",
    { type: CALLED, kind: "edit", min: -1 },
    /min must be a whole number, 0 or more/,
  ],
  [
    "an order check with neither form",
    { type: ORDER },
    /exactly one of "before" with "after", and "sequence"/,
  ],
  [
    "an order check with both forms",
    { type: ORDER, sequence: [EDIT], before: EDIT, after: READ },
    /exactly one of "before" with "after", and "sequence"/,
  ],
  [
    "a before without an after",
    { type: ORDER, before: EDIT },
    /"before" and "after" go together/,
  ],
  [
    "a strict that is not a boolean",
    { type: ORDER, sequence: [EDIT], strict: "x" },
    /strict must be true or false/,
  ],
  [
    "a strict without a sequence",
    { type: ORDER, before: EDIT, after: READ, strict: true },
    /"strict" only applies with "sequence"/,
  ],
  [
    "a before with a which that is neither first nor last",
    { type: ORDER, before: { kind: "edit", which: "x" }, after: READ },
    /"which" must be "first" or "last"/,
  ],
  [
    "a skill_loaded with neither skill nor anyOf",
    { type: SKILL },
    /needs a string "skill" or a list "anyOf"/,
  ],
  [
    "a skill_loaded with both",
    { type: SKILL, skill: "a", anyOf: ["b"] },
    /exactly one of "skill" and "anyOf"/,
  ],
  [
    "an ignoring without first",
    { type: SKILL, skill: "a", ignoring: [READ] },
    /"ignoring" only applies with "first"/,
  ],
  [
    "a check-level by on tool_called",
    { type: CALLED, kind: "edit", by: {} },
    /"by" is not yet supported/,
  ],
  [
    "a check-level inputLinesMax on tool_not_called",
    { type: "tool_not_called", kind: "edit", inputLinesMax: 2 },
    /"inputLinesMax" is not yet supported/,
  ],
  [
    "a matcher that names nothing",
    { type: "first_tool", matches: { flags: "i" } },
    /needs at least one of "kind", "name", "inputMatches"/,
  ],
];

test.each(BAD)("%s is a load error", async (_what, check, message) => {
  const box = sandbox();
  const cases = plantCase(box, [check]);
  const ran = await box.cli(["score", "--subject", "none", "--cases", cases]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(message);
});

test("a key that is not yet supported is an error under --lenient too, never dropped with a warning", async () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: CALLED, kind: "edit", by: {} }]);
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases, "--lenient"],
  ]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(/"by" is not yet supported/);
  expect(ran.stderr).not.toMatch(/ignored unknown key/);
});

const shell = (command: string) => ({
  call: { name: "Bash", input: { command } },
});

test("every call of a run gets its index, and a new record counts from 0", async () => {
  const box = sandbox();
  script(box, "run", {
    turns: [[shell("ls"), shell("z"), { parallel: [shell("x"), shell("y")] }]],
  });
  const ran = await scoreSubject(box, {
    subject: skillsFolder(box, "skills", { bro: "# bro\n" }),
    cases: plantCase(box, [{ type: "tool_called", kind: "shell" }]),
  });
  expect(ran.records[0]?.toolCalls.map((call) => call.index)).toEqual([
    0, 1, 2, 3,
  ]);
});
