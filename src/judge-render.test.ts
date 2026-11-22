import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { materialFor, renderFiles, renderTranscript } from "./judge-render.js";
import { call, result } from "./testing/transcript.js";
import { numbered, textPart } from "./transcript.js";

/**
 * Makes a workspace with files in it.
 * @param files - Relative path to content.
 * @returns The workspace directory.
 */
function workspaceWith(files: Record<string, string | Buffer>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seen-")));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  return dir;
}

/**
 * Builds a run of n tool calls with long outputs.
 * @param count - How many call and result pairs.
 * @param size - The length of each output.
 * @returns The events.
 */
const busy = (count: number, size: number) =>
  numbered([
    textPart("starting", { turn: 1 }),
    ...Array.from({ length: count }, (_, at) => [
      { ...call("Bash", { command: `step ${String(at)}` }, `c${String(at)}`) },
      result(`c${String(at)}`, `out${String(at)} ${"x".repeat(size)}`),
    ]).flat(),
  ]);

test("one line per event: position, turn, agent, role, type, and the input as compact JSON", () => {
  const events = numbered([
    textPart("hello\nthere", { turn: 1 }),
    {
      ...call("Bash", { command: "ls -l" }, "a"),
      turn: 1,
      agent: { id: "x", type: "reviewer", parent: "main", depth: 1 },
    },
    result("a", "total 0"),
  ]);
  expect(renderTranscript(events, 60_000).split("\n")).toEqual([
    "[#0 t1 main] assistant text: hello\\nthere",
    '[#1 t1 reviewer] assistant tool_call: Bash {"command":"ls -l"}',
    "[#2 t1 main] tool tool_result: total 0",
  ]);
});

test("an empty run and a failed tool result are stated", () => {
  expect(renderTranscript([], 100)).toBe("(no events)");
  const [failed] = numbered([{ ...result("a", "boom"), isError: true }]);
  expect(failed && renderTranscript([failed], 100)).toBe(
    "[#0 t- main] tool tool_result: error: boom",
  );
});

test("a rendering over maxChars cuts each output to 400 characters and says so", () => {
  const text = renderTranscript(busy(5, 1000), 4000);
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text.split("\n")[0]).toBe(
    "[… 5 tool outputs cut to 400 characters …]",
  );
  expect(text).toContain("out0 ");
  expect(text).not.toContain("x".repeat(401));
});

test("then the oldest tool outputs are dropped, and the count is stated", () => {
  const text = renderTranscript(busy(30, 1000), 3000);
  expect(text.length).toBeLessThanOrEqual(3000);
  expect(text).toMatch(/^\[… \d+ tool outputs omitted …\]/);
  const omitted = Number(/\[… (\d+) tool outputs omitted/.exec(text)?.[1]);
  expect(omitted).toBeGreaterThan(0);
  expect(text, "the oldest output went first").not.toContain("out0 ");
  expect(text, "the newest output stays").toContain("out29 ");
  expect(text, "every call stays").toContain("step 0");
});

test("when only calls and text are left and they still do not fit, the oldest events go", () => {
  const text = renderTranscript(busy(30, 10), 600);
  expect(text.length).toBeLessThanOrEqual(600);
  expect(text).toMatch(/earlier events omitted/);
  expect(text).toContain("step 29");
  expect(renderTranscript(busy(1, 10), 5).length).toBeLessThanOrEqual(5);
});

test("a rendering that fits is not marked", () => {
  expect(renderTranscript(busy(2, 10), 60_000)).not.toContain("…");
});

test("files: the named file is shown and the others are not", () => {
  const dir = workspaceWith({ "docs/plan.md": "the plan", "other.md": "no" });
  const text = renderFiles(["docs/*.md"], dir);
  expect(text).toContain('<file path="docs/plan.md">\nthe plan\n</file>');
  expect(text).not.toContain("other.md");
});

test("files: a file over 20,000 characters is cut and says so; a binary and an image are named, not shown", () => {
  const dir = workspaceWith({
    "big.txt": "y".repeat(25_000),
    "blob.dat": Buffer.from([65, 0, 66]),
    "shot.png": "not really a png",
  });
  const text = renderFiles(["*"], dir);
  expect(text).toContain("y".repeat(20_000));
  expect(text).not.toContain("y".repeat(20_001));
  expect(text).toContain("[… cut at 20000 characters …]");
  expect(text).toContain('<file path="blob.dat">not shown (binary)</file>');
  expect(text).toContain('<file path="shot.png">not shown (image)</file>');
});

test("files: no match says so, a directory name reads as the files under it, and a link out is not read", () => {
  const dir = workspaceWith({ "a/one.txt": "1", "a/b/two.txt": "2" });
  expect(renderFiles(["nope/*.md", "gone.txt"], dir)).toBe(
    "No file matches: nope/*.md, gone.txt",
  );
  const under = renderFiles(["a"], dir);
  expect(under).toContain('<file path="a/one.txt">');
  expect(under).toContain('<file path="a/b/two.txt">');
  const outside = workspaceWith({ "secret.txt": "top secret" });
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "leak.txt"));
  expect(renderFiles(["leak.txt"], dir)).not.toContain("top secret");
});

