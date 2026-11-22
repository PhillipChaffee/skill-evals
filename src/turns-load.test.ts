import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { inputHash } from "./input-hash.js";
import { caseHash } from "./run-key.js";
import type { Sandbox } from "./testing/sandbox.js";
import { sandbox } from "./testing/sandbox.js";
import { validate } from "./testing/schema-validator.js";
import { caseSchema } from "./docs/schema.js";
import { canonical, sha256 } from "./tree-hash.js";

const CHECK = { type: "output_contains", text: "x" };
const FILE = "cases/talk/case.json";
const SECOND = "the second message\n";
const INSIDE = "must stay inside the case";
const CLAUDE_CODE = "claude-code";

/**
 * Plants a case with two prompt files and the given case file.
 * @param box - The sandbox.
 * @param file - The keys of the case file; `checks` is added when absent.
 * @returns The cases directory.
 */
function plant(box: Sandbox, file: Record<string, unknown>): string {
  box.write("cases/talk/one.md", "the first message\n");
  box.write("cases/talk/two.md", SECOND);
  box.write(FILE, { checks: [CHECK], ...file });
  return path.join(box.root, "cases");
}

const failure = (box: Sandbox, file: Record<string, unknown>): string => {
  try {
    loadCases(plant(box, file));
  } catch (error) {
    return String(error instanceof Error ? error.message : error).replaceAll(
      box.root,
      "ROOT",
    );
  }
  return "";
};

test("prompt.md plus turns is a load error", () => {
  const box = sandbox();
  box.write("cases/talk/prompt.md", "a prompt\n");
  expect(failure(box, { turns: [{ prompt: "one.md" }] })).toBe(
    'case talk: prompt.md and "turns" are both set; a case has one prompt source',
  );
});

test("a case with turns loads each prompt file, and its prompt reads as the turns in order", () => {
  const box = sandbox();
  const [found] = loadCases(
    plant(box, {
      turns: [
        { prompt: "one.md" },
        { invoke: { skill: "bug-fix", args: "now" } },
        { event: "clear" },
        { prompt: "two.md", checks: [CHECK] },
      ],
    }),
  );
  expect(found?.turns?.map((turn) => Object.keys(turn)[0])).toEqual([
    "prompt",
    "invoke",
    "event",
    "prompt",
  ]);
  expect(found?.prompt).toBe(
    [
      "Turn 1: the first message",
      "Turn 2: invoke bug-fix now",
      "Turn 3: event clear",
      "Turn 4: the second message",
    ].join("\n\n"),
  );
  expect(found?.turns?.[3]?.checks).toEqual([{ ...CHECK, weight: 1, turn: 4 }]);
  expect(found?.checks).toEqual([{ ...CHECK, weight: 1 }]);
});

test("a turn is strict: one source, known keys, a first turn that is not an event", () => {
  const where = "ROOT/cases/talk/case.json turns[0]";
  const box = () => sandbox();
  expect(failure(box(), { turns: [] })).toContain('"turns" must not be empty');
  expect(failure(box(), { turns: [{}] })).toBe(
    `${where}: a turn needs exactly one of "prompt", "invoke" and "event"`,
  );
  expect(
    failure(box(), { turns: [{ prompt: "one.md", event: "clear" }] }),
  ).toContain("exactly one of");
  expect(failure(box(), { turns: [{ prompt: "one.md", color: 1 }] })).toContain(
    `${where}: unknown key "color" for a turn`,
  );
  expect(failure(box(), { turns: [{ event: "compact" }] })).toBe(
    `${where.replace("turns[0]", "turns[0]")}: the first turn must be a "prompt" or an "invoke"; an event acts on a session that exists`,
  );
  expect(
    failure(box(), { turns: [{ prompt: "one.md" }, { event: "x" }] }),
  ).toBe(
    'ROOT/cases/talk/case.json turns[1]: "event" must be "compact" or "clear" or "resume"',
  );
  expect(failure(box(), { turns: [{ invoke: { args: "x" } }] })).toContain(
    'needs a string "skill"',
  );
  expect(
    failure(box(), { turns: [{ invoke: { skill: "x", more: 1 } }] }),
  ).toContain('unknown key "more" for an invoke');
  expect(
    failure(box(), { turns: [{ prompt: "one.md", checks: [] }] }),
  ).toContain('"checks" must be a non-empty array');
});

test("the checks of a turn may not be judged, decided, or read the home's changes", () => {
  const turn = (checks: unknown[]) => ({
    turns: [{ prompt: "one.md", checks }],
  });
  expect(
    failure(sandbox(), turn([{ type: "judge", rubric: "is it good" }])),
  ).toContain("a judge check reads the whole run; put it in the case's");
  expect(
    failure(
      sandbox(),
      turn([{ type: "decision", question: "q?", expect: "yes" }]),
    ),
  ).toContain("a decision check reads the whole run");
  expect(
    failure(
      sandbox(),
      turn([{ type: "file_changed", path: "a", root: "home" }]),
    ),
  ).toContain('"root": "home" belongs in the case\'s "checks"');
  expect(
    failure(
      sandbox(),
      turn([{ type: "file_exists", path: "a", root: "home" }]),
    ),
  ).toBe("");
});

