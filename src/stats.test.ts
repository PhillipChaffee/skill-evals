import { expect, test } from "vitest";
import {
  RESAMPLES,
  bootstrapDelta,
  bootstrapSuite,
  mean,
  mulberry32,
  pooledSd,
  quantile,
  seedFor,
  verdict,
} from "./stats.js";

const A = [0.4, 0.5, 0.6, 0.5, 0.45, 0.55];
const SHIFT = 0.3;
const B = A.map((score) => score + SHIFT);
const WITHIN = "within noise";
const options = (seed: number) => ({ resamples: RESAMPLES, seed });

test("bootstrapDelta is reproducible for a seed and brackets a known shift", () => {
  const first = bootstrapDelta(A, B, options(7));
  expect(first).not.toBeNull();
  expect(bootstrapDelta(A, B, options(7))).toEqual(first);
  expect(bootstrapDelta(A, B, options(8))).not.toEqual(first);
  expect(first?.delta).toBeCloseTo(SHIFT, 10);
  expect(first?.low).toBeLessThan(SHIFT);
  expect(first?.high).toBeGreaterThan(SHIFT);
  // Six runs of a spread of about 0.07 cannot move the mean difference by half the shift.
  expect(first?.low).toBeGreaterThan(SHIFT / 2);
  expect(first?.high).toBeLessThan(SHIFT * 1.5);
});

test("bootstrapDelta has no answer when a side has no run, and no width when every run agrees", () => {
  expect(bootstrapDelta([], B, options(1))).toBeNull();
  expect(bootstrapDelta(A, [], options(1))).toBeNull();
  const flat = bootstrapDelta([0.5, 0.5], [0.7, 0.7], options(1));
  expect(flat?.low).toBeCloseTo(0.2, 10);
  expect(flat?.high).toBeCloseTo(0.2, 10);
});

test("the suite bootstrap resamples within each case and weighs the case deltas", () => {
  expect(bootstrapSuite([], options(1))).toBeNull();
  const suite = bootstrapSuite(
    [
      { a: [0, 0], b: [1, 1], weight: 3 },
      { a: [1, 1], b: [1, 1], weight: 1 },
    ],
    options(1),
  );
  // (3 * 1 + 1 * 0) / 4, and a case never borrows runs from another.
  expect(suite).toEqual({ delta: 0.75, low: 0.75, high: 0.75 });
});

test("the generator is seeded, stays in [0, 1), and each name gets its own seed", () => {
  const first = mulberry32(5);
  const again = mulberry32(5);
  const drawn = Array.from({ length: 50 }, () => first());
  expect(Array.from({ length: 50 }, () => again())).toEqual(drawn);
  expect(drawn.every((value) => value >= 0 && value < 1)).toBe(true);
  expect(new Set(drawn).size).toBe(drawn.length);
  expect(seedFor(1, "a")).toBe(seedFor(1, "a"));
  expect(seedFor(1, "a")).not.toBe(seedFor(1, "b"));
  expect(seedFor(1, "a")).not.toBe(seedFor(2, "a"));
});

test("mean, pooled spread and quantile do the arithmetic the noise file relies on", () => {
  expect(mean([1, 2, 3])).toBe(2);
  // Two groups with sums of squares 2 and 16 over 1 + 3 degrees of freedom.
  expect(pooledSd([[1, 3], [0, 0, 4, 4], [9]])).toBeCloseTo(
    Math.sqrt(18 / 4),
    10,
  );
  expect(pooledSd([[1], []])).toBe(0);
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(quantile(sorted, 0.95)).toBe(10);
  expect(quantile(sorted, 0.5)).toBe(5);
  expect(quantile(sorted, 0)).toBe(1);
});

test("a verdict is within noise when the interval holds 0 or the delta is inside the noise bound", () => {
  const clear = { low: 0.1, high: 0.3 };
  expect(verdict(0.2, clear, null)).toBe("helped");
  expect(verdict(-0.2, { low: -0.3, high: -0.1 }, null)).toBe("hurt");
  expect(verdict(0.2, { low: -0.1, high: 0.5 }, null)).toBe(WITHIN);
  expect(verdict(0, { low: 0, high: 0 }, null)).toBe(WITHIN);
  expect(verdict(0.2, clear, 0.2)).toBe(WITHIN);
  expect(verdict(0.2, clear, 0.19)).toBe("helped");
  expect(verdict(-0.2, { low: -0.3, high: -0.1 }, 0.25)).toBe(WITHIN);
});
