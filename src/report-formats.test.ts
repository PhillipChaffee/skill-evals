import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Evaluation } from "./evaluate.js";
import { renderHtml } from "./report/html.js";
import { renderJunit } from "./report/junit.js";
import { escapeXml } from "./report/xml.js";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { sandbox } from "./testing/sandbox.js";
import { parseXml } from "./testing/xml.js";

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
    minScore: null,
    maxInvalid: 0,
    sourceChanged: [],
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
  // A reader turns a literal line break in an attribute into a space, so breaks and tabs are references.
  expect(escapeXml("tab\there\r\nok \u{1F600}")).toBe(
    "tab&#9;here&#13;&#10;ok \u{1F600}",
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
