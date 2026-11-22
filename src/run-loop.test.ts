import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { basePlan, prepare, resolveAll } from "./prepare.js";
import { FLUSH_INTERVAL_MS, runAll } from "./run-loop.js";
import { openStore } from "./store.js";
import type { RunRecord } from "./run.js";
import type { Subject } from "./subject.js";
import { asProcess, sandbox } from "./testing/sandbox.js";
import { plantSuite } from "./testing/suite.js";

test("results.json is rewritten once at the start and then by the interval, not after every run", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha", "bravo", "charlie"]);
  const out = path.join(box.root, "results");
  fs.mkdirSync(out);
  const clock = { now: 0 };
  const writes: number[] = [];
  await asProcess({ env: box.env, cwd: box.root }, async () => {
    const prepared = prepare({
      subjects: ["none"],
      cases,
      reps: 1,
      outDir: out,
    });
    const subjects: Subject[] = [];
    resolveAll(prepared, subjects);
    await runAll(
      {
        ...basePlan(prepared.context, subjects, out),
        useCache: false,
        store: openStore(out, false),
        reused: new Map<string, RunRecord>(),
        flush: (records) => {
          writes.push(records.length);
        },
        onRun: () => {
          // Each run takes two intervals of the fake clock.
          clock.now += FLUSH_INTERVAL_MS * 2;
        },
      },
      () => clock.now,
    );
  });
  // The seed write, then the runs that ended an interval after the last write: the second and the third.
  expect(writes).toEqual([0, 2, 3]);
});
