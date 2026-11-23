import path from "node:path";
import { expect, test } from "vitest";
import { loadSelection } from "./select.js";
import { caseHash } from "./run-key.js";
import type { Sandbox } from "./testing/sandbox.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import {
  broKit,
  loads,
  misses,
  plantRoot,
  stays,
  triggerCellsIn,
} from "./testing/roots.js";

const USAGE_ERROR = 2;
const BOTH = ["alpha/one", "beta/deep/two"];
const HELDOUT_CASES = "--heldout-cases";
const CONFIG = "skill-evals.config.json";
const TWO_RUNS = "1.00 (2 runs)";
const NO_RUNS = "n/a (0 runs)";
// Pinned in case-hash.test.ts: the hash of a single-prompt case from before there could be more than one root.
const PINNED_CASE_HASH =
  "6fbfa37ca8f98b81dff3fe91276250b03ca8c5bca5ca88bb58d11faef9546f5c";

const listed = (stdout: string): string[] =>
  [...stdout.matchAll(/^- (.+): \d+ checks$/gm)].map((match) => match[1] ?? "");

/**
 * Scores the planted roots against the plugin whose skill loads, twice for each case.
 * @param box - The sandbox, with `dev` and perhaps `held` planted.
 * @param flags - More flags.
 * @returns The command's result.
 */
const scored = (box: Sandbox, flags: string[]) =>
  box.cli([
    ...["score", "--subject", broKit(box), "--reps", "2"],
    ...["--cases", path.join(box.root, "dev"), ...flags],
  ]);

test("two roots load with prefixed ids", async () => {
  const box = sandbox();
  plantRoot(box, "alpha", { one: { checks: loads("bro") } });
  plantRoot(box, "beta", { "deep/two": { checks: loads("bro") } });
  const both = await box.cli([
    ...["list", "--cases", path.join(box.root, "alpha")],
    ...["--cases", path.join(box.root, "beta")],
  ]);
  expect(listed(both.stdout)).toEqual(BOTH);
  const commas = await box.cli([
    ...["list", "--cases"],
    `${path.join(box.root, "alpha")},${path.join(box.root, "beta")}`,
  ]);
  expect(listed(commas.stdout)).toEqual(BOTH);
  const chosen = await box.cli([
    ...[
      "list",
      "--cases",
      `${path.join(box.root, "alpha")},${path.join(box.root, "beta")}`,
    ],
    ...["--case", "beta/**"],
  ]);
  expect(listed(chosen.stdout)).toEqual(["beta/deep/two"]);
});

test("a single root keeps plain ids and the hash it had before roots", () => {
  const box = sandbox();
  box.write("cases/solo/prompt.md", "say hello\n");
  box.write("cases/solo/workspace/a.txt", "a\n");
  box.write("cases/solo/case.json", {
    checks: [{ type: "output_contains", text: "hello" }],
    tags: ["one"],
  });
  const roots = [{ dir: path.join(box.root, "cases"), heldout: false }];
  const [caseDef] = loadSelection(roots, {}, {});
  expect(caseDef?.id).toBe("solo");
  expect(caseDef && caseHash(caseDef)).toBe(PINNED_CASE_HASH);
});

test("duplicate basenames are refused, and the message names both directories", async () => {
  const box = sandbox();
  const x = plantRoot(box, "x/cases", { one: { checks: loads("bro") } });
  const y = plantRoot(box, "y/cases", { two: { checks: loads("bro") } });
  const ran = await box.cli(["list", "--cases", x, "--cases", y]);
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toContain(x);
  expect(ran.stderr).toContain(y);
  expect(ran.stderr).toContain('"cases"');
  const held = await box.cli(["list", "--cases", x, HELDOUT_CASES, y]);
  expect(held.status).toBe(USAGE_ERROR);
});

test("duplicate ids are refused", () => {
  const box = sandbox();
  const dir = plantRoot(box, "same", { one: { checks: loads("bro") } });
  const twice = [
    { dir, heldout: false },
    { dir, heldout: false },
  ];
  expect(() => loadSelection(twice, {}, {})).toThrow(
    /more than one case has the id same\/one/,
  );
});

test("a held-out variant is skipped without --heldout", async () => {
  const box = sandbox();
  box.write("dev/tone/prompt.md", "Be brief.\n");
  box.write("dev/tone/case.json", {
    targets: ["bro"],
    checks: loads("bro"),
    variants: [
      { id: "dev", prompt: "dev prompt" },
      { id: "secret", prompt: "secret prompt", heldout: true },
    ],
  });
  const flags = ["list", "--cases", path.join(box.root, "dev")];
  expect(listed((await box.cli(flags)).stdout)).toEqual(["tone@dev"]);
  const all = await box.cli([...flags, "--heldout"]);
  expect(listed(all.stdout)).toEqual(["tone@dev", "tone@secret"]);
});

