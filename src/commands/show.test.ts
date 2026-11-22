import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Results } from "../evaluate.js";
import { plantCase, script, skillsFolder } from "../testing/plant.js";
import { readResults, sandbox } from "../testing/sandbox.js";
import type { Sandbox } from "../testing/sandbox.js";
import { SHOW_CUT, clean, quoted, shown } from "../show-text.js";

const USAGE_ERROR = 2;
const LONG = "x".repeat(SHOW_CUT + 50);

/**
 * Scores the planted case with a scripted agent that runs one long command and never reads a file.
 * @returns The sandbox and the output directory that `score` wrote.
 */
async function scored(): Promise<{ box: Sandbox; out: string }> {
  const box = sandbox();
  script(box, "calls", {
    turns: [
      [
        { text: "looking" },
        {
          call: {
            name: "Bash",
            input: { command: `echo ${LONG}` },
            output: LONG,
          },
        },
        { final: "done" },
      ],
    ],
  });
  const cases = plantCase(box, [
    { type: "tool_called", name: "Read" },
    { type: "output_matches", pattern: "done" },
  ]);
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", skillsFolder(box, "skills", { bro: "# bro\n" })],
    ...["--cases", cases, "--reps", "1", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  return { box, out };
}

/**
 * Rewrites the results of an output directory.
 * @param out - The output directory.
 * @param change - Changes the parsed results.
 */
function rewrite(out: string, change: (results: Results) => void): void {
  const results = readResults(out);
  change(results);
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results));
}

test("show prints a failing check's reason beside the calls it quotes", async () => {
  const { box, out } = await scored();
  const shown = await box.cli(["show", out, "restate"]);
  expect(shown.status, shown.stderr).toBe(0);
  const lines = shown.stdout.split("\n");
  expect(shown.stdout).toMatch(/^claude-code restate subject, rep 1$/m);
  // The call is a line of the transcript, with its agent, kind and name.
  const call = lines.find((line) =>
    /^\d+: "main" "shell" "Bash" call #\d+ input /.test(line),
  );
  expect(call).toBeDefined();
  const index = /call #(\d+)/.exec(call ?? "")?.[1];
  // The failing check says why, and quotes the same call by its index, right under its score.
  const at = lines.findIndex((line) =>
    /^1\. tool_called .*: 0\.00$/.test(line),
  );
  expect(at).toBeGreaterThan(0);
  expect(lines.slice(at + 1, at + 6).join("\n")).toMatch(
    new RegExp(`^   .*#${String(index)} .*Bash`, "m"),
  );
  expect(
    lines.some((line) => /^2\. output_matches .*: 1\.00$/.test(line)),
  ).toBe(true);
});

test("show cuts a long input and output at 200 characters, and says so where it cuts", async () => {
  const { box, out } = await scored();
  const shown = await box.cli(["show", out, "restate"]);
  expect(shown.stdout).toContain(
    "each input, output, text and line of a reason is cut at 200 characters",
  );
  const cuts = shown.stdout
    .split("\n")
    .filter((line) => line.includes("[cut at 200 of "));
  expect(cuts.length).toBeGreaterThanOrEqual(2);
  for (const line of cuts) expect(line).not.toContain(LONG);
  expect(shown.stdout).toContain("looking");
  expect(shown.stdout).toMatch(
    /^\d+: "main" "shell" "Bash" result of call #0 output /m,
  );
});

test("show prints a line for a transcript file that is gone, and still prints the checks", async () => {
  const { box, out } = await scored();
  const files = fs.readdirSync(out, { recursive: true, encoding: "utf8" });
  for (const file of files.filter((name) =>
    name.endsWith(".transcript.json"),
  )) {
    fs.rmSync(path.join(out, file));
  }
  const shown = await box.cli(["show", out, "restate"]);
  expect(shown.status, shown.stderr).toBe(0);
  expect(shown.stdout).toMatch(
    /transcript: .*\.transcript\.json cannot be read/,
  );
  expect(shown.stdout).toMatch(/^1\. tool_called .*: 0\.00$/m);
});

test("show says so when the run wrote no transcript, and when the run is invalid", async () => {
  const { box, out } = await scored();
  rewrite(out, ({ records }) => {
    const [record] = records;
    if (record) {
      Object.assign(record, {
        transcriptFile: null,
        ok: false,
        error: "boom",
        checks: record.checks.map((check) => ({ ...check, score: null })),
      });
    }
  });
  const shown = await box.cli(["show", out, "restate"]);
  expect(shown.stdout).toContain("transcript: the run wrote none");
  expect(shown.stdout).toContain("checks (run invalid: boom)");
  expect(shown.stdout).toContain(": no score");
});

