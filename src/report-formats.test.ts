import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Evaluation } from "./evaluate.js";
import { dirtyOf } from "./meta.js";
import { caseHash } from "./run-key.js";
import { renderHtml } from "./report/html.js";
import { renderJunit } from "./report/junit.js";
import { escapeXml } from "./report/xml.js";
import type { Subject } from "./subject.js";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { gitRepo, readResults, sandbox } from "./testing/sandbox.js";
import { parseXml } from "./testing/xml.js";
import { loadCases } from "./cases.js";

const RESULTS = "results";
const HARNESS = "claude-code";
const TITLE = "# Skill scores";
const REPORT_JSON = "report.json";
const REPORT_XML = "report.xml";
const REPORT_HTML = "report.html";
// Markup, quotes, an ampersand, a control character, a lone surrogate and U+FFFE: what a harness's error can hold.
const HOSTILE = `<script>alert("x")</script> & 'q' \u0001\u0008\uD800￾ end`;
const exists = (box: { root: string }, file: string): boolean =>
  fs.existsSync(path.join(box.root, RESULTS, file));

/**
 * Makes an evaluation with one hostile case id and reason, for the renderers.
 * @returns What the renderers read.
 */
function hostile(): Evaluation {
  const runs = { subject: { valid: 0, planned: 1 } };
  return {
    schemaVersion: 1,
    exit: 3,
    outDir: HOSTILE,
    subjects: [
      {
        label: "subject",
        spec: "none",
        kind: "none",
        dir: null,
        skills: [],
        commit: null,
      },
    ],
    suites: [
      {
        harness: HARNESS,
        cases: [{ id: HOSTILE, weight: 1, scores: { subject: null }, runs }],
        suite: { subject: null },
        applicable: 1,
        total: 2,
        runs,
      },
    ],
    records: [
      {
        harness: HARNESS,
        caseId: HOSTILE,
        subject: "subject",
        rep: 1,
        error: HOSTILE,
        checks: [],
        durationMs: 1500,
        score: null,
      },
    ],
    notRun: [],
    notApplicable: [
      {
        harness: HARNESS,
        caseId: "skipped",
        missing: ["mcp"],
        reason: HOSTILE,
      },
    ],
    belowBar: [HOSTILE],
    partial: { reason: "budget" },
    cases: [],
    applied: {},
  } as unknown as Evaluation;
}

test("the xml escape removes what XML 1.0 forbids and escapes the rest", () => {
  expect(escapeXml(HOSTILE)).toBe(
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;  end",
  );
  expect(escapeXml("tab\there\r\nok \u{1F600}")).toBe(
    "tab\there\r\nok \u{1F600}",
  );
});

test("junit escapes every value and parses back", () => {
  const root = parseXml(renderJunit(hostile()));
  const [suite] = root.children;
  const [broken, skipped] = suite?.children ?? [];
  expect(broken?.attributes["name"]).toBe(
    `<script>alert("x")</script> & 'q'  end`,
  );
  expect(broken?.children[0]?.name).toBe("error");
  expect(broken?.children[0]?.attributes["message"]).toContain("<script>");
  expect(skipped?.children[0]?.name).toBe("skipped");
  expect(skipped?.attributes["time"]).toBe("0.000");
  expect(broken?.attributes["time"]).toBe("1.500");
});

test("html escapes every value and holds no script or external reference", () => {
  const html = renderHtml(hostile());
  expect(html).not.toContain("<script");
  expect(html).not.toMatch(/(src|href)="https?:/);
  expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  expect(html).toContain("The command stopped early: budget");
});

test("--report picks the formats: md goes to standard output only when listed, the rest to files", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  const only = async (...formats: string[]) => {
    fs.rmSync(path.join(box.root, RESULTS), { recursive: true, force: true });
    return box.cli(scoreArgs(box, RESULTS, ...formats));
  };
  const none = await only();
  expect(none.stdout).toContain(TITLE);
  for (const file of [REPORT_JSON, REPORT_XML, REPORT_HTML]) {
    expect(exists(box, file)).toBe(false);
  }
  expect(exists(box, "summary.json")).toBe(true);

  const json = await only("--report", "json");
  expect(json.status, json.stderr).toBe(0);
  expect(json.stdout).toBe("");
  expect(exists(box, REPORT_JSON)).toBe(true);
  expect(exists(box, REPORT_XML)).toBe(false);

  const both = await only("--report", "md", "--report", "junit,html");
  expect(both.stdout).toContain(TITLE);
  expect(exists(box, REPORT_XML) && exists(box, REPORT_HTML)).toBe(true);
  expect(exists(box, REPORT_JSON)).toBe(false);
});