test("files: a file named twice is shown once, and a glob over the cap says so", () => {
  const dir = workspaceWith({ "a.txt": "A" });
  expect(renderFiles(["a.txt", "*.txt"], dir).match(/<file /g)).toHaveLength(1);
});

test("an event that names no tool, holds no input, or is a hook still gets a line", () => {
  const events = numbered([
    { role: "assistant", type: "tool_call" },
    { role: "assistant", type: "tool_call", kind: "shell" },
    { role: "system", type: "hook", name: "pre-commit" },
  ]);
  expect(renderTranscript(events, 1000).split("\n")).toEqual([
    "[#0 t- main] assistant tool_call: tool {}",
    "[#1 t- main] assistant tool_call: shell {}",
    "[#2 t- main] system hook: pre-commit",
  ]);
});

test("the material follows sees: the final answer by default, and only what was asked", () => {
  const outcome = { transcript: [], workspace: os.tmpdir() };
  expect(materialFor({}, outcome)).toEqual({ final: true });
  expect(materialFor({ sees: ["transcript"] }, outcome)).toEqual({
    final: false,
    transcript: "(no events)",
  });
  expect(materialFor({ sees: ["files"] }, outcome).files).toBe(
    "No file matches: ",
  );
});

test("the cut note counts only the outputs that were cut", () => {
  const events = numbered([
    { ...call("Bash", { command: "a" }, "a") },
    result("a", "short"),
    { ...call("Bash", { command: "b" }, "b") },
    result("b", "y".repeat(2000)),
  ]);
  expect(renderTranscript(events, 1200).split("\n")[0]).toBe(
    "[… 1 tool outputs cut to 400 characters …]",
  );
});

test("a last event that alone is over the limit is cut, and the text says so", () => {
  const events = numbered([textPart("z".repeat(500), { turn: 1 })]);
  const text = renderTranscript(events, 100);
  expect(text.length).toBeLessThanOrEqual(100);
  expect(text).toMatch(/\[… last event cut …\]$/);
});

test("files: a glob over the cap and a directory that cannot be listed are stated", () => {
  const dir = workspaceWith({ "keep/a.txt": "A", "locked/b.txt": "B" });
  for (let at = 0; at < 5001; at += 1) {
    fs.writeFileSync(path.join(dir, `keep/f${String(at)}.dat`), "");
  }
  const capped = renderFiles(["keep/*"], dir);
  expect(capped).toContain(
    '[… "keep/*" matches more than 5000 paths, so none of it is shown …]',
  );
  expect(capped).not.toContain("<file ");

  const list = fs.readdirSync.bind(fs);
  const spy = vi.spyOn(fs, "readdirSync").mockImplementation(((
    target: string,
    options: unknown,
  ) => {
    if (target.endsWith("/locked")) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return (list as (...args: unknown[]) => unknown)(target, options);
  }) as unknown as typeof fs.readdirSync);
  try {
    const text = renderFiles(["locked/*"], dir);
    expect(text).toContain("No file matches: locked/*");
    expect(text).toContain("[… locked cannot be listed …]");
  } finally {
    spy.mockRestore();
  }
});

test("files: only the start of a big file is read", () => {
  const dir = workspaceWith({ "big.txt": "é".repeat(60_000) });
  const text = renderFiles(["big.txt"], dir);
  expect(text).toContain("[… cut at 20000 characters …]");
  expect(text.length).toBeLessThan(20_200);
});
