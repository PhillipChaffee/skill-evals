import { expect, test } from "vitest";
import { createGate, spendOf } from "./gate.js";

const MINUTE_MS = 60_000;
const nothing = { costUsd: 0, reported: false, unreported: 1 };
const paid = (costUsd: number) => ({ costUsd, reported: true, unreported: 0 });

test("spendOf adds the costs reply by reply, and one reply with no cost does not hide the others", () => {
  const reply = (costUsd: number | null) => ({ costUsd });
  expect(spendOf(0.25, [reply(0.125), reply(null), reply(0.0625)])).toEqual({
    costUsd: 0.4375,
    reported: true,
    unreported: 1,
  });
  expect(spendOf(null, [])).toEqual({
    costUsd: 0,
    reported: false,
    unreported: 1,
  });
  expect(spendOf(null, [reply(0.5)])).toEqual({
    costUsd: 0.5,
    reported: true,
    unreported: 1,
  });
});

test("the gate sums every attempt, counts the costs not reported, and stops at the limit, not only over it", () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  expect(gate.spent()).toBeNull();
  gate.add(nothing);
  expect(gate.spent()).toBeNull();
  expect(gate.unreported()).toBe(1);
  gate.add({ costUsd: 0.375, reported: true, unreported: 2 });
  expect(gate.spent()).toBe(0.375);
  expect(gate.unreported()).toBe(3);
  expect(gate.check()).toBe("go");
  gate.add(paid(0.625));
  expect(gate.check()).toBe("stop");
});

test("a cost that is pending counts as if it were added", () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  gate.add(paid(0.5));
  expect(gate.reached()).toBeNull();
  expect(gate.reached(0.5)).toBe("budget");
  expect(gate.stopped()).toBeNull();
});

test("a stop is final, and `reached` tells without stopping", () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  gate.add(paid(2));
  expect(gate.reached()).toBe("budget");
  expect(gate.stopped()).toBeNull();
  expect(gate.check()).toBe("stop");
  expect(gate.stopped()).toBe("budget");
  expect(gate.check()).toBe("stop");
});

test("the gate stops at the time limit by the clock it is given, from when the command began, and cost comes first", () => {
  const clock = { now: 1000 };
  const gate = createGate(
    { maxCost: 5, maxDurationMs: MINUTE_MS },
    () => clock.now,
    400,
  );
  clock.now = 400 + MINUTE_MS - 1;
  expect(gate.reached()).toBeNull();
  clock.now += 1;
  expect(gate.reached()).toBe("duration");
  gate.add(paid(5));
  expect(gate.reached()).toBe("budget");
  expect(gate.check()).toBe("stop");
  expect(gate.stopped()).toBe("budget");
});

test("a gate with no limit always says go", () => {
  const gate = createGate({ maxCost: undefined, maxDurationMs: undefined });
  gate.add(paid(1e9));
  expect(gate.check()).toBe("go");
});
