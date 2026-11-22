import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  installClaudeHistory,
  installClaudeSessions,
  projectName,
} from "./harnesses/claude-code-history.js";
import type { PriorSession } from "./history-types.js";
import { twelveMessages } from "./testing/history-case.js";

/** One line of a session file, as far as the tests read it. */
interface Line {
  uuid: string;
  parentUuid: string | null;
  type: string;
  cwd: string;
  sessionId: string;
  message: { role: string; content: unknown };
}

const PROJECTS = ".claude/projects";
const OLDER: PriorSession = {
  id: "older-one",
  startedAt: "2026-01-05T09:00:00Z",
  messages: [
    { role: "user", text: "start the migration" },
    { role: "assistant", text: "migration started" },
  ],
};
const NEWER: PriorSession = {
  id: "newer-one",
  startedAt: "2026-01-06T09:00:00Z",
  cwd: "/srv/other project",
  messages: [{ role: "user", text: "check the cache" }],
};

/**
 * Makes a throwaway home and workspace, removed when the callback returns.
 * @param use - Gets the two directories.
 * @returns What `use` returns.
 */
function inDirs<T>(use: (where: { home: string; workspace: string }) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ws-")),
  );
  try {
    return use({ home, workspace });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Reads a session file.
 * @param file - Its path.
 * @returns Its lines.
 */
const linesOf = (file: string): Line[] =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);

test("sessions are written as Claude Code's project files, one JSON object per line", () => {
  inDirs((where) => {
    installClaudeSessions([OLDER, NEWER], where);
    // `<config dir>/projects/<working directory, every character but a letter or digit as "-">/<id>.jsonl`.
    const projects = path.join(where.home, PROJECTS);
    const own = path.join(
      projects,
      projectName(where.workspace),
      "older-one.jsonl",
    );
    const [first, second] = linesOf(own);
    expect(first).toMatchObject({
      parentUuid: null,
      type: "user",
      cwd: where.workspace,
      sessionId: "older-one",
      message: { role: "user", content: "start the migration" },
    });
    expect(second).toMatchObject({
      parentUuid: first?.uuid,
      type: "assistant",
    });
    expect(second?.message.content).toEqual([
      { type: "text", text: "migration started" },
    ]);
    // A session with its own directory is under that directory's name.
    expect(
      fs.existsSync(path.join(projects, "-srv-other-project/newer-one.jsonl")),
    ).toBe(true);
  });
  // A name past 200 characters is cut and gets the hash of the whole path, as the binary does.
  expect(projectName("/a".repeat(150))).toMatch(/^(-a){100}-[0-9a-z]+$/);
});

test("a tool call is a tool_use block, and its result is the next line", () => {
  inDirs((where) => {
    const { session } = installClaudeHistory(twelveMessages(), where);
    const file = path.join(
      where.home,
      PROJECTS,
      projectName(where.workspace),
      `${session}.jsonl`,
    );
    const lines = linesOf(file);
    expect(lines).toHaveLength(13);
    const calling = lines[3];
    expect(calling?.type).toBe("assistant");
    const blocks = calling?.message.content as { type: string; id?: string }[];
    expect(blocks.map(({ type }) => type)).toEqual(["text", "tool_use"]);
    expect(lines[4]?.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: blocks[1]?.id,
        content: "nothing to commit",
      },
    ]);
    expect(lines.map(({ parentUuid }) => parentUuid)).toEqual([
      null,
      ...lines.slice(0, -1).map(({ uuid }) => uuid),
    ]);
  });
});

test("the same history is written to the same session every time", () => {
  const ids = [0, 1].map(() =>
    inDirs((where) => installClaudeHistory(twelveMessages(), where).session),
  );
  expect(ids[0]).toBe(ids[1]);
  expect(ids[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("an assistant message with no text and no calls cannot be written as a session", () => {
  inDirs((where) => {
    expect(() =>
      installClaudeHistory([{ role: "assistant", text: "" }], where),
    ).toThrow(/message 1 has no text and no calls/);
  });
});

test("a call with no output gets an empty result, and an assistant message may be only calls", () => {
  inDirs((where) => {
    const { session } = installClaudeHistory(
      [
        { role: "user", text: "go" },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ name: "Bash", input: {} }],
        },
      ],
      where,
    );
    const file = path.join(
      where.home,
      PROJECTS,
      projectName(where.workspace),
      `${session}.jsonl`,
    );
    const [, calling, result] = linesOf(file);
    expect((calling?.message.content as unknown[]).length).toBe(1);
    expect(result?.message.content).toMatchObject([
      { type: "tool_result", content: "" },
    ]);
  });
});
