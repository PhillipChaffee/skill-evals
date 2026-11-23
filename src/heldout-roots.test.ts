import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { digestOf } from "./approval.js";
import { exclusionsOf } from "./exclusions.js";
import { maskingOf } from "./sandbox-masks.js";
import { resolveSubject } from "./subject.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { broKit, loads, plantRoot, stays } from "./testing/roots.js";

const USAGE_ERROR = 2;
const HELD_QUIET = "held/quiet";

/**
 * Plants a dev root and a held-out root, each with one case.
 * @param box - The sandbox.
 * @returns The flags that name both roots, and ask for the held-out one.
 */
function twoRoots(box: ReturnType<typeof sandbox>): string[] {
  plantRoot(box, "dev", {
    fires: { kind: "trigger", targets: ["bro"], checks: loads("bro") },
  });
  plantRoot(box, "held", {
    quiet: { kind: "negative", targets: ["bro"], checks: stays("bro") },
  });
  return [
    ...["--cases", path.join(box.root, "dev")],
    ...["--heldout-cases", path.join(box.root, "held"), "--heldout"],
  ];
}

test("both roots are excluded from the subject export", () => {
  const box = sandbox();
  box.write("kit/skills/bro/SKILL.md", "bro\n");
  box.write("kit/evals/dev/a/prompt.md", "dev prompt\n");
  box.write("kit/evals/held/b/prompt.md", "held-out prompt\n");
  const project = { root: box.root, isGitRepo: false, cwd: box.root };
  const subject = resolveSubject("subject", path.join(box.root, "kit"), {
    ...project,
    left: exclusionsOf(
      {
        cases: [path.join(box.root, "kit/evals/dev")],
        heldoutCases: [path.join(box.root, "kit/evals/held")],
      },
      box.root,
    ),
  });
  onTestFinished(subject.dispose);
  const files = fs
    .readdirSync(subject.exported ?? "", { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".md"));
  expect(files).toEqual([path.join("skills", "bro", "SKILL.md")]);
});

test("a held-out root that is or contains the subject is a usage error", () => {
  const box = sandbox();
  box.write("kit/skills/bro/SKILL.md", "bro\n");
  const project = { root: box.root, isGitRepo: false, cwd: box.root };
  expect(() =>
    resolveSubject("subject", path.join(box.root, "kit"), {
      ...project,
      left: exclusionsOf({ cases: [], heldoutCases: [box.root] }, box.root),
    }),
  ).toThrow(/the cases directory .* is, or contains, the subject directory/);
});

test("the approval digest covers every root, and one root keeps its old digest", () => {
  const box = sandbox();
  const dev = plantRoot(box, "dev", { a: { checks: loads("bro") } });
  const held = plantRoot(box, "held", { b: { checks: loads("bro") } });
  expect(digestOf([dev])).toBe(digestOf(dev));
  const both = digestOf([dev, held]);
  expect(both).not.toBe(digestOf(dev));
  box.write("held/b/prompt.md", "changed\n");
  expect(digestOf([dev, held])).not.toBe(both);
});

test("the sandbox hides every root", () => {
  // Outside the temp directories, which the sandbox hides as a whole.
  const dirs = ["/usr", "/etc"].map((dir) => fs.realpathSync(dir));
  const { masked } = maskingOf({
    casesDirs: dirs,
    outDir: "/nonexistent/out",
    bin: "tool",
  });
  expect(masked).toEqual(expect.arrayContaining(dirs));
});

test("validate checks a held-out root whether or not --heldout is given", async () => {
  const box = sandbox();
  plantRoot(box, "dev", { a: { checks: loads("bro") } });
  box.write("held/bad@name/prompt.md", "x\n");
  const flags = [
    ...["validate", "--subject", "none"],
    ...["--cases", path.join(box.root, "dev")],
    ...["--heldout-cases", path.join(box.root, "held")],
  ];
  const result = await box.cli(flags);
  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stdout).toMatch(/^problem held\/bad@name: .*may not hold "@"/m);
});

test("plan, score, show, rejudge and diff handle ids of two roots", async () => {
  const box = sandbox();
  const flags = twoRoots(box);
  const planned = await box.cli(["plan", "--subject", broKit(box), ...flags]);
  expect(planned.status, planned.stderr).toBe(0);
  expect(planned.stdout).toContain("Cases: 2 loaded");
  const out = path.join(box.root, "out");
  const args = ["--subject", broKit(box), "--reps", "1", ...flags];
  const ran = await box.cli(["score", ...args, "--out", out]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(Object.keys(readResults(out).caseMeta)).toEqual([
    "dev/fires",
    HELD_QUIET,
  ]);
  const shown = await box.cli([
    "show",
    out,
    HELD_QUIET,
    "--subject",
    "subject",
  ]);
  expect(shown.status, shown.stderr).toBe(0);
  expect(shown.stdout).toContain("skill_not_loaded");
  const again = await box.cli(["rejudge", out, ...flags.slice(0, 4)]);
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toContain(HELD_QUIET);
  const resumed = await box.cli(["score", ...args, "--resume", out]);
  expect(resumed.status, resumed.stderr).toBe(0);
  const diffed = await box.cli(["diff", out, out]);
  expect(diffed.status, diffed.stderr).toBe(0);
  expect(diffed.stdout).toContain(HELD_QUIET);
});

test("explain finds a case by its prefixed id, and init writes under the first root", async () => {
  const box = sandbox();
  const flags = twoRoots(box).slice(0, 4);
  const explained = await box.cli(["explain", HELD_QUIET, ...flags]);
  expect(explained.status, explained.stderr).toBe(0);
  expect(explained.stdout).toContain("## held/quiet (held out)");
  const missing = await box.cli(["explain", "quiet", ...flags]);
  expect(missing.status).toBe(USAGE_ERROR);
  expect(missing.stderr).toContain(HELD_QUIET);
  const made = await box.cli([
    ...["init", "fresh", "--kind", "trigger", ...flags.slice(0, 2)],
    ...["--cases", path.join(box.root, "held")],
  ]);
  expect(made.status, made.stderr).toBe(0);
  expect(fs.existsSync(path.join(box.root, "dev/fresh/case.json"))).toBe(true);
});

test("the json and html reports carry the trigger table, and summary.json does not", async () => {
  const box = sandbox();
  const flags = twoRoots(box);
  const out = path.join(box.root, "out");
  const ran = await box.cli([
    ...["score", "--subject", broKit(box), "--reps", "1", ...flags],
    ...["--report", "md,json,html", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const json = JSON.parse(
    fs.readFileSync(path.join(out, "report.json"), "utf8"),
  ) as { trigger: Record<string, unknown>[] };
  expect(json.trigger).toEqual([
    {
      harness: "claude-code",
      skill: "bro",
      recallDev: { value: 1, runs: 1 },
      recallHeldout: { value: null, runs: 0 },
      gap: null,
      falseTrigger: { value: 1, runs: 1 },
    },
  ]);
  const html = fs.readFileSync(path.join(out, "report.html"), "utf8");
  expect(html).toContain("<h2>Trigger recall by target skill</h2>");
  expect(html).toContain("<td>1.00 (1 run)</td>");
  const summary = fs.readFileSync(path.join(out, "summary.json"), "utf8");
  expect(summary).not.toContain("trigger");
});
