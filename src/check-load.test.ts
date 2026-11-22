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
    "a via that is no mechanism",
    { type: SKILL, skill: "a", via: "telepathy" },
    /"via" must be one of skill_tool, file_read, shell_read, injected, or a list of them/,
  ],
  [
    "an empty list of vias",
    { type: SKILL, skill: "a", via: [] },
    /"via" must be one of/,
  ],
  [
    "a via list inside a list",
    { type: SKILL, skill: "a", via: [["file_read"]] },
    /"via" must be one of/,
  ],
  [
    "a resolved that is not a boolean",
    { type: SKILL, skill: "a", resolved: "yes" },
    /resolved must be true or false/,
  ],
  [
    "a skill_file_read without its path",
    { type: "skill_file_read", skill: "a" },
    /skill_file_read needs a string "path"/,
  ],
  [
    "a matcher with a by that is not a by",
    { type: ORDER, before: { kind: "edit", by: {} }, after: READ },
    /"by" must be one of "main", "subagent"/,
  ],
  [
    "an inputLinesMax that is not a whole number",
    { type: "first_tool", matches: { kind: "edit", inputLinesMax: 1.5 } },
    /inputLinesMax must be a positive integer/,
  ],
  [
    "an inputLinesMin that is zero",
    { type: "tool_not_called", kind: "write", inputLinesMin: 0 },
    /inputLinesMin must be a positive integer/,
  ],
  [
    "a matcher with only an inputLinesMax",
    { type: "first_tool", matches: { inputLinesMax: 3 } },
    /needs at least one of "kind", "name", "inputMatches", "by"/,
  ],
  [
    "a file_lines with neither min nor max",
    { type: "file_lines", path: "a.txt" },
    /file_lines needs at least one of "min", "max"/,
  ],
  [
    "a file_count with min above max",
    { type: "file_count", path: "a/*", min: 3, max: 2 },
    /"min" 3 is above "max" 2/,
  ],
  [
    "a quantifier that is neither any nor all",
    { type: "file_matches", path: "a", pattern: "x", quantifier: "some" },
    /"quantifier" must be "any" or "all"/,
  ],
  [
    "a root that is neither workspace nor home",
    { type: "file_absent", path: "a", root: "etc" },
    /"root" must be "workspace" or "home"/,
  ],
  [
    "a glob with an unclosed brace",
    { type: "file_exists", path: "src/{a,b.ts" },
    /unclosed "\{" in the glob src\/\{a,b.ts/,
  ],
  [
    "a path that climbs out of the root",
    { type: "file_absent", path: "../x/*" },
    /path must stay inside the workspace/,
  ],
  [
    "a files_changed_only with no allow",
    { type: "files_changed_only" },
    /files_changed_only needs a list "allow"|"allow" must be a non-empty list|needs a string "allow"/,
  ],
  [
    "an allow glob that leaves the root",
    { type: "files_changed_only", allow: ["../**"] },
    /"allow": path must stay inside the workspace: \.\.\/\*\*/,
  ],
  [
    "an ignore glob that is not closed",
    { type: "files_changed_only", allow: ["**"], ignore: ["{a"] },
    /unclosed "\{" in the glob \{a/,
  ],
  [
    "a created that is not a boolean",
    { type: "file_exists", path: "a", created: "yes" },
    /created must be true or false/,
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
    "a check-level by on tool_called that is not a by",
    { type: CALLED, kind: "edit", by: "child" },
    /"by" must be one of "main", "subagent"/,
  ],
  [
    "a check-level inputLinesMax of 0 on tool_not_called",
    { type: "tool_not_called", kind: "edit", inputLinesMax: 0 },
    /inputLinesMax must be a positive integer/,
  ],
  [
    "a matcher that names nothing",
    { type: "first_tool", matches: { flags: "i" } },
    /needs at least one of "kind", "name", "inputMatches", "by"/,
  ],
];

test.each(BAD)("%s is a load error", async (_what, check, message) => {
  const box = sandbox();
  const cases = plantCase(box, [check]);
  const ran = await box.cli(["score", "--subject", "none", "--cases", cases]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(message);
});

test("a bad by is an error under --lenient too, never dropped with a warning", async () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: CALLED, kind: "edit", by: {} }]);
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases, "--lenient"],
  ]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(/"by" must be one of/);
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
