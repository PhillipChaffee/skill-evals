import { expect, test } from "vitest";
import { throttled } from "./throttle.js";

test("an action runs at most once for each interval, with the latest value", () => {
  let now = 1000;
  const seen: number[] = [];
  const act = throttled(
    (value: number) => seen.push(value),
    10_000,
    () => now,
  );
  // The command has just written the first file, so the next write waits for the interval.
  act(1);
  now += 9_999;
  act(2);
  expect(seen).toEqual([]);
  now += 1;
  act(3);
  expect(seen).toEqual([3]);
  now += 5_000;
  act(4);
  now += 5_000;
  act(5);
  expect(seen).toEqual([3, 5]);
});

test("the system clock is the default", () => {
  const seen: number[] = [];
  const act = throttled((value: number) => seen.push(value), 0);
  act(1);
  expect(seen).toEqual([1]);
});
