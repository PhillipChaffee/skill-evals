import { expect, test } from "vitest";
import { clockText, etaOf, median, progressText } from "./progress.js";

const HOUR_MS = 3_600_000;

test("the median of an odd and an even count", () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("the estimate is the runs left times the median duration, divided by the jobs, and is none before a run ends", () => {
  expect(etaOf(10, [], 2)).toBeNull();
  expect(etaOf(10, [1000, 3000, 2000], 2)).toBe(10_000);
});

test.each([
  [0, "00:00"],
  [59_400, "00:59"],
  [61_000, "01:01"],
  [59 * 60_000 + 59_000, "59:59"],
  [HOUR_MS, "1:00:00"],
  [HOUR_MS + 2 * 60_000 + 5000, "1:02:05"],
  [11 * HOUR_MS, "11:00:00"],
])("%i ms reads %s", (ms, text) => {
  expect(clockText(ms)).toBe(text);
});

test("the progress text has n of N, the spend and the time left", () => {
  const base = {
    done: 3,
    total: 12,
    spentUsd: 0.042,
    etaMs: 72_000,
    unreported: 0,
  };
  expect(progressText(base)).toBe("[3/12] $0.0420 ETA 01:12");
  expect(progressText({ ...base, spentUsd: 12.5 })).toBe(
    "[3/12] $12.50 ETA 01:12",
  );
  expect(progressText({ ...base, unreported: 2 })).toBe(
    "[3/12] \u2265$0.0420 ETA 01:12",
  );
  expect(progressText({ ...base, spentUsd: null, etaMs: null })).toBe(
    "[3/12] $? ETA --:--",
  );
});
