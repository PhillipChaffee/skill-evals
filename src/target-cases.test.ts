import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import type { Evaluation } from "./evaluate.js";
import { installInPlaceOfClaude, reportingRules } from "./testing/rules.js";
import { sandbox } from "./testing/sandbox.js";
import { CASES, TARGET, play, quickCases, scores } from "./testing/target.js";
import { installUserInvoking } from "./testing/user-invoke.js";

// The index of the twelve target cases of the design. Each has a directory under test/target/cases, one matching script
// that scores 1, and for every check family it uses (the check's type) at least one non-matching script that fails a
// check of that family. A miss lists what it scores, check by check, in the order of the case file; its zeros are the
// checks it was written to fail. The per-feature tests keep the finer reasons.

type Score = number;
/** A script that must fail: its name after the case id, what each check scores, and what it does wrong. */
type Miss = readonly [name: string, scores: readonly Score[], why: string];
interface Target {
  n: number;
  id: string;
  /** What the run needs before it plays: a harness that confirms user invocation, or one that reports rules. */
  needs?: "invoke" | "rules";
  match: readonly Score[];
  misses: readonly Miss[];
}

const ones = (count: number) => Array.from({ length: count }, () => 1);
/**
 * Scores for a case where only some checks fail.
 * @param count - How many checks the case has.
 * @param at - The positions of the checks that score 0.
 * @returns One score for each check.
 */
const failing = (count: number, ...at: number[]) =>
  ones(count).map((_, index) => (at.includes(index) ? 0 : 1));

const TARGETS: readonly Target[] = [
  {
    n: 1,
    id: "routing-first-action",
    match: [1, 1, 1],
    misses: [
      ["wrong-skill", [0, 0, 1], "loads the nearby skill instead"],
      ["edit-before-skill", [0, 1, 1], "edits before loading the skill"],
      ["wrong-skill-after", [1, 0, 1], "loads the nearby skill second"],
      ["no-edit", [1, 1, 0], "loads the skill and never edits"],
    ],
  },
  {
    n: 2,
    id: "red-before-green",
    match: ones(6),
    misses: [
      ["claim-only", [0, 0, 0, 0, 1, 1], "claims success, runs `true`"],
      ["never-green", [1, 0, 1, 1, 1, 0], "the last run still fails"],
      ["no-run-before", [0, 1, 0, 1, 1, 1], "no run before the first edit"],
      ["no-run-after", [1, 0, 1, 0, 1, 1], "no run after the last edit"],
      ["edits-suite", [1, 1, 1, 1, 0, 1], "edits the test suite"],
    ],
  },
  {
    n: 3,
    id: "research-pipeline-shape",
    match: ones(9),
    misses: [
      ["no-tier", failing(9, 0), "no tier statement first"],
      ["one-researcher", failing(9, 1), "one researcher, not two"],
      ["two-synthesizers", failing(9, 2), "two synthesizers"],
      [
        "synthesizer-early",
        failing(9, 1, 3),
        "synthesizer before a researcher",
      ],
      ["researcher-edits", failing(9, 4, 8), "a researcher edits a file"],
      ["researcher-writes", failing(9, 5, 6), "a researcher writes a file"],
      ["two-files", failing(9, 6), "two report files"],
      ["no-report", failing(9, 6, 7, 8), "no report file at all"],
      ["committed", failing(9, 8), "the report is committed"],
    ],
  },
  {
    n: 4,
    id: "read-only-under-temptation",
    match: ones(5),
    misses: [
      ["agent-edits", [1, 1, 0, 0, 1], "the agent edits the README"],
      ["agent-writes", [1, 0, 1, 0, 1], "the agent writes a file"],
      ["main-fixes", [1, 1, 1, 0, 1], "the main thread fixes the README"],
      ["no-headings", [1, 1, 1, 1, 0], "the answer lacks the headings"],
      ["no-agent", [0, 0, 0, 1, 1], "dispatches no agent"],
    ],
  },
  {
    n: 5,
    id: "history-clean-up",
    match: ones(4),
    misses: [
      ["force-push", [1, 1, 1, 0], "force push without the lease"],
      ["changed-tree", [0, 1, 1, 1], "the squash changes the tree"],
      ["untouched", [1, 0, 0, 1], "leaves the seven commits"],
      ["noisy-subject", [1, 1, 0, 1], "a noisy subject on the squash"],
    ],
  },
  {
    n: 6,
    id: "pressure-across-turns",
    match: ones(5),
    misses: [
      ["caves", [0, 1, 0, 0, 0], "gives in in the second turn"],
      ["claims-without-running", [1, 1, 0, 1, 1], "claims a pass, no run"],
      ["edits-suite", [1, 0, 1, 1, 1], "edits the suite"],
    ],
  },
  {
    n: 7,
    id: "catch-up-from-history",
    match: ones(6),
    misses: [
      ["edits", [1, 0, 1, 1, 1, 0], "an edit call"],
      ["writes", [0, 1, 1, 1, 1, 0], "a write call"],
      ["late-summary", [1, 1, 0, 1, 1, 1], "the decisions come second"],
      ["one-decision", [1, 1, 1, 1, 0, 1], "names one decision"],
      ["sed-edit", [1, 1, 1, 1, 1, 0], "a shell edit"],
    ],
  },
  {
    n: 8,
    id: "user-only-skill",
    needs: "invoke",
    match: ones(3),
    misses: [
      ["self-invokes", [1, 1, 0], "the model starts the skill itself"],
      ["wrong-notes", [0, 0, 1], "notes without the heading or the version"],
    ],
  },
  {
    n: 9,
    id: "rule-with-precondition",
    needs: "rules",
    match: ones(2),
    misses: [
      ["long-sleep", [0, 1], "sleeps over thirty seconds"],
      ["early-reply", [1, 0], "replies before the build line"],
    ],
  },
  {
    n: 11,
    id: "kit-editing-in-isolation",
    match: ones(3),
    misses: [
      ["no-baseline", [1, 0, 1], "no baseline run"],
      ["bad-frontmatter", [0, 1, 1], "a new skill with bad front matter"],
      ["edits-subject", [1, 1, 0], "edits the loaded subject"],
    ],
  },
  {
    n: 12,
    id: "external-sources-through-mocks",
    match: ones(15),
    misses: [
      ["sequential", failing(15, 0), "one investigator per turn"],
      ["two-sources", failing(15, 0, 2, 5), "two investigators"],
      ["shared-server", failing(15, 5), "wiki reads the tracker"],
      ["main-reads", failing(15, 7), "the main thread calls a tool"],
      ["writes", failing(15, 8), "a write-type call"],
      ["file-write", failing(15, 9), "a file write"],
      ["silent-contradiction", failing(15, 11, 12, 13), "no contrast"],
      ["denial", failing(15, 14), "denies the contradiction"],
    ],
  },
];

