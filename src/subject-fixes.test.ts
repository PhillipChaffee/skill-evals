import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { invalidReason } from "./run.js";
import { requireNamed } from "./subject-labels.js";
import { plantCase } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import {
  BRO_LOADED,
  compared,
  resolved,
  ruggedKit,
} from "./testing/variants.js";

const SUB_LINK = "agents/sub";

test("no two labels' file stems can collide: a label ends in a letter, so label and rep read one way", () => {
  const alphabet = ["a", "b", "1", "-"];
  const labels: string[] = [];
  const grow = (word: string): void => {
    if (word !== "") {
      try {
        requireNamed([
          { label: word, spec: "none" },
          { label: "zz", spec: "none" },
        ]);
        labels.push(word);
      } catch {
        // Not a label.
      }
    }
    if (word.length < 4) for (const next of alphabet) grow(word + next);
  };
  grow("");
  const stems = labels.flatMap((label) =>
    Array.from({ length: 25 }, (_, rep) => `${label}${String(rep + 1)}`),
  );
  expect(labels).toContain("a-b");
  expect(labels).not.toContain("a1");
  expect(new Set(stems).size).toBe(stems.length);
});

test("k with k1 is refused, and two runs never write one transcript", async () => {
  const box = sandbox();
  plantCase(box, [BRO_LOADED]);
  const { ran } = await compared(box, "k=none,k1=none", ["--reps", "11"]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain('subject label "k1" must be');
});

test("diff warns when a shared label has other options or another revision, and --strict exits 2", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const run = async (spec: string, out: string) => {
    const ran = await box.cli([
      ...["run", "--subjects", `x=none,y=${spec}`, "--reps", "1"],
      ...["--cases", path.join(box.root, "cases"), "--out", out],
    ]);
    expect(ran.status, ran.stderr).toBe(0);
    return path.join(out, "results.json");
  };
  const full = await run(kit, path.join(box.root, "r1"));
  const lean = await run(`${kit}:hooks=off`, path.join(box.root, "r2"));
  const again = await run(kit, path.join(box.root, "r3"));
  const quiet = await box.cli(["diff", full, again, "--strict"]);
  expect(quiet.status, quiet.stdout).toBe(EXIT.ok);
  const loud = await box.cli(["diff", full, lean, "--strict"]);
  expect(loud.status).toBe(EXIT.usage);
  expect(loud.stdout).toContain(
    "the options of subject y differ: A none; B hooks=off",
  );
  expect(loud.stdout).toContain("the revision of subject y differs");
});

test("strip removes agents that a manifest-named directory holds, and links, without following them", () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  box.write("kit/.claude-plugin/plugin.json", {
    name: "kit",
    agents: "./custom/",
    skills: "./extra",
  });
  box.write("kit/custom/scout.md", "# scout\n");
  box.write("kit/custom/keep.md", "# keep\n");
  box.write("kit/extra/side/SKILL.md", "# side\n");
  box.write("kit/shared/ag/inner.md", "# inner\n");
  box.write("kit/shared/sk/SKILL.md", "# linked skill\n");
  const link = (target: string, at: string): void => {
    fs.symlinkSync(target, path.join(kit, at));
  };
  link("../shared/ag", SUB_LINK);
  link("../shared/sk", "skills/linked");
  const off = resolved(box, `${kit}:agents=off`);
  const only = resolved(box, `${kit}:agents=only:keep,skills=except:linked`);
  try {
    const dir = off.exported ?? "";
    for (const gone of ["custom/scout.md", "custom/keep.md", SUB_LINK]) {
      expect(fs.existsSync(path.join(dir, gone)), gone).toBe(false);
      expect(() => fs.lstatSync(path.join(dir, gone)), gone).toThrow();
    }
    // The target of a link is not touched: only the link goes.
    expect(fs.existsSync(path.join(dir, "shared/ag/inner.md"))).toBe(true);
    const left = only.exported ?? "";
    expect(fs.existsSync(path.join(left, "custom/keep.md"))).toBe(true);
    expect(fs.existsSync(path.join(left, "custom/scout.md"))).toBe(false);
    expect(() => fs.lstatSync(path.join(left, SUB_LINK))).toThrow();
    expect(() => fs.lstatSync(path.join(left, "skills/linked"))).toThrow();
    expect(only.stripped.agents).toContain("scout");
    expect(only.stripped.skills).toContain("linked");
    // The source is as it was.
    expect(fs.lstatSync(path.join(kit, SUB_LINK)).isSymbolicLink()).toBe(true);
  } finally {
    off.dispose();
    only.dispose();
  }
});

