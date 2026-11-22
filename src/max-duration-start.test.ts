import path from "node:path";
import { expect, test, vi } from "vitest";
import { evaluate } from "./evaluate.js";
import { asProcess, sandbox } from "./testing/sandbox.js";
import { plantSuite, startsOf } from "./testing/suite.js";

const HOUR_MS = 3_600_000;

// The output directory is opened after the subjects are exported and before the first run: an hour passes there.
vi.mock("./store.js", async (original) => {
  const real = await original<typeof import("./store.js")>();
  return {
    ...real,
    openStore: (...args: Parameters<typeof real.openStore>) => {
      vi.setSystemTime(Date.now() + HOUR_MS);
      return real.openStore(...args);
    },
  };
});

test("time spent before the run loop counts toward --max-duration", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha", "bravo"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { value } = await asProcess({ env: box.env, cwd: box.root }, () =>
      evaluate({
        subjects: ["none"],
        cases,
        reps: 1,
        outDir: path.join(box.root, "results"),
        maxDuration: 1,
      }),
    );
    expect(value.partial).toEqual({ reason: "duration" });
    expect(value.records).toHaveLength(0);
    expect(value.notRun).toHaveLength(2);
    expect(startsOf(box)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