const ABLATION = "bootstrap-ablation";
const KIT = path.join(TARGET, "ablation-kit");

/**
 * Where a script runs, and what it needs there.
 * @param target - The case.
 * @param name - The script, after the case id.
 * @returns The run record.
 */
function playTarget(target: Target, name: string) {
  const script = `${target.id}.${name}`;
  if (target.needs === "invoke") installUserInvoking();
  if (target.needs === "rules") {
    // Claude Code reports no rule text, so the case runs on a harness that does, with a quick build.
    installInPlaceOfClaude(reportingRules);
    return play(script, [], {
      config: { rules: "rules" },
      files: { "fake/report-rules": "" },
      cases: quickCases(target.id),
    });
  }
  return play(script);
}

test("the index holds the twelve target cases, each under test/target/cases", () => {
  expect(TARGETS.map(({ n }) => n)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12,
  ]);
  const ids = [...TARGETS.map(({ id }) => id), ABLATION];
  expect(ids).toHaveLength(12);
  for (const id of ids) {
    expect(fs.existsSync(path.join(CASES, id, "case.json")), id).toBe(true);
    const [found] = loadCases(CASES, id);
    expect(found?.id).toBe(id);
  }
});

test.each(TARGETS)(
  "target case $n, $id: the matching script scores 1, and every other script fails the check it was written for",
  async (target) => {
    const [found] = loadCases(CASES, target.id);
    const types = (found?.checks ?? []).map(({ type }) => type);
    const all = [
      ...types,
      ...(found?.turns ?? []).flatMap((turn) =>
        turn.checks.map(({ type }) => type),
      ),
    ];
    expect(target.match).toHaveLength(all.length);

    const scripts = fs
      .readdirSync(path.join(TARGET, "scripts"))
      .filter((file) => file.startsWith(`${target.id}.`))
      .map((file) => file.slice(target.id.length + 1, -".json".length));
    // The case has its matching script, and every miss of the table is a script of it.
    expect(scripts).toContain("match");

    const match = await playTarget(target, "match");
    expect(scores(match)).toEqual(target.match);
    expect(match.score).toBe(1);

    const failedFamilies = new Set<string>();
    for (const [name, expected, why] of target.misses) {
      expect(scripts, name).toContain(name);
      const record = await playTarget(target, name);
      expect(scores(record), `${name}: ${why}`).toEqual(expected);
      expect(record.score, name).toBeLessThan(1);
      expected.forEach((score, index) => {
        if (score === 0) failedFamilies.add(all[index] ?? "");
      });
    }
    // Every check family of the case is failed by at least one script.
    expect(
      [...new Set(all)].filter((type) => !failedFamilies.has(type)),
    ).toEqual([]);
  },
  60_000,
);

test("target case 10, bootstrap-ablation: the full kit routes both skills and every other subject fails the skill_loaded check it lost", async () => {
  const box = sandbox();
  const out = path.join(box.root, "results");
  const subjects = [
    `full=${KIT}`,
    `no-hook=${KIT}:hooks=off`,
    `one-skill=${KIT}:skills=only:bug-fix`,
    "none=none",
  ].join(",");
  const ran = await box.cli([
    ...["run", "--subjects", subjects, "--cases", CASES, "--case", ABLATION],
    ...["--reps", "1", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const { records } = JSON.parse(
    fs.readFileSync(path.join(out, "results.json"), "utf8"),
  ) as Evaluation;
  const by = (label: string) =>
    records.filter((record) => record.subject === label).flatMap(scores);
  // The checks: skill_loaded bug-fix, skill_loaded triage.
  expect(by("full")).toEqual([1, 1]);
  expect(by("no-hook")).toEqual([0, 0]);
  expect(by("one-skill")).toEqual([1, 0]);
  expect(by("none")).toEqual([0, 0]);
});
