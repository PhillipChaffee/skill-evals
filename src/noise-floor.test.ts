import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import type { NoiseFile } from "./noise.js";
import { plugin } from "./testing/plant.js";
import { sandbox, tableRow } from "./testing/sandbox.js";
import {
  LOADS_BRO,
  WRITES_SUMMARY,
  compared,
  noiseFile,
  readJson,
} from "./testing/delta.js";

// B scores 1.00 and A 0.80: a delta of +0.20 that no run disputes.
const WEIGHTED = [
  { ...LOADS_BRO, weight: 2 },
  { ...WRITES_SUMMARY, weight: 8 },
];
const SAME = "plugin-same";
const NOISE_JSON = "noise.json";
const HELPED = "helped (+0.20, 95% +0.20..+0.20)";
const WITHIN = "within noise (+0.20, 95% +0.20..+0.20)";

test("A/A calibrate writes a noise file with zero spread for a deterministic fake", async () => {
  const box = sandbox();
  const same = plugin(box, SAME, { skill: "bro" });
  const { ran, out, results } = await compared(box, {
    checks: WEIGHTED,
    a: same,
    command: "calibrate",
    reps: 5,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const noise = readJson(out, NOISE_JSON) as NoiseFile;
  expect(noise).toEqual({
    schemaVersion: 1,
    harness: "claude-code",
    reps: 5,
    seed: 1,
    caseIds: ["restate"],
    perCase: { restate: { sd: 0, maxAbsDelta: 0, p95AbsDelta: 0 } },
    perCheckType: { file_exists: { sd: 0 }, skill_loaded: { sd: 0 } },
    suite: { sd: 0, p95AbsDelta: 0 },
    subject: { label: same, options: null },
  });
  expect(ran.stderr).toContain(`wrote ${path.join(out, NOISE_JSON)}`);
  // One export, two labels, and the other files `run` writes.
  expect(results?.records.map((record) => record.subject).sort()).toEqual([
    ...Array<string>(5).fill("a"),
    ...Array<string>(5).fill("b"),
  ]);
  expect(results?.subjects.map((subject) => subject.dir)).toEqual([same, same]);
  for (const file of ["results.json", "summary.json", "results.jsonl"]) {
    expect(fs.existsSync(path.join(out, file)), file).toBe(true);
  }
  expect(ran.stdout).toContain("within noise (+0.00, 95% +0.00..+0.00)");
});

test("calibrate takes its reps from the flag, then the config, then 5, and measures one harness", async () => {
  const box = sandbox();
  const same = plugin(box, SAME, { skill: "bro" });
  const base = {
    checks: [WRITES_SUMMARY],
    a: same,
    command: "calibrate",
  } as const;
  const flagged = await compared(box, { ...base, reps: 1 });
  expect(flagged.results?.records).toHaveLength(2);
  const config = sandbox();
  config.write("skill-evals.config.json", { reps: 3 });
  const configured = await compared(config, {
    ...base,
    a: plugin(config, SAME, { skill: "bro" }),
    reps: 3,
  });
  expect(configured.results?.records).toHaveLength(6);
  const many = await box.cli(["calibrate", "--harness", "claude-code,pi"], {
    SKILL_EVALS_BIN_PI: box.pi,
  });
  expect(many.status).toBe(EXIT.usage);
  expect(many.stderr).toContain("calibrate measures one harness");
});

test("a calibrate with no valid run writes no noise file", async () => {
  const box = sandbox();
  const ghost = plugin(box, "plugin-ghost", { ghost: true });
  const { ran, out } = await compared(box, {
    checks: [WRITES_SUMMARY],
    a: ghost,
    command: "calibrate",
    reps: 1,
  });
  expect(ran.status).toBe(EXIT.invalid);
  expect(ran.stderr).toContain("no noise.json written");
  expect(fs.existsSync(path.join(out, NOISE_JSON))).toBe(false);
});

test('a delta inside the noise floor reads "within noise"', async () => {
  const box = sandbox();
  const without = await compared(box, { checks: WEIGHTED });
  expect(tableRow(without.ran.stdout, "restate")).toContain(HELPED);
  expect(without.ran.stdout).toContain("No noise file was given");
  expect(without.results?.noiseFile).toBeNull();

  const bound = noiseFile(box, { cases: { restate: 0.25 }, suite: 0.25 });
  const within = await compared(box, {
    checks: WEIGHTED,
    flags: ["--noise", bound],
  });
  expect(within.ran.status, within.ran.stderr).toBe(0);
  expect(tableRow(within.ran.stdout, "restate")).toContain(WITHIN);
  expect(within.ran.stdout).toContain(`Suite delta: ${WITHIN} over 1 case`);
  expect(within.ran.stdout).toContain(`Noise file: ${bound}`);
  expect(within.results?.noiseFile).toBe(bound);

  const tight = noiseFile(box, { cases: { restate: 0.1 }, suite: 0.1 });
  const beyond = await compared(box, {
    checks: WEIGHTED,
    flags: ["--noise", tight],
  });
  expect(tableRow(beyond.ran.stdout, "restate")).toContain(HELPED);
});

test("the noise file can be set in the config, and a verdict never changes the exit code", async () => {
  const box = sandbox();
  noiseFile(box, { cases: { restate: 0.25 }, suite: 0.25 });
  box.write("skill-evals.config.json", { noise: NOISE_JSON });
  const { ran, out } = await compared(box, { checks: WEIGHTED });
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain(WITHIN);
  const report = readJson(out, "results.json") as { noiseFile: string };
  expect(report.noiseFile).toBe(path.join(box.root, NOISE_JSON));
  // "hurt" is a verdict, and not a bar: the exit code stays 0.
  const hurt = await compared(box, {
    checks: WEIGHTED,
    a: plugin(box, "plugin-loader", { skill: "bro" }),
    b: plugin(box, "plugin-plain", {}),
    flags: ["--noise", noiseFile(box, { cases: {}, suite: 0 })],
  });
  expect(hurt.ran.stdout).toContain(
    "hurt (\u22120.20, 95% \u22120.20..\u22120.20)",
  );
  expect(hurt.ran.status).toBe(0);
});

test("a case that the noise file does not list is judged by its interval alone, and the report says so", async () => {
  const box = sandbox();
  const bound = noiseFile(box, { cases: { other: 0.9 }, suite: 0.25 });
  const { ran, results } = await compared(box, {
    checks: WEIGHTED,
    flags: ["--noise", bound, "--report", "md,json"],
  });
  expect(tableRow(ran.stdout, "restate")).toContain(HELPED);
  expect(ran.stdout).toContain(
    "Not in the noise file, so judged by the interval alone: restate",
  );
  // The suite has its own bound, which does apply.
  expect(ran.stdout).toContain(`Suite delta: ${WITHIN}`);
  expect(results?.comparison?.harnesses[0]?.cases[0]?.noise).toBeNull();
});

const VALID: NoiseFile = {
  schemaVersion: 1,
  harness: "claude-code",
  reps: 5,
  seed: 1,
  caseIds: ["restate"],
  perCase: { restate: { sd: 0.1, maxAbsDelta: 0.1, p95AbsDelta: 0.1 } },
  perCheckType: { file_exists: { sd: 0.1 } },
  suite: { sd: 0.1, p95AbsDelta: 0.1 },
};
const WRONG: [string, unknown, RegExp][] = [
  ["a list", [], /must hold one JSON object/],
  [
    "another version",
    { ...VALID, schemaVersion: 2 },
    /"schemaVersion" must be 1/,
  ],
  ["an unknown key", { ...VALID, extra: 1 }, /unknown key "extra"/],
  ["a missing suite", { ...VALID, suite: undefined }, /missing "suite"/],
  [
    "a file written before harness, reps, seed and caseIds",
    {
      schemaVersion: 1,
      perCase: {},
      perCheckType: {},
      suite: { sd: 0, p95AbsDelta: 0 },
    },
    /missing "harness", "reps", "seed", "caseIds"/,
  ],
  [
    "a reps that is not a count",
    { ...VALID, reps: 0 },
    /"reps" must be a positive integer/,
  ],
  [
    "a harness that is not an id",
    { ...VALID, harness: "" },
    /"harness" must be a harness id/,
  ],
  [
    "caseIds that are not ids",
    { ...VALID, caseIds: [1] },
    /"caseIds" must be a list of case ids/,
  ],
  [
    "a case that is not an object",
    { ...VALID, perCase: { restate: 3 } },
    /"perCase.restate" must be an object/,
  ],
  [
    "perCase that is not an object",
    { ...VALID, perCase: 3 },
    /"perCase" must be an object/,
  ],
  [
    "a negative spread",
    {
      ...VALID,
      perCase: { restate: { sd: -1, maxAbsDelta: 0, p95AbsDelta: 0 } },
    },
    /"perCase.restate.sd" must be a number from 0 to 1/,
  ],
  [
    "a text bound",
    { ...VALID, suite: { sd: 0, p95AbsDelta: "x" } },
    /"suite.p95AbsDelta" must be a number from 0 to 1/,
  ],
  [
    "an unknown field",
    { ...VALID, perCheckType: { file_exists: { sd: 0, mean: 1 } } },
    /"perCheckType.file_exists" has an unknown key "mean"; it takes sd/,
  ],
];

test.each(WRONG)(
  "a bad noise file is a usage error that names what is wrong: %s",
  async (_name, content, expected) => {
    const box = sandbox();
    const file = box.write("bad-noise.json", content);
    const { ran, results } = await compared(box, {
      checks: [WRITES_SUMMARY],
      flags: ["--noise", file],
    });
    expect(ran.status).toBe(EXIT.usage);
    expect(ran.stderr).toContain(file);
    expect(ran.stderr).toMatch(expected);
    expect(results).toBeNull();
  },
);

test("a noise file that is not JSON, or does not exist, is a usage error", async () => {
  const box = sandbox();
  const text = path.join(box.root, "text-noise.json");
  fs.writeFileSync(text, "{not json");
  for (const file of [text, path.join(box.root, "absent.json")]) {
    const { ran } = await compared(box, {
      checks: [WRITES_SUMMARY],
      flags: ["--noise", file],
    });
    expect(ran.status).toBe(EXIT.usage);
    expect(ran.stderr).toContain(`${file}: cannot read the noise file`);
  }
});

test("a run whose subjects are not the one the noise file was calibrated on warns, and one that runs it does not", async () => {
  const box = sandbox();
  const same = plugin(box, SAME, { skill: "bro" });
  const calibration = await compared(box, {
    checks: WEIGHTED,
    a: same,
    command: "calibrate",
    reps: 2,
    out: "calibrated",
  });
  expect(calibration.ran.status, calibration.ran.stderr).toBe(0);
  const file = path.join(calibration.out, NOISE_JSON);
  const others = await compared(box, {
    checks: WEIGHTED,
    reps: 2,
    flags: ["--noise", file],
  });
  expect(others.ran.stderr).toContain(
    `skill-evals: warning: ${file} was calibrated on the subject ${same}, which this command does not run, so its noise may not fit`,
  );
  const variant = await compared(box, {
    checks: WEIGHTED,
    reps: 2,
    a: same,
    b: `${same}:hooks=off`,
    flags: ["--noise", file],
    out: "variant",
  });
  expect(variant.ran.stderr).not.toContain("was calibrated on the subject");
  // A file whose subject is not of the shape calibrate writes does not load.
  const bad = readJson(calibration.out, NOISE_JSON) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...bad, subject: { label: 1 } }));
  const refused = await compared(box, {
    checks: WEIGHTED,
    reps: 2,
    flags: ["--noise", file],
    out: "refused",
  });
  expect(refused.ran.status).toBe(EXIT.usage);
  expect(refused.ran.stderr).toContain(
    '"subject" must be an object with a string "label" and a string or null "options"',
  );
});
