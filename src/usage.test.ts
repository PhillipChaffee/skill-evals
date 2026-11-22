import { expect, test } from "vitest";
import { readDecimal } from "./decimal.js";
import { sandbox } from "./testing/sandbox.js";
import { plantSuite } from "./testing/suite.js";

const NOT_DECIMAL = "is not a decimal number";

test.each([
  ["3", 3],
  ["-1", -1],
  ["+2", 2],
  ["1.5", 1.5],
  [".5", 0.5],
  ["5.", 5],
  ["1e3", 1000],
  ["0", 0],
  [" 3 ", 3],
  ["\t3", 3],
  ["3\n", 3],
])("%j is the number %d", (text, value) => {
  expect(readDecimal(text)).toBe(value);
});

test.each([
  "",
  " ",
  "  ",
  "0x1",
  "0b1",
  "0o7",
  "abc",
  "1,5",
  "Infinity",
  "NaN",
  "1_0",
  "1 2",
])("%j is not a number", (text) => {
  expect(readDecimal(text)).toBeNaN();
});

test.each([
  ["--retries", ""],
  ["--retries", "0x1"],
  ["--retries", " "],
  ["--max-cost", ""],
  ["--max-cost", "0x10"],
  ["--max-duration", "0b1"],
  ["--jobs", "0o2"],
  ["--jobs", ""],
  ["--reps", ""],
  ["--min-score", "0x1"],
])(
  "%s %j says it is not a decimal number, before any range check",
  async (flag, value) => {
    const box = sandbox();
    const cases = plantSuite(box, ["alpha"]);
    const ran = await box.cli([
      ...["score", "--subject", "none", "--cases", cases],
      flag,
      value,
    ]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain(`${flag} ${NOT_DECIMAL}`);
  },
);

test("a number with surrounding whitespace is read, as in 0.0.1", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases],
    ...["--reps", " 1 ", "--min-score", "\t0.5"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
});
