import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { CONFIG_FILE } from "./project.js";
import { plantBlind as plant } from "./testing/blinding.js";
import { readResults, sandbox, seenBy } from "./testing/sandbox.js";

const USAGE_ERROR = 2;

test('a TMPDIR that contains "test" is reported before any run', async () => {
  const box = sandbox();
  plant(box, "c");
  const out = path.join(box.root, "out");
  const ran = await box.cli(
    [
      "score",
      "--subject",
      "none",
      "--cases",
      `${box.root}/cases`,
      "--out",
      out,
    ],
    { TMPDIR: "/var/tmp/test-area" },
  );
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toContain('the path "/var/tmp/test-area" holds "test"');
  expect(ran.stderr).toContain("Set TMPDIR");
  expect(ran.stderr).toContain("blindingWords");
  expect(fs.existsSync(box.started)).toBe(false);
  expect(fs.existsSync(out)).toBe(false);
});

test("a variable name with a word, and a variable that names this tool, are reported before any run", async () => {
  const box = sandbox();
  box.write(CONFIG_FILE, { env: ["TEST_TOKEN", "OWN_SECRET"] });
  plant(box, "c", { file: { env: { CASE_NOTE: "made by skill-evals" } } });
  const ran = await box.cli(
    ["score", "--subject", "none", "--cases", `${box.root}/cases`],
    { TEST_TOKEN: "x", OWN_SECRET: "skill-evals" },
  );
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toContain('the variable name TEST_TOKEN holds "test"');
  expect(ran.stderr).toContain("the variable CASE_NOTE names this tool");
  // A variable that the user passes on purpose is warned about by name, never by value.
  expect(ran.stderr).toContain("the value of OWN_SECRET names this tool");
  expect(fs.existsSync(box.started)).toBe(false);
});

test("no variable visible to the agent names this tool", async () => {
  const box = sandbox();
  plant(box, "restate", {
    file: { env: { CASE_NOTE: "plain" } },
    files: { "workspace/notes.txt": "planted\n" },
  });
  box.write(CONFIG_FILE, { env: ["PASSED_ON"] });
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--cases", `${box.root}/cases`],
      ...["--out", out, "--reps", "1"],
    ],
    { PASSED_ON: "yes" },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = readResults(out).records;
  const seen = seenBy(String(record?.finalText));
  expect(seen.leaks).toBe(0);
  expect(seen.seed).toBe("planted");
});

test("a run warns once for each case about the real workspace it started with", async () => {
  const box = sandbox();
  plant(box, "w", {
    file: { setup: [{ run: "echo x > benchmark-notes.txt" }] },
    files: { "workspace/notes.txt": "planted\n" },
  });
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", `${box.root}/cases`],
    ...["--out", path.join(box.root, "r"), "--reps", "2"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const warned = ran.stderr
    .split("\n")
    .filter((line) => line.includes('holds "benchmark"'));
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain(
    "skill-evals: warning: w: the workspace the run started with",
  );
});
