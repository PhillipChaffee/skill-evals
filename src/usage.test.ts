import { expect, test } from "vitest";
const RETRIES = "retries must be a non-negative integer";
import { plantSuite } from "./testing/suite.js";
import { readDecimal } from "./decimal.js";
import { sandbox } from "./testing/sandbox.js";

test.each([
  ["3", 3],
  ["-1", -1],
  ["+2", 2],
  ["1.5", 1.5],
  [".5", 0.5],
  ["5.", 5],
  ["1e3", 1000],
  ["0", 0],
])("%s is the number %d", (text, value) => {
  expect(readDecimal(text)).toBe(value);
});

test.each([
  "",
  " ",
  "  ",
  "0x1",
  "0b1",
  " 5",
  "5 ",
  "abc",
  "1,5",
  "Infinity",
  "NaN",
  "1_0",
])("%j is not a number", (text) => {
  expect(readDecimal(text)).toBeNaN();
});

test.each([
  ["--retries", "", RETRIES],
  ["--retries", "0x1", RETRIES],
  ["--retries", " ", RETRIES],
  ["--max-cost", "", "maxCost must be a positive number"],
  ["--max-cost", "0x10", "maxCost must be a positive number"],
  ["--jobs", "0x2", "jobs must be a positive integer"],
  ["--jobs", "", "jobs must be a positive integer"],
])("%s %j is a usage error", async (flag, value, message) => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases, "--reps", "1"],
    flag,
    value,
  ]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain(message);
});
