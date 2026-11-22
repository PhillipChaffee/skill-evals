import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { UsageError } from "./scope.js";
import { openStore, readRuns, recordOf, slotName } from "./store.js";
import type { StoredRun } from "./store.js";
import { sandbox } from "./testing/sandbox.js";

const RUNS = "results.jsonl";
const run = (more: Partial<StoredRun> = {}): StoredRun =>
  ({
    key: "k1",
    attempt: 1,
    harness: "h",
    subject: "subject",
    caseId: "c",
    rep: 1,
    error: null,
    subjectLoaded: null,
    isolated: false,
    reportMissing: false,
    unexpected: [],
    judgeProblem: null,
    checks: [],
    score: 1,
    ...more,
  }) as unknown as StoredRun;

/**
 * Makes an output directory that holds lines in results.jsonl.
 * @param lines - The text of each line, without its newline.
 * @param newline - What ends the last line.
 * @returns The path of the output directory.
 */
function holding(lines: string[], newline = "\n") {
  const box = sandbox();
  const out = path.join(box.root, "out");
  fs.mkdirSync(out);
  fs.writeFileSync(
    path.join(out, RUNS),
    lines.length === 0 ? "" : lines.join("\n") + newline,
  );
  return out;
}

test("append writes one whole line per call, and a fresh store starts the file empty", () => {
  const out = holding(["old"]);
  const store = openStore(out, false);
  expect(fs.readFileSync(path.join(out, RUNS), "utf8")).toBe("");
  store.append(run());
  store.append(run({ key: "k2" }));
  const text = fs.readFileSync(path.join(out, RUNS), "utf8");
  expect(text.split("\n")).toHaveLength(3);
  expect(text.endsWith("\n")).toBe(true);
});

test("flush replaces results.json whole and leaves no temporary file", () => {
  const out = holding([]);
  const store = openStore(out, true);
  store.flush({ records: [] } as unknown as Results);
  store.flush({ records: [run()] } as unknown as Results);
  expect(
    JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8")),
  ).toMatchObject({
    records: [{ key: "k1" }],
  });
  expect(fs.readdirSync(out).sort()).toEqual(["results.json", "results.jsonl"]);
});

test("load takes the last valid record of each key and subject, and skips invalid ones", () => {
  const out = holding([
    JSON.stringify(run({ score: 0.2 })),
    JSON.stringify(run({ score: 0.9 })),
    JSON.stringify(run({ error: "crashed", score: null })),
    JSON.stringify(run({ key: "k2", error: "crashed", score: null })),
    JSON.stringify(run({ key: "k1", subject: "b", score: 0.4 })),
  ]);
  const kept = openStore(out, true).load();
  expect([...kept.keys()].sort()).toEqual(
    [slotName("k1", "subject"), slotName("k1", "b")].sort(),
  );
  expect(kept.get(slotName("k1", "subject"))?.score).toBe(0.9);
  const record: RunRecord | undefined = kept.get(slotName("k1", "b"));
  expect(record).not.toHaveProperty("key");
  expect(record).not.toHaveProperty("attempt");
});

test("a last line that is not valid JSON is dropped once and removed from the file", () => {
  const good = JSON.stringify(run());
  const out = holding([good, '{"key": "k2", "attempt": 1, "chec'], "");
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const kept = openStore(out, true).load();
    expect(kept.size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("is not valid JSON");
  } finally {
    warn.mockRestore();
  }
  expect(fs.readFileSync(path.join(out, RUNS), "utf8")).toBe(`${good}\n`);
});

test("a line that is JSON but no run is as damaged as one that is not JSON", () => {
  for (const bad of [
    "null",
    "[]",
    '{"key": 1}',
    '{"key": "k", "attempt": 1}',
    "7",
  ]) {
    const out = holding([bad, JSON.stringify(run())]);
    expect(() => readRuns(out), bad).toThrow(UsageError);
    expect(() => readRuns(out), bad).toThrow(
      /line 1 is not a valid run record/,
    );
  }
});

test("an empty file holds no run", () => {
  const out = holding([], "");
  expect(readRuns(out)).toEqual({ lines: [], text: "", dropped: false });
});

test("recordOf takes off the key and the attempt only", () => {
  const record = recordOf(run());
  expect(Object.keys(record)).not.toContain("key");
  expect(record).toMatchObject({ harness: "h", score: 1 });
});
