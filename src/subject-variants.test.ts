import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { copyOf } from "./run-copy.js";
import { UsageError } from "./scope.js";
import { parseSpec } from "./subject-options.js";
import { skillsFolder } from "./testing/plant.js";
import { resolveSubject } from "./subject.js";
import { sandbox } from "./testing/sandbox.js";
import { jsonIn, resolved, ruggedKit } from "./testing/variants.js";

const MANIFEST = ".claude-plugin/plugin.json";
const REVIEWER = "agents/reviewer.md";
const HELPER = "agents/helper.md";

const resolveSubjectWith = (
  root: string,
  spec: string,
  strippers: { id: string }[],
) =>
  resolveSubject("b", spec, {
    root,
    cwd: root,
    isGitRepo: false,
    strippers,
  });

const here = (file: string, dir: string): boolean =>
  fs.existsSync(path.join(dir, file));

test("hooks=off removes the hook from the copy and not from the source", () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  const subject = resolved(box, `${kit}:hooks=off`);
  try {
    const exported = subject.exported ?? "";
    // The export, and the copy that a run loads, have no hook configuration anywhere.
    const copy = copyOf(subject);
    try {
      for (const dir of [exported, copy?.dir ?? ""]) {
        expect(here("hooks/hooks.json", dir), dir).toBe(false);
        expect(here("hooks/extra.json", dir), dir).toBe(false);
        expect(jsonIn(dir, MANIFEST)).not.toHaveProperty("hooks");
        expect(jsonIn(dir, ".claude/settings.json")).toEqual({ model: "x" });
        // What is not a hook stays.
        expect(here(REVIEWER, dir)).toBe(true);
      }
    } finally {
      copy?.dispose();
    }
    // The source keeps every hook, and the command's source-change check sees nothing changed.
    expect(here("hooks/hooks.json", kit)).toBe(true);
    expect(here("hooks/extra.json", kit)).toBe(true);
    expect(jsonIn(kit, MANIFEST)).toHaveProperty("hooks");
    expect(jsonIn(kit, ".claude/settings.json")).toHaveProperty("hooks");
    expect(subject.sourceChanges()).toEqual([]);
    // What was removed is not taken for an edit that a run made.
    expect(subject.exportChanged()).toEqual([]);
    expect(subject.options).toBe("hooks=off");
    expect(subject.spec).toBe(kit);
  } finally {
    subject.dispose();
  }
});

test("the revision hashes the stripped export, so a variant never shares a revision with its source", () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  const [full, lean] = [resolved(box, kit), resolved(box, `${kit}:hooks=off`)];
  try {
    expect(full.revision).not.toBe(lean.revision);
    expect(full.options).toBe("");
  } finally {
    full.dispose();
    lean.dispose();
  }
});

test("skills=only:magic-* leaves only those", () => {
  const box = sandbox();
  const folder = skillsFolder(box, "mine", {
    "magic-a": "# a\n",
    "magic-b": "# b\n",
    other: "# other\n",
  });
  const only = resolved(box, `${folder}:skills=only:magic-*`);
  const except = resolved(box, `${folder}:skills=except:magic-*`);
  try {
    expect(only.skills).toEqual(["magic-a", "magic-b"]);
    expect(here("other/SKILL.md", only.exported ?? "")).toBe(false);
    expect(here("magic-a/SKILL.md", only.exported ?? "")).toBe(true);
    expect(except.skills).toEqual(["other"]);
    expect(here("magic-a/SKILL.md", except.exported ?? "")).toBe(false);
    // The source keeps all three.
    expect(fs.readdirSync(folder).sort()).toEqual([
      "magic-a",
      "magic-b",
      "other",
    ]);
    expect(only.options).toBe("skills=only:magic-*");
  } finally {
    only.dispose();
    except.dispose();
  }
});

test("a skills filter that leaves no skill is a usage error, and so does one on a skill that is the folder's own", () => {
  const box = sandbox();
  const folder = skillsFolder(box, "mine", { "magic-a": "# a\n" });
  expect(() => resolved(box, `${folder}:skills=only:nothing-*`)).toThrow(
    /skills=only:nothing-\* leaves no skill; the subject has magic-a/,
  );
  expect(() => resolved(box, `${folder}:skills=except:magic-*`)).toThrow(
    UsageError,
  );
  // A folder that is itself a skill keeps its SKILL.md under only, and loses it under except.
  box.write("solo/SKILL.md", "# solo\n");
  const solo = path.join(box.root, "solo");
  const kept = resolved(box, `${solo}:skills=only:solo`);
  expect(kept.skills).toEqual(["solo"]);
  kept.dispose();
  expect(() => resolved(box, `${solo}:skills=except:solo`)).toThrow(
    /leaves no skill/,
  );
});

