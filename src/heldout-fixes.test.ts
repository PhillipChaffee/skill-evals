import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { rootsOf } from "./case-roots.js";
import { triggerHeading, triggerTable } from "./report/trigger.js";
import { requireExposable } from "./sandbox-masks.js";
import { sandbox } from "./testing/sandbox.js";
import { broKit, loads, plantRoot } from "./testing/roots.js";
import { caseOf, evaluationOf, runOf } from "./testing/trigger-eval.js";

const USAGE_ERROR = 2;
const HELDOUT_CASES = "--heldout-cases";

test("a root that is, or holds, another is a usage error naming both, links included", async () => {
  const box = sandbox();
  const dev = plantRoot(box, "evals/cases", { a: { checks: loads("bro") } });
  const inner = plantRoot(box, "evals/cases/heldout", {
    b: { checks: loads("bro") },
  });
  const ran = await box.cli(["list", "--cases", dev, HELDOUT_CASES, inner]);
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toContain(dev);
  expect(ran.stderr).toContain(inner);
  expect(ran.stderr).toContain("overlap");
  const link = path.join(box.root, "alias");
  fs.symlinkSync(dev, link);
  expect(() => rootsOf({ cases: [dev], heldoutCases: [link] })).toThrow(
    /overlap/,
  );
  expect(() => rootsOf({ cases: [inner, dev] })).toThrow(/overlap/);
  const apart = plantRoot(box, "evals/other", { c: { checks: loads("bro") } });
  expect(rootsOf({ cases: [dev], heldoutCases: [apart] })).toHaveLength(2);
});

test("a check with anyOf counts for each named skill that the case targets, and never for an unnamed target", () => {
  const cases = [caseOf("t", { kind: "trigger", targets: ["bro", "oth"] })];
  const records = [
    runOf({ caseId: "t", harness: "h" }, [
      { type: "skill_loaded", anyOf: ["bro", "zzz"], score: 1 },
    ]),
  ];
  const table = triggerTable(evaluationOf(["h"], cases, records));
  expect(table?.body.map(([skill, dev]) => [skill, dev])).toEqual([
    ["bro", "1.00 (1 run)"],
    ["oth", "n/a (0 runs)"],
  ]);
});

test("the heading names the subject when more than one ran", () => {
  const one = { ...evaluationOf(["h"], [], []), subjects: [{}] };
  expect(triggerHeading(one as never)).toBe("Trigger recall by target skill");
  const two = { ...one, subjects: [{}, {}] };
  expect(triggerHeading(two as never)).toBe(
    "Trigger recall by target skill (subject subject)",
  );
});

test("validate lints held-out variants and roots, and finds a broken one, without --heldout", async () => {
  const box = sandbox();
  box.write("dev/tone/prompt.md", "x\n");
  box.write("dev/tone/case.json", {
    checks: loads("bro"),
    variants: [
      { id: "secret", prompt: "Run the benchmark now.", heldout: true },
    ],
  });
  plantRoot(box, "held", { fine: { checks: loads("bro") } });
  box.write("held/fine/prompt.md", "Please test this.\n");
  box.write("held/bad@name/prompt.md", "x\n");
  const ran = await box.cli([
    ...["validate", "--subject", "none", "--cases", path.join(box.root, "dev")],
    ...[HELDOUT_CASES, path.join(box.root, "held")],
  ]);
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stdout).toMatch(/^warning dev\/tone@secret: .*benchmark/m);
  expect(ran.stdout).toMatch(/^warning held\/fine: .*test/m);
  expect(ran.stdout).toMatch(/^problem held\/bad@name/m);
});

test("--resume warns once when a second root changes the ids of the recorded runs", async () => {
  const box = sandbox();
  const dev = plantRoot(box, "dev", { a: { checks: loads("bro") } });
  const held = plantRoot(box, "held", { b: { checks: loads("bro") } });
  const out = path.join(box.root, "out");
  const base = ["score", "--subject", broKit(box), "--reps", "1"];
  const first = await box.cli([...base, "--cases", dev, "--out", out]);
  expect(first.status, first.stderr).toBe(0);
  const again = await box.cli([
    ...base,
    ...["--cases", dev, HELDOUT_CASES, held, "--heldout", "--resume", out],
  ]);
  expect(again.status, again.stderr).toBe(0);
  const lines = again.stderr
    .split("\n")
    .filter((line) => line.includes("recorded runs name cases not selected"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(
    "1 recorded runs name cases not selected, such as a;",
  );
});

test("each root's basename must be fit for an id, and sandboxExpose may not touch a root", async () => {
  const box = sandbox();
  const odd = plantRoot(box, "a@b", { a: { checks: loads("bro") } });
  const ok = plantRoot(box, "ok", { b: { checks: loads("bro") } });
  const ran = await box.cli(["list", "--cases", `${odd},${ok}`]);
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toContain("rename the directory");
  const usr = fs.realpathSync("/usr");
  const expose = (paths: string[], roots: string[]) => () => {
    requireExposable(paths, roots);
  };
  expect(expose(["/usr/share"], [usr])).toThrow(
    /holds a cases directory, or is inside one/,
  );
  expect(expose(["/usr"], ["/usr/share"])).toThrow(/holds a cases directory/);
  expect(expose(["/etc"], [usr])).not.toThrow();
});

test("list names a missing root and still lists the others", async () => {
  const box = sandbox();
  const dev = plantRoot(box, "dev", { a: { checks: loads("bro") } });
  const gone = path.join(box.root, "gone");
  const ran = await box.cli(["list", "--cases", dev, "--cases", gone]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain(`- ${gone}: the directory does not exist`);
  expect(ran.stdout).toContain("- dev/a: 1 checks");
});