test("a prompt file stays inside the case, is a file with text, and is not in grader/", () => {
  const prompt = (named: string) => ({ turns: [{ prompt: named }] });
  const box = () => sandbox();
  expect(failure(box(), prompt("../talk.md"))).toContain(
    "prompt ../talk.md must stay inside the case",
  );
  expect(failure(box(), prompt("/etc/hostname"))).toContain(INSIDE);
  expect(failure(box(), prompt("none.md"))).toContain("does not exist");
  expect(failure(box(), prompt("."))).toContain("must stay inside the case");
  const sub = box();
  sub.write("cases/talk/notes/x.md", "text\n");
  expect(failure(sub, prompt("notes"))).toContain("is not a file");
  const empty = box();
  empty.write("cases/talk/empty.md", "  \n");
  expect(failure(empty, prompt("empty.md"))).toContain("is empty");
  const held = box();
  held.write("cases/talk/grader/answer.md", "secret\n");
  expect(failure(held, prompt("grader/answer.md"))).toContain(
    "is in grader/, whose files the agent must not see",
  );
  const link = box();
  link.write("outside.md", "elsewhere\n");
  fs.mkdirSync(path.join(link.root, "cases/talk"), { recursive: true });
  fs.symlinkSync(
    path.join(link.root, "outside.md"),
    path.join(link.root, "cases/talk/link.md"),
  );
  expect(failure(link, prompt("link.md"))).toContain(INSIDE);
  const inner = box();
  inner.write("cases/talk/real.md", "text\n");
  fs.symlinkSync("real.md", path.join(inner.root, "cases/talk/alias.md"));
  expect(failure(inner, prompt("alias.md"))).toBe("");
});

test("a variant may override the turns, and needs exactly one prompt source", () => {
  const box = sandbox();
  const [plain, pushed] = loadCases(
    plant(box, {
      turns: [{ prompt: "one.md" }],
      variants: [
        { id: "pushed", turns: [{ prompt: "one.md" }, { prompt: "two.md" }] },
        { id: "plain", prompt: "just one message" },
      ],
    }),
  );
  expect(pushed?.id).toBe("talk@pushed");
  expect(pushed?.turns).toHaveLength(2);
  expect(pushed?.prompt).toContain("Turn 2: the second message");
  expect(plain?.turns).toBeNull();
  expect(plain?.prompt).toBe("just one message");
  expect(
    failure(sandbox(), {
      turns: [{ prompt: "one.md" }],
      variants: [{ id: "a", prompt: "x", turns: [{ prompt: "one.md" }] }],
    }),
  ).toContain('exactly one of "prompt", "promptAppend" and "turns"');
  expect(
    failure(sandbox(), {
      variants: [{ id: "a", turns: [{ event: "clear" }] }],
    }),
  ).toContain("variants[0] turns[0]: the first turn must be");
});

test("turn prompt files change the inputHash, and the caseHash", () => {
  const hashes = (second: string) => {
    const box = sandbox();
    const dir = plant(box, {
      turns: [{ prompt: "one.md" }, { prompt: "two.md" }],
    });
    box.write("cases/talk/two.md", second);
    const [found] = loadCases(dir);
    if (!found) throw new Error("no case");
    return {
      input: inputHash(found, { harness: CLAUDE_CODE, model: undefined }),
      whole: caseHash(found),
    };
  };
  const same = hashes(SECOND);
  expect(hashes(SECOND)).toEqual(same);
  const changed = hashes("another follow-up\n");
  expect(changed.input).not.toBe(same.input);
  expect(changed.whole).not.toBe(same.whole);
  // The checks of a turn are not what the agent sees: they change the case's hash and not the input's.
  const box = sandbox();
  const dir = plant(box, {
    turns: [{ prompt: "one.md" }, { prompt: "two.md", checks: [CHECK] }],
  });
  const [withChecks] = loadCases(dir);
  expect(
    inputHash(withChecks as never, {
      harness: CLAUDE_CODE,
      model: undefined,
    }),
  ).toBe(same.input);
  expect(caseHash(withChecks as never)).not.toBe(same.whole);
});

test("a single prompt hashes as it did: the input hash has no turns key", () => {
  const box = sandbox();
  box.write("cases/solo/prompt.md", "one prompt\n");
  box.write("cases/solo/case.json", { checks: [CHECK] });
  const [found] = loadCases(path.join(box.root, "cases"));
  expect(found?.turns).toBeNull();
  // The hash of a case without turns is computed from the same fields as before, so a result is still reused.
  const before = sha256(
    canonical({
      prompt: "one prompt",
      files: sha256(canonical([null, null, null])),
      setup: [],
      harness: CLAUDE_CODE,
      model: null,
      maxTurns: null,
      envNames: [],
    }),
  );
  expect(
    inputHash(found as never, { harness: CLAUDE_CODE, model: undefined }),
  ).toBe(before);
});

test("the schema accepts the turns the loader accepts, and refuses what it refuses", () => {
  const doc = caseSchema();
  const problems = (value: unknown): string[] => validate(value, doc, doc);
  const good = {
    checks: [CHECK],
    turns: [
      { prompt: "one.md" },
      { invoke: { skill: "s", args: "a" }, checks: [CHECK] },
      { event: "compact", "x-note": 1 },
    ],
  };
  expect(problems(good)).toEqual([]);
  expect(problems({ ...good, turns: [] })).not.toEqual([]);
  expect(problems({ ...good, turns: [{}] })).not.toEqual([]);
  expect(
    problems({ ...good, turns: [{ prompt: "a", event: "clear" }] }),
  ).not.toEqual([]);
  expect(problems({ ...good, turns: [{ event: "pause" }] })).not.toEqual([]);
  expect(problems({ ...good, turns: [{ prompt: "a", color: 1 }] })).not.toEqual(
    [],
  );
  expect(
    problems({
      ...good,
      turns: [{ prompt: "a", checks: [{ type: "judge", rubric: "r" }] }],
    }),
  ).not.toEqual([]);
  expect(
    problems({
      checks: [CHECK],
      variants: [{ id: "v", turns: [{ prompt: "a" }] }],
    }),
  ).toEqual([]);
});
