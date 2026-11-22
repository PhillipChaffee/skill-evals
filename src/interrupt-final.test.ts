import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { evaluate } from "./evaluate.js";
import { asProcess, readResults, sandbox } from "./testing/sandbox.js";
import { plantSuite } from "./testing/suite.js";

const INTERRUPTED = 130;
const seen: { out: string; partial: unknown } = { out: "", partial: undefined };

// The check of the subjects after the last run is where the command spends its last moments.
vi.mock("./subject.js", async (original) => {
  const real = await original<typeof import("./subject.js")>();
  return {
    ...real,
    changedAtSource: (...args: Parameters<typeof real.changedAtSource>) => {
      process.emit("SIGINT");
      // What the signal left on disk, before the final write replaces it.
      const file = path.join(seen.out, "results.json");
      seen.partial = (
        JSON.parse(fs.readFileSync(file, "utf8")) as { partial: unknown }
      ).partial;
      return real.changedAtSource(...args);
    },
  };
});

test("a signal after the last run and before the final write still leaves partial interrupted", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const out = path.join(box.root, "results");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    seen.out = out;
    await asProcess({ env: box.env, cwd: box.root }, () =>
      evaluate({ subjects: ["none"], cases, reps: 1, outDir: out }),
    );
    expect(exit).toHaveBeenCalledWith(INTERRUPTED);
    expect(seen.partial).toEqual({ reason: "interrupted" });
    // With the mocked exit the command went on to its normal end.
    expect(readResults(out).partial).toBeNull();
  } finally {
    exit.mockRestore();
  }
});
