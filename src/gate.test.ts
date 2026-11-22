import { expect, test } from "vitest";
import { createGate } from "./gate.js";

const none = { costUsd: null, judge: null, decision: null };
const MINUTE_MS = 60_000;

test("the gate sums the agent, judge and decision costs of every attempt, and a cost not reported adds nothing", () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  expect(gate.spent()).toBeNull();
  gate.add(none);
  expect(gate.spent()).toBeNull();
  gate.add({
    costUsd: 0.25,
    judge: { calls: 1, durationMs: 1, tokens: null, costUsd: 0.125 },
    decision: { calls: 1, durationMs: 1, tokens: null, costUsd: null },
  });
  expect(gate.spent()).toBe(0.375);
  expect(gate.check()).toBe("go");
  gate.add({ ...none, costUsd: 0.625 });
  expect(gate.check(), "at the limit, not only over it").toBe("stop");
});

test("a stop is final, and `reached` tells without stopping", () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  gate.add({ ...none, costUsd: 2 });
  expect(gate.reached()).toBe("budget");
  expect(gate.stopped()).toBeNull();
  expect(gate.check()).toBe("stop");
  expect(gate.stopped()).toBe("budget");
  expect(gate.check()).toBe("stop");
});

test("the gate stops at the time limit by the clock it is given, and cost comes first", () => {
  const clock = { now: 1000 };
  const gate = createGate(
    { maxCost: 5, maxDurationMs: MINUTE_MS },
    () => clock.now,
  );
  expect(gate.check()).toBe("go");
  clock.now += MINUTE_MS - 1;
  expect(gate.reached()).toBeNull();
  clock.now += 1;
  expect(gate.reached()).toBe("duration");
  gate.add({ ...none, costUsd: 5 });
  expect(gate.reached()).toBe("budget");
  expect(gate.check()).toBe("stop");
  expect(gate.stopped()).toBe("budget");
});

test("a gate with no limit always says go", () => {
  const gate = createGate({ maxCost: undefined, maxDurationMs: undefined });
  gate.add({ ...none, costUsd: 1e9 });
  expect(gate.check()).toBe("go");
});
