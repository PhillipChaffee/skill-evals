import { expect, test } from "vitest";
import { pool } from "./schedule.js";

const later = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const go = (): "go" => "go";

test("pool keeps order and never exceeds the limit", async () => {
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 12 }, (_, index) => async () => {
    running++;
    peak = Math.max(peak, running);
    // The first jobs are the slowest, so they end last.
    await later((12 - index) * 3);
    running--;
    return index;
  });
  const results = await pool(jobs, 4, go);
  expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
  expect(peak).toBe(4);
});

test("a limit above the number of jobs starts them all", async () => {
  expect(
    await pool([() => Promise.resolve("a"), () => Promise.resolve("b")], 8, go),
  ).toEqual(["a", "b"]);
  expect(await pool([], 3, go)).toEqual([]);
});

test("after stop no job starts, and the ones in flight finish", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const jobs = Array.from({ length: 6 }, (_, index) => async () => {
    started.push(index);
    await later(10);
    finished.push(index);
    return index;
  });
  const results = await pool(jobs, 2, () =>
    started.length < 3 ? "go" : "stop",
  );
  expect(started).toEqual([0, 1, 2]);
  expect(finished.sort()).toEqual([0, 1, 2]);
  expect(results).toEqual([0, 1, 2, undefined, undefined, undefined]);
});

test("a job that throws rejects the pool only after every job in flight has settled", async () => {
  const settled: string[] = [];
  const jobs = [
    async () => {
      await later(30);
      settled.push("slow");
      return 1;
    },
    async () => {
      await later(5);
      throw new Error("boom");
    },
    () => {
      settled.push("never");
      return Promise.resolve(3);
    },
  ];
  await expect(pool(jobs, 2, go)).rejects.toThrow("boom");
  expect(settled).toEqual(["slow"]);
});
