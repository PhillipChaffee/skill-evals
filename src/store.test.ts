import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { LINE_FIELDS } from "./store-shape.js";
import { UsageError } from "./scope.js";
import {
  openStore,
  readRuns,
  recordOf,
  requireFresh,
  slotName,
} from "./store.js";
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
    ok: true,
    error: null,
    finalText: "",
    durationMs: 0,
    tokens: null,
    costUsd: null,
    judge: null,
    decision: null,
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

test("load reuses a record only when it is valid and the last line of its stem", () => {
  const out = holding([
    JSON.stringify(run({ score: 0.2 })),
    JSON.stringify(run({ score: 0.9 })),
    JSON.stringify(run({ rep: 2, score: 0.5 })),
    JSON.stringify(run({ rep: 2, error: "crashed", score: null })),
    JSON.stringify(run({ rep: 3, key: "k2", error: "crashed", score: null })),
    JSON.stringify(run({ subject: "b", score: 0.4 })),
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

test("a stem whose last line has another key is not reused under the older key", () => {
  const out = holding([
    JSON.stringify(run({ key: "old" })),
    JSON.stringify(run({ key: "new" })),
  ]);
  const kept = openStore(out, true).load();
  expect([...kept.keys()]).toEqual([slotName("new", "subject")]);
});

test("a last line that is not valid JSON is dropped once and removed from the file", () => {
  const good = JSON.stringify(run());
  const out = holding([good, '{"key": "k2", "attempt": 1, "chec'], "");
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const kept = openStore(out, true).load();
    expect(kept.size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "is not a valid run record",
    );
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
    JSON.stringify({ ...run(), checks: [null] }),
    JSON.stringify({ ...run(), harness: undefined }),
    JSON.stringify({ ...run(), unexpected: undefined }),
    JSON.stringify({ ...run(), rep: "1" }),
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

test("load rewrites the file through a temporary file that does not stay", () => {
  const out = holding([JSON.stringify(run()), "{cut"], "");
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    openStore(out, true).load();
  } finally {
    warn.mockRestore();
  }
  expect(fs.readdirSync(out)).toEqual([RUNS]);
});

test("a directory that holds runs is refused for a fresh command, and one that holds none is not", () => {
  const out = holding([JSON.stringify(run()), JSON.stringify(run({ rep: 2 }))]);
  expect(() => {
    requireFresh(out);
  }).toThrow(/holds 2 runs of an earlier command; pass --resume/);
  fs.writeFileSync(path.join(out, RUNS), "");
  requireFresh(out);
  fs.rmSync(path.join(out, RUNS));
  requireFresh(out);
});

test("a line that lacks any field that the report, the progress line or a resume reads is refused", () => {
  const fields = Object.keys(LINE_FIELDS);
  expect(fields).toContain("score");
  for (const field of fields) {
    const whole = Object.fromEntries(
      Object.entries(run()).filter(([name]) => name !== field),
    );
    const out = holding([JSON.stringify(whole), JSON.stringify(run())]);
    expect(() => readRuns(out), field).toThrow(
      /line 1 is not a valid run record/,
    );
  }
  // And one that has the field with the wrong kind of value.
  const out = holding([
    JSON.stringify({ ...run(), score: "1" }),
    JSON.stringify(run()),
  ]);
  expect(() => readRuns(out)).toThrow(/line 1/);
  const checks = holding([
    JSON.stringify({ ...run(), checks: [{ score: "x" }] }),
    JSON.stringify(run()),
  ]);
  expect(() => readRuns(checks)).toThrow(/line 1/);
});

test("a line whose judge or decision totals have the wrong shape is refused", () => {
  const usage = {
    calls: 1,
    durationMs: 5,
    tokens: { input: 1, output: 2 },
    costUsd: 0.1,
    cacheHits: 1,
  };
  expect(() =>
    readRuns(
      holding([JSON.stringify({ ...run(), judge: usage, decision: usage })]),
    ),
  ).not.toThrow();
  const bad: unknown[] = [
    {},
    { ...usage, calls: "1" },
    { ...usage, durationMs: null },
    { ...usage, costUsd: "x" },
    { ...usage, cacheHits: "1" },
    { ...usage, tokens: { input: "1" } },
    { ...usage, tokens: 5 },
  ];
  for (const field of ["judge", "decision"]) {
    for (const value of bad) {
      const out = holding([
        JSON.stringify({ ...run(), [field]: value }),
        JSON.stringify(run()),
      ]);
      expect(() => readRuns(out), `${field} ${JSON.stringify(value)}`).toThrow(
        /line 1 is not a valid run record/,
      );
    }
  }
});
