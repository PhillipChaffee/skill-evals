import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantBlind as plant, validated } from "./testing/blinding.js";
import { sandbox } from "./testing/sandbox.js";

test("turn files and replies are scanned, and the skill name of an invocation is not", async () => {
  const box = sandbox();
  plant(box, "t", {
    prompt: "",
    file: {
      turns: [
        { prompt: "turn-1.md" },
        { invoke: { skill: "benchmark", args: "run the candidate" } },
        { reply: { whenAsked: "which", prompt: "turn-3.md" } },
        { event: "clear" },
      ],
    },
    files: { "turn-1.md": "go\n", "turn-3.md": "use the rubric\n" },
  });
  fs.rmSync(`${box.root}/cases/t/prompt.md`);
  const { lines } = await validated(box, [], { benchmark: "# b\n" });
  const text = lines.join("\n");
  expect(text).toContain('turn 2 (an invocation) holds "candidate"');
  expect(text).toContain('turn 3 (a reply) holds "rubric"');
  expect(text).not.toContain('"benchmark"');
});

test("a hit in a mock MCP description, schema, response or name warns", async () => {
  const box = sandbox();
  const tool = {
    description: "Runs the benchmark",
    inputSchema: {
      type: "object",
      properties: { candidate_id: { description: "which judge" } },
    },
    responses: [{ text: "the arena is open" }],
  };
  plant(box, "m", { files: { "mcp/tracker/run_test.json": tool } });
  const text = (await validated(box)).lines.join("\n");
  expect(text).toContain(
    'the description of mcp/tracker/run_test.json holds "benchmark"',
  );
  expect(text).toContain(
    'the input schema of mcp/tracker/run_test.json holds "candidate"',
  );
  expect(text).toContain(
    'the input schema of mcp/tracker/run_test.json holds "judge"',
  );
  expect(text).toContain(
    'a response of mcp/tracker/run_test.json holds "arena"',
  );
  expect(text).toContain('the name of mcp/tracker/run_test.json holds "test"');
});

test("a hit in history text, a tool call of it or a prior session warns", async () => {
  const box = sandbox();
  plant(box, "h", {
    files: {
      "history.json": [
        { role: "user", text: "please run the tests" },
        {
          role: "assistant",
          text: "ok",
          toolCalls: [
            { name: "Bash", input: { command: "ls" }, output: "experiment.md" },
          ],
        },
      ],
      "sessions/sessions.json": [
        {
          id: "earlier",
          startedAt: "2026-01-05T09:00:00Z",
          messages: [{ role: "user", text: "compare the two" }],
        },
      ],
    },
  });
  const text = (await validated(box)).lines.join("\n");
  expect(text).toContain('history.json, message 1 holds "test"');
  expect(text).toContain('a tool call of message 2 holds "experiment"');
  expect(text).toContain('session earlier, message 1 holds "compare"');
});

test("the names of files under workspace, a fixture and home are scanned, not their contents", async () => {
  const box = sandbox();
  plant(box, "p", {
    file: { fixtures: ["../_shared"], home: "home" },
    files: {
      "workspace/notes.txt": "a test inside\n",
      "workspace/tests/a.ts": "x",
      "workspace/tests/b.ts": "x",
      "workspace/tests/c.ts": "x",
      "workspace/tests/d.ts": "x",
      "home/.config/benchmark.json": "{}",
    },
  });
  box.write("cases/_shared/arena-map.txt", "x");
  const text = (await validated(box)).lines.join("\n");
  expect(text).toContain(
    'workspace/ holds "test" in 5 paths, which may tell the agent that it is being evaluated: tests, tests/a.ts, tests/b.ts and 2 more',
  );
  expect(text).toContain('_shared/ holds "arena" in 1 path,');
  expect(text).toContain('home/ holds "benchmark" in 1 path,');
  expect(text).not.toContain("a test inside");
});

test("validate --deep runs setup and scans what it made; plain validate never runs it", async () => {
  const box = sandbox();
  const marker = path.join(box.root, "setup-ran.txt");
  plant(box, "s", {
    file: {
      setup: [
        { run: `echo ran >> ${marker}; echo x > arena-one.txt` },
        { run: "echo x > arena-two.txt; echo x > notes.txt" },
      ],
    },
    files: { "workspace/notes.txt": "x" },
  });
  const plain = await validated(box);
  expect(plain.lines).toEqual(["1 cases, 0 problems, 0 warnings"]);
  expect(fs.existsSync(marker)).toBe(false);

  const deep = await validated(box, ["--deep"]);
  expect(deep.status).toBe(0);
  expect(deep.lines.join("\n")).toContain(
    'warning s: the workspace after setup holds "arena" in 2 paths',
  );
  expect(fs.readFileSync(marker, "utf8")).toBe("ran\n");
  // Not the paths that the case's own files already had, which plain validate reports.
  expect(deep.lines.join("\n")).not.toContain("notes.txt");
});

test("validate --deep says when a setup step fails, and when the case has none", async () => {
  const box = sandbox();
  plant(box, "bad", { file: { setup: [{ run: "exit 3" }] } });
  plant(box, "none");
  const { status, lines } = await validated(box, ["--deep"]);
  expect(status).toBe(0);
  expect(lines.join("\n")).toMatch(
    /warning bad: --deep could not scan the paths of setup: setup failed/,
  );
  expect(lines.at(-1)).toBe("2 cases, 0 problems, 1 warnings");
});