test("show takes no lock and writes nothing", async () => {
  const { box, out } = await scored();
  const before = fs.readdirSync(out).sort();
  await box.cli(["show", out, "restate"]);
  expect(fs.readdirSync(out).sort()).toEqual(before);
  expect(before.some((name) => name.includes("lock"))).toBe(false);
});

test("show with an unknown rep exits 2 and lists the reps that exist", async () => {
  const { box, out } = await scored();
  const shown = await box.cli(["show", out, "restate", "--rep", "2"]);
  expect(shown.status).toBe(USAGE_ERROR);
  expect(shown.stderr).toMatch(/no rep 2 of restate.*reps: 1/);
  expect((await box.cli(["show", out, "restate", "--rep", "1"])).status).toBe(
    0,
  );
});

test("show with an unknown case or subject exits 2 and lists what exists", async () => {
  const { box, out } = await scored();
  const noCase = await box.cli(["show", out, "nope"]);
  expect(noCase.status).toBe(USAGE_ERROR);
  expect(noCase.stderr).toMatch(/no case "nope".*cases: restate/);
  const noSubject = await box.cli(["show", out, "restate", "--subject", "zzz"]);
  expect(noSubject.status).toBe(USAGE_ERROR);
  expect(noSubject.stderr).toMatch(/no subject "zzz" for restate; subjects: /);
});

test("show reads a directory without results as a usage error", async () => {
  const box = sandbox();
  const shown = await box.cli(["show", box.root, "restate"]);
  expect(shown.status).toBe(USAGE_ERROR);
});

test("show escapes control characters in what it prints and quotes names", async () => {
  const { box, out } = await scored();
  rewrite(out, ({ records }) => {
    const [record] = records;
    if (!record) return;
    Object.assign(record, { harness: "h\u001b[31m" });
    record.checks[0] = {
      ...record.checks[0],
      reason: `bad \u001b[2J\u0007 ${"é".repeat(300)}\nsecond \u007f`,
    } as never;
  });
  const shown1 = await box.cli(["show", out, "restate"]);
  // eslint-disable-next-line no-control-regex
  expect(shown1.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  expect(shown1.stdout).toContain("h\\x1b[31m restate");
  expect(shown1.stdout).toContain("   bad \\x1b[2J\\x07 ");
  expect(shown1.stdout).toContain("   second \\x7f");
  expect(shown1.stdout).toMatch(/é+ \[cut at 200 of \d+ characters\]/);
  const unknown = await box.cli(["show", out, "a\u001bb"]);
  expect(unknown.stderr).toContain('no case "a\\x1bb"');
});

test("show prints ? for an event with no agent and goes on with the others", async () => {
  const { box, out } = await scored();
  const file = fs
    .readdirSync(out, { recursive: true, encoding: "utf8" })
    .find((name) => name.endsWith(".transcript.json"));
  const path1 = path.join(out, file ?? "");
  const events = JSON.parse(fs.readFileSync(path1, "utf8")) as Record<
    string,
    unknown
  >[];
  delete events[0]?.["agent"];
  fs.writeFileSync(path1, JSON.stringify(events));
  const printed = await box.cli(["show", out, "restate"]);
  expect(printed.status, printed.stderr).toBe(0);
  expect(printed.stdout).toMatch(/^0: \? "text" - text "looking"$/m);
  expect(printed.stdout).toMatch(/^1: "main" "shell" "Bash"/m);
});

test("a cut never splits an escape or a surrogate pair, and clean escapes every control character", () => {
  const pair = "\u{1F600}";
  for (const filler of ["a", "\u001b", "\n", pair]) {
    for (let offset = 0; offset < 8; offset += 1) {
      const out = shown(
        "x".repeat(SHOW_CUT - offset) + filler.repeat(4) + "tail",
      );
      const body = out.replace(/ \[cut at .*$/, "");
      expect(body.length).toBeLessThanOrEqual(SHOW_CUT);
      expect(body).not.toMatch(/[\ud800-\udbff]$|\\(x[0-9a-f]?)?$/);
    }
  }
  expect(clean("a\u0000b\u001fc\u007fd")).toBe("a\\x00b\\x1fc\\x7fd");
  expect(shown("short")).toBe("short");
});

test("clean escapes C1 and bidirectional controls, and names are cut", () => {
  expect(clean("a\u009bb\u202ec\u2067d\u0085")).toBe(
    "a\\x9bb\\u202ec\\u2067d\\x85",
  );
  expect(quoted("n".repeat(500), "-")).toMatch(
    /\[cut at 200 of 502 characters\]$/,
  );
  expect(quoted("ok", "-")).toBe('"ok"');
});