test("a run is invalid when the harness reports an agent or skill that the options removed", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  box.write("fake/scripts/leak.json", {
    init: { agents: ["plugin:helper"], skills: ["magic-a"] },
    turns: [[{ final: "ok" }]],
  });
  const alone = await compared(
    box,
    `full=${kit},leaky=${kit}:agents=except:help*`,
    ["--reps", "1"],
  );
  // An invalid run: the harness reported the agent that was removed.
  expect(alone.ran.status).toBe(3);
  const [healthy, leaky] = readResults(alone.out).records;
  expect(healthy?.strippedLoaded).toBeUndefined();
  expect(leaky?.strippedLoaded).toEqual(["helper"]);
  expect(invalidReason(leaky ?? ({} as never))).toBe(
    "stripped but still loaded: helper",
  );
});

test("agents=only keeps the agents that match, and a subject of --subjects is named so in an error", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const { ran, out } = await compared(
    box,
    `all=${kit},one=${kit}:agents=only:rev*`,
    [...["--reps", "1"]],
  );
  expect(ran.status, ran.stderr).toBe(0);
  const agents = readResults(out).records.map((r) => r.loaded.agents);
  expect(agents).toEqual([
    ["plugin:helper", "plugin:reviewer"],
    ["plugin:reviewer"],
  ]);
  // A label that is `a` or `b` is still named as a `--subjects` label.
  const bad = await compared(box, `a=none,b=${kit}:skills=only:nothing`);
  expect(bad.ran.stderr).toContain("--subjects b=");
  expect(bad.ran.stderr).not.toContain("--b ");
  expect(bad.ran.stderr.match(/skills=only:nothing/g)).toHaveLength(2);
});

test("with two subjects comparison stays B against A whatever --bar-subject says", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const { ran, out } = await compared(box, `a=none,b=${kit}`, [
    "--bar-subject",
    "a",
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  expect(results.barSubject).toBe("a");
  expect(results.comparison?.harnesses).toEqual(
    results.comparisons[0]?.harnesses,
  );
});

test("a resume whose options changed warns once", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const first = await compared(box, `x=${kit},y=${kit}`, ["--reps", "1"]);
  const resumed = await compared(box, `x=${kit}:hooks=off,y=${kit}:hooks=off`, [
    ...["--reps", "1", "--resume", first.out],
  ]);
  expect(resumed.ran.status, resumed.ran.stderr).toBe(0);
  expect(resumed.ran.stderr.match(/--resume: the options of/g)).toHaveLength(1);
  expect(resumed.ran.stderr).toContain(
    "x (was no options, now hooks=off), y (",
  );
});

test("the discrimination of two none subjects names each none arm, so no row repeats another", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const { ran } = await compared(box, `kit=${kit},nil-a=none,nil-b=none`, [
    ...["--reps", "1"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain(
    "| Case | Subject arm | None arm | None | Subject |",
  );
  const rows = ran.stdout
    .split("\n")
    .filter((line) => line.startsWith("| restate | kit |"));
  // One row for each none arm, and the arm is named: no row repeats another.
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("| nil-a |");
  expect(rows[1]).toContain("| nil-b |");
});

test("two-subject HTML has no Subject arm column, and more subjects have one", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const page = async (subjects: string) => {
    const { ran, out } = await compared(box, subjects, [
      "--reps",
      "1",
      "--report",
      "html",
    ]);
    expect(ran.status, ran.stderr).toBe(0);
    return fs.readFileSync(path.join(out, "report.html"), "utf8");
  };
  const two = await page(`a=none,b=${kit}`);
  expect(two).toContain("<h2>Discrimination</h2>");
  expect(two).not.toContain("Subject arm");
  expect(await page(`a=${kit},b=none,c=${kit}`)).toContain(
    "<th>Subject arm</th><th>None arm</th>",
  );
});