test("a held-out root is skipped without --heldout, and its ids are prefixed", async () => {
  const box = sandbox();
  plantRoot(box, "dev", { one: { checks: loads("bro") } });
  plantRoot(box, "held", { two: { checks: loads("bro") } });
  const flags = [
    ...["list", "--cases", path.join(box.root, "dev")],
    ...[HELDOUT_CASES, path.join(box.root, "held")],
  ];
  expect(listed((await box.cli(flags)).stdout)).toEqual(["dev/one"]);
  const all = await box.cli([...flags, "--heldout"]);
  expect(listed(all.stdout)).toEqual(["dev/one", "held/two"]);
  const only = await box.cli([...flags, "--case", "held/two"]);
  expect(only.status).toBe(USAGE_ERROR);
  expect(only.stderr).toContain("held-out variants run only with --heldout");
  box.write("evals/cases/solo/prompt.md", "x\n");
  box.write("evals/cases/solo/case.json", { checks: loads("bro") });
  const alone = await box.cli(["list", HELDOUT_CASES, flags[4] ?? ""]);
  expect(listed(alone.stdout)).toEqual(["cases/solo"]);
});

test("the config names the roots as a string or a list", async () => {
  const box = sandbox();
  plantRoot(box, "dev", { one: { checks: loads("bro") } });
  plantRoot(box, "more", { two: { checks: loads("bro") } });
  plantRoot(box, "held", { three: { checks: loads("bro") } });
  box.write(CONFIG, { cases: "dev" });
  expect(listed((await box.cli(["list"])).stdout)).toEqual(["one"]);
  box.write(CONFIG, {
    cases: ["dev", "more"],
    heldoutCases: "held",
  });
  expect(listed((await box.cli(["list"])).stdout)).toEqual([
    "dev/one",
    "more/two",
  ]);
  const all = await box.cli(["list", "--heldout"]);
  expect(listed(all.stdout)).toEqual(["dev/one", "held/three", "more/two"]);
  box.write(CONFIG, { cases: [1] });
  const bad = await box.cli(["list"]);
  expect(bad.status).toBe(USAGE_ERROR);
  expect(bad.stderr).toContain('"cases" must be a string or a list of strings');
});

test("the gap column is dev minus held-out", async () => {
  const box = sandbox();
  plantRoot(box, "dev", {
    fires: { kind: "trigger", targets: ["bro"], checks: loads("bro") },
  });
  plantRoot(box, "held", {
    quiet: { kind: "trigger", targets: ["bro"], checks: misses("bro") },
  });
  const out = path.join(box.root, "out");
  const ran = await scored(box, [
    ...[HELDOUT_CASES, path.join(box.root, "held"), "--heldout"],
    ...["--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("## Trigger recall by target skill");
  expect(triggerCellsIn(ran.stdout, "bro")).toEqual([
    TWO_RUNS,
    "0.00 (2 runs)",
    "+1.00",
    NO_RUNS,
  ]);
  const report = readResults(out);
  expect(Object.keys(report.caseMeta)).toEqual(["dev/fires", "held/quiet"]);
});

test("the gap is n/a when held-out has no run", async () => {
  const box = sandbox();
  plantRoot(box, "dev", {
    fires: { kind: "trigger", targets: ["bro"], checks: loads("bro") },
  });
  const ran = await scored(box, []);
  expect(ran.status, ran.stderr).toBe(0);
  expect(triggerCellsIn(ran.stdout, "bro")).toEqual([
    TWO_RUNS,
    NO_RUNS,
    "n/a",
    NO_RUNS,
  ]);
});

test("false-trigger rate counts negative cases only", async () => {
  const box = sandbox();
  plantRoot(box, "dev", {
    calm: { kind: "negative", targets: ["bro", "aux"], checks: stays("bro") },
    clear: { kind: "negative", targets: ["bro", "aux"], checks: stays("aux") },
    elsewhere: { kind: "negative", targets: ["bro"], checks: stays("zzz") },
    // These score 0 on skill_not_loaded but are no negative cases, so they do not count.
    loud: { kind: "trigger", targets: ["bro"], checks: stays("bro") },
    plain: { targets: ["bro"], checks: stays("bro") },
  });
  const ran = await scored(box, []);
  expect(ran.status, ran.stderr).not.toBe(USAGE_ERROR);
  expect(triggerCellsIn(ran.stdout, "bro")[3]).toBe(TWO_RUNS);
  expect(triggerCellsIn(ran.stdout, "aux")[3]).toBe("0.00 (2 runs)");
});