test("agents=off removes every agent definition, and agents=except removes those that match", () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  const off = resolved(box, `${kit}:agents=off`);
  const some = resolved(box, `${kit}:agents=except:help*`);
  try {
    const dir = off.exported ?? "";
    expect(here(REVIEWER, dir)).toBe(false);
    expect(here(HELPER, dir)).toBe(false);
    expect(jsonIn(dir, MANIFEST)).not.toHaveProperty("agents");
    const left = some.exported ?? "";
    expect(here(REVIEWER, left)).toBe(true);
    expect(here(HELPER, left)).toBe(false);
    expect(jsonIn(left, MANIFEST)["agents"]).toEqual(["./agents/reviewer.md"]);
    expect(here(HELPER, kit)).toBe(true);
  } finally {
    off.dispose();
    some.dispose();
  }
});

test("an option an adapter cannot honour is a usage error that names the harness", () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  expect(() =>
    resolveSubjectWith(box.root, `${kit}:hooks=off`, [{ id: "pi" }]),
  ).toThrow(/hooks=off cannot be applied for pi/);
  // A skills or rules option needs no harness.
  const subject = resolveSubjectWith(box.root, `${kit}:skills=only:bro`, [
    { id: "pi" },
  ]);
  subject.dispose();
});

test("the grammar: options are checked, an existing path with a colon is a path, none takes no options", () => {
  const box = sandbox();
  expect(parseSpec("main", box.root)).toEqual({
    spec: "main",
    options: {},
    text: "",
  });
  expect(
    parseSpec(".:hooks=off,rules=on,agents=except:x,skills=only:{a,b}", "/"),
  ).toMatchObject({
    spec: ".",
    text: "hooks=off,rules=on,agents=except:x,skills=only:{a,b}",
  });
  expect(() => parseSpec(".:colour=red", "/")).toThrow(
    /unknown subject option "colour=red"/,
  );
  expect(() => parseSpec(".:hooks=on", "/")).toThrow(/hooks=on/);
  expect(() => parseSpec(".:", "/")).toThrow(/<spec>:<option>/);
  expect(() => parseSpec(":hooks=off", "/")).toThrow(UsageError);
  expect(() => parseSpec(".:skills=only:", "/")).toThrow(/needs a glob/);
  expect(() => parseSpec(".:skills=only:{a", "/")).toThrow(/unclosed/);
  // An existing path wins over the grammar.
  const folder = skillsFolder(box, "odd:name", { one: "# one\n" });
  expect(parseSpec(folder, box.root)).toMatchObject({ spec: folder, text: "" });
  const found = resolved(box, folder);
  expect(found.skills).toEqual(["one"]);
  found.dispose();
  expect(() => resolved(box, "none:hooks=off")).toThrow(
    /"none" loads nothing, so it takes no options/,
  );
});

test.each([
  ["rules=on,rules=off", /rules is given twice/],
  ["skills=only:a,skills=except:b", /skills is given twice/],
  ["agents=off,agents=except:a", /agents is given twice/],
  ["hooks=off,hooks=off", /hooks is given twice/],
])(
  "a contradictory or repeated option, %s, is a usage error",
  (options, why) => {
    expect(() => parseSpec(`.:${options}`, "/")).toThrow(why);
  },
);

test("rules=on needs rules, from the config or from a rules/ directory", () => {
  const box = sandbox();
  const folder = skillsFolder(box, "mine", { bro: "# bro\n" });
  expect(() => resolved(box, `${folder}:rules=on`)).toThrow(
    /rules=on has no rules to install/,
  );
  box.write("mine/rules/steady.md", "stay steady\n");
  const subject = resolved(box, `${folder}:rules=on`);
  try {
    expect(subject.rules).toEqual({ dir: "rules", instructionFile: null });
    expect(subject.rulesOption).toBe("on");
  } finally {
    subject.dispose();
  }
  const off = resolved(box, `${folder}:rules=off`);
  try {
    expect(off.rules).toBeNull();
    expect(copyOf(off)?.rules).toEqual([]);
  } finally {
    off.dispose();
  }
});
