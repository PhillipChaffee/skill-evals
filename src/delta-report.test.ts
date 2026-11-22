import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { compare } from "./comparison.js";
import { formatDelta, formatInterval, verdictText } from "./delta-format.js";
import { noiseOf } from "./noise.js";
import { flakeRate, flakeText } from "./report/delta.js";
import type { RunRecord } from "./run.js";
import { scriptedCase } from "./testing/budget.js";
import { sandbox } from "./testing/sandbox.js";
import { compared, readJson } from "./testing/delta.js";

const CLAUDE_CODE = "claude-code";
const PROMPT_SEEN = { type: "output_contains", text: "prompt" };
const NEVER_SEEN = { type: "output_contains", text: "no such text" };
// Pi cannot report child calls, so on Pi this check is dropped.
const SKIPPABLE = {
  ...NEVER_SEEN,
  requires: ["childCalls"],
  ifUnsupported: "skip",
};

/**
 * Scores planted cases on two harnesses.
 * @param planted - Each case's id and the checks of its case file.
 * @returns The command's result.
 */
async function onTwoHarnesses(planted: Record<string, unknown[]>) {
  const box = sandbox();
  for (const [id, checks] of Object.entries(planted)) {
    box.write(`cases/${id}/prompt.md`, `do ${id}\n`);
    box.write(`cases/${id}/case.json`, { checks });
  }
  return box.cli(
    [
      ...["score", "--subject", "none", "--reps", "1"],
      ...["--cases", path.join(box.root, "cases")],
      ...["--harness", `${CLAUDE_CODE},pi`],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
}

test("the common-set line says how many of its cases were scored with checks skipped", async () => {
  const some = await onTwoHarnesses({
    plain: [PROMPT_SEEN],
    half: [PROMPT_SEEN, SKIPPABLE],
    third: [PROMPT_SEEN, SKIPPABLE],
  });
  expect(some.stdout).toContain(
    "Common set (3 cases: half, plain, third, 2 cases with skipped checks).",
  );
  const one = await onTwoHarnesses({
    plain: [PROMPT_SEEN],
    half: [PROMPT_SEEN, SKIPPABLE],
  });
  expect(one.stdout).toContain(
    "Common set (2 cases: half, plain, 1 case with skipped checks).",
  );
  const none = await onTwoHarnesses({ plain: [PROMPT_SEEN] });
  expect(none.stdout).toContain("Common set (1 cases: plain).");
});

test("identical inputs and seed give byte-identical reports", async () => {
  // A scripted check that alternates between reps gives the bootstrap runs that differ.
  const reports = async (seed: string) => {
    const box = sandbox();
    scriptedCase(box, "solo", {
      before: [
        {
          onStart: [1, 4, 6],
          step: {
            call: {
              name: "Write",
              input: {},
              write: { path: "out/flaky.txt", content: "x" },
            },
          },
        },
      ],
      checks: [{ type: "file_exists", path: "out/flaky.txt" }],
    });
    const ran = await box.cli([
      ...["run", "--a", "none", "--b", "none", "--seed", seed],
      ...["--cases", path.join(box.root, "suite"), "--reps", "4"],
      ...["--out", path.join(box.root, "results"), "--report", "md,json"],
    ]);
    const report = readJson(path.join(box.root, "results"), "report.json") as {
      cases: unknown;
      method: unknown;
    };
    const verdicts = ran.stdout
      .split("\n")
      .filter((line) => /^(\| solo |Suite delta|> Verdicts)/.test(line))
      .map((line) => line.replace(/ \| [\d.]+ s \/.*$/, ""));
    return JSON.stringify({
      cases: report.cases,
      method: report.method,
      verdicts,
    });
  };
  const [first, again] = [await reports("3"), await reports("3")];
  expect(again).toBe(first);
  const { cases } = JSON.parse(first) as {
    cases: { low: number; high: number; verdict: string }[];
  };
  // The interval is a real one, and not a point.
  expect(cases.some((one) => one.low < one.high)).toBe(true);
});

/**
 * Makes the records of one harness for the bootstrap, with a spread in each case.
 * @returns Records that hold only what the comparison reads.
 */
function spread(): RunRecord[] {
  const scores = {
    a: [0.2, 0.5, 0.9, 0.4, 0.7],
    b: [0.3, 0.8, 0.6, 0.95, 0.5],
  };
  return (["x", "y"] as const).flatMap((caseId) =>
    (["a", "b"] as const).flatMap((subject) =>
      scores[subject].map(
        (score) =>
          ({
            harness: CLAUDE_CODE,
            caseId,
            subject,
            score,
            checks: [{ type: "output_contains", score }],
          }) as unknown as RunRecord,
      ),
    ),
  );
}

test("the comparison depends on the runs and the seed, and on nothing else", () => {
  const cases = ["x", "y"].map((id) => ({ id, weight: 1, guard: false }));
  const input = (seed: number) => ({
    harnesses: [CLAUDE_CODE],
    applied: { [CLAUDE_CODE]: cases } as never,
    records: spread(),
    kinds: { a: "skills", b: "skills" },
    seed,
    noise: null,
  });
  const first = compare(input(1));
  expect(JSON.stringify(compare(input(1)))).toBe(JSON.stringify(first));
  expect(JSON.stringify(compare(input(2)))).not.toBe(JSON.stringify(first));
  const [one] = first.harnesses;
  expect(one?.suite.cases).toBe(2);
  expect(one?.cases[0]?.low).toBeLessThan(one?.cases[0]?.delta ?? 0);
  expect(one?.cases[0]?.discrimination).toBeNull();
});

test("the noise a calibration measures comes from the spread between runs", () => {
  const noise = noiseOf(spread(), {
    harness: CLAUDE_CODE,
    reps: 5,
    seed: 1,
    caseIds: ["x", "y"],
    weights: { x: 1, y: 1 },
  });
  expect(noise?.perCase["x"]?.sd).toBeGreaterThan(0);
  expect(noise?.perCase["x"]?.p95AbsDelta).toBeGreaterThan(0);
  expect(noise?.perCase["x"]?.maxAbsDelta).toBeCloseTo(0.09, 10);
  expect(noise?.suite.p95AbsDelta).toBeGreaterThan(0.09);
  expect(noise?.suite.sd).toBeGreaterThan(0);
  expect(
    noiseOf([], {
      harness: CLAUDE_CODE,
      reps: 5,
      seed: 1,
      caseIds: [],
      weights: {},
    }),
  ).toBeNull();
});

test("a rep passes a check at a score of 0.5, and a flake is a rep against the majority", () => {
  const runs = (...scores: number[]) =>
    scores.map((score) => ({ checks: [{ score }] }) as unknown as RunRecord);
  expect(flakeRate(runs(0.5, 0.5, 0.49), 0)).toBeCloseTo(1 / 3, 10);
  expect(flakeRate(runs(0.5, 0.49), 0)).toBe(0.5);
  expect(flakeRate(runs(1, 1, 0, 0), 0)).toBe(0.5);
  expect(flakeRate(runs(0, 0, 0), 0)).toBe(0);
  expect(flakeRate(runs(1), 0)).toBe(0);
  expect(flakeRate([], 0)).toBeNull();
  expect(flakeRate(runs(1), 1)).toBeNull();
});

test("deltas are written with their sign, and a delta that rounds to zero is not negative", () => {
  expect(formatDelta(0.123)).toBe("+0.12");
  expect(formatDelta(-0.034)).toBe("−0.03");
  expect(formatDelta(-0.001)).toBe("+0.00");
  expect(formatDelta(null)).toBe("n/a");
  expect(formatInterval({ delta: 0.12, low: -0.03, high: 0.27 })).toBe(
    "(+0.12, 95% −0.03..+0.27)",
  );
  expect(
    verdictText({ verdict: "helped", delta: 0.12, low: -0.03, high: 0.27 }),
  ).toBe("helped (+0.12, 95% −0.03..+0.27)");
  expect(
    verdictText({ verdict: null, delta: null, low: null, high: null }),
  ).toBe("n/a");
});

test("the html report shows the verdicts, the footnote and a suite row", async () => {
  const box = sandbox();
  const { out } = await compared(box, {
    checks: [{ type: "skill_loaded", skill: "bro" }],
    flags: ["--report", "html"],
  });
  const html = fs.readFileSync(path.join(out, "report.html"), "utf8");
  // Verdict and flake are columns of the case table and the suite table, as they are in markdown.
  expect(html).toContain("<th>Verdict</th>");
  expect(html).toContain("<th>Flake</th>");
  expect(html).not.toContain("<h2>Verdicts</h2>");
  expect(html).toContain("<td>helped (+1.00, 95% +1.00..+1.00)</td>");
  expect(html).toContain("<td>0%</td>");
  expect(html).toContain("2000 resamples, seed 1");
});

test("a serial run and its resumption at --jobs 4 give the same intervals from scores that vary", async () => {
  // The fake's score follows its start counter, which is racy in parallel; so the scores are made serially and the
  // parallel command reuses them. The bootstrap reads the runs in order, so an ordering bug under --jobs would move
  // the intervals.
  const box = sandbox();
  // Three checks of different weights flip on different starts, so the run scores take many values.
  const writes = (starts: number[], file: string) => ({
    onStart: starts,
    step: {
      call: {
        name: "Write",
        input: {},
        write: { path: `out/${file}.txt`, content: "x" },
      },
    },
  });
  scriptedCase(box, "solo", {
    before: [
      writes([1, 4, 6, 7, 9], "one"),
      writes([2, 3, 8, 10, 11], "two"),
      writes([1, 5, 6, 11, 12], "three"),
    ],
    checks: [
      { type: "file_exists", path: "out/one.txt" },
      { type: "file_exists", path: "out/two.txt", weight: 2 },
      { type: "file_exists", path: "out/three.txt", weight: 4 },
    ],
  });
  const out = path.join(box.root, "results");
  const args = [
    ...["run", "--a", "none", "--b", "none", "--seed", "9", "--reps", "6"],
    ...["--cases", path.join(box.root, "suite"), "--report", "json"],
  ];
  const summary = (): string => {
    const report = readJson(out, "report.json") as {
      cases: unknown;
      method: unknown;
    };
    return JSON.stringify({ cases: report.cases, method: report.method });
  };
  await box.cli([...args, "--out", out]);
  const serial = summary();
  const resumed = await box.cli([...args, "--resume", out, "--jobs", "4"]);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stderr).toContain("(reused)");
  expect(summary()).toBe(serial);
  const { cases } = JSON.parse(serial) as {
    cases: { low: number; high: number }[];
  };
  expect(cases.some((one) => one.low < one.high)).toBe(true);
});

test("a flake rate is a whole percentage, and says what it is over when runs are unscored", () => {
  expect(flakeText(null)).toBe("n/a");
  expect(flakeText(null, { valid: 0, planned: 3 })).toBe("n/a");
  expect(flakeText(0)).toBe("0%");
  expect(flakeText(1 / 3)).toBe("33%");
  expect(flakeText(0.5, { valid: 4, planned: 4 })).toBe("50%");
  expect(flakeText(0.5, { valid: 2, planned: 4 })).toBe("50% (of 2)");
});