test("report and maxInvalid in the config file are defaults, and a flag wins", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  box.write("skill-evals.config.json", { report: ["json"], maxInvalid: 0.25 });
  const ran = await box.cli(scoreArgs(box, RESULTS));
  expect(ran.stdout).toBe("");
  expect(exists(box, REPORT_JSON)).toBe(true);
  const flagged = await box.cli(scoreArgs(box, "second", "--report", "md"));
  expect(flagged.stdout).toContain(TITLE);
  for (const bad of [{ report: ["pdf"] }, { report: [] }, { maxInvalid: 2 }]) {
    box.write("skill-evals.config.json", bad);
    const wrong = await box.cli(scoreArgs(box, "third"));
    expect(wrong.status, JSON.stringify(bad)).toBe(2);
  }
});

test("each harness's version is read once for the command and is null when it fails", async () => {
  const box = sandbox();
  for (const id of ["alpha", "bravo"]) scriptedCase(box, id);
  const log = path.join(box.root, "versions.log");
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--reps", "2", "--model", "m1"),
    { FAKE_VERSION_LOG: log },
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["version"]);
  const { meta } = readResults(path.join(box.root, RESULTS));
  expect(meta.harnessVersions).toEqual({ [HARNESS]: "fake-harness 9.9.9" });
  // The fake harness did not count the question as a start.
  expect(fs.readFileSync(box.started, "utf8").trim().split("\n")).toHaveLength(
    4,
  );

  fs.rmSync(path.join(box.root, RESULTS), { recursive: true });
  const failing = await box.cli(scoreArgs(box, RESULTS), {
    FAKE_VERSION_FAIL: "1",
  });
  expect(failing.status, failing.stderr).toBe(0);
  expect(
    readResults(path.join(box.root, RESULTS)).meta.harnessVersions,
  ).toEqual({
    [HARNESS]: null,
  });
});

test("the judge harness's version is read too", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--harness", HARNESS, "--judge-harness", "pi"),
    {
      SKILL_EVALS_BIN_PI: box.pi,
    },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const { meta } = readResults(path.join(box.root, RESULTS));
  expect(Object.keys(meta.harnessVersions).sort()).toEqual([HARNESS, "pi"]);
});

test("plan and --dry-run read no version", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  const log = path.join(box.root, "versions.log");
  for (const args of [
    ["plan", "--subject", "none", "--cases", path.join(box.root, "suite")],
    scoreArgs(box, RESULTS, "--dry-run"),
  ]) {
    const ran = await box.cli(args, { FAKE_VERSION_LOG: log });
    expect(ran.status, ran.stderr).toBe(0);
  }
  expect(fs.existsSync(log)).toBe(false);
});

test("meta names the tool, models, subject revision, case hashes and isolation", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--model", "run-model", "--judge-model", "j-model"),
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(path.join(box.root, RESULTS));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    version: string;
  };
  const [alpha] = loadCases(path.join(box.root, "suite"));
  expect(results.schemaVersion).toBe(1);
  expect(results.meta).toMatchObject({
    toolVersion: pkg.version,
    models: { agent: "run-model", judge: "j-model", decision: null },
    caseHashes: { alpha: caseHash(alpha as never) },
    isolated: false,
    subjects: [{ label: "subject", revision: "none", dirty: null }],
  });
});

test("dirty is true for uncommitted changes under the subject, false for a clean tree or a ref, and null outside git", () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  box.write("repo/skills/x/SKILL.md", "x\n");
  const git = gitRepo(repo);
  const subject = (dir: string | null, commit: string | null): Subject =>
    ({ dir, commit }) as Subject;
  expect(dirtyOf(subject(repo, null))).toBe(true);
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  expect(dirtyOf(subject(repo, null))).toBe(false);
  box.write("repo/skills/x/SKILL.md", "changed\n");
  expect(dirtyOf(subject(path.join(repo, "skills"), null))).toBe(true);
  expect(dirtyOf(subject(repo, "abc123"))).toBe(false);
  const outside = path.join(box.root, "outside");
  fs.mkdirSync(outside);
  expect(dirtyOf(subject(outside, null))).toBeNull();
  expect(dirtyOf(subject(null, null))).toBeNull();
  expect(dirtyOf(subject(path.join(box.root, "missing"), null))).toBeNull();
});
