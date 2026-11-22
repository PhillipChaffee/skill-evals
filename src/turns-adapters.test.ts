import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import claudeCode from "./harnesses/claude-code.js";
import { HARNESSES } from "./harnesses/index.js";
import { firstTurn, placeSkills } from "./harnesses/shared.js";
import { tempDir } from "./scope.js";
import { lines, parseText } from "./testing/streams.js";

const CLAUDE_CODE = "claude-code";

/**
 * Builds the command line of Claude Code for a turn.
 * @param more - The turn's session and message.
 * @param more.session - The id to continue.
 * @param more.message - The text sent.
 * @returns The arguments.
 */
function argsOf(more: { session: string | null; message: string }): string[] {
  const home = tempDir("home-");
  onTestFinished(home.dispose);
  return claudeCode.invocation({
    subject: null,
    home: home.dir,
    workspace: home.dir,
    prompt: more.message,
    ...firstTurn(more.message),
    session: more.session,
  }).args;
}

test("Claude Code continues a session with --resume, and starts a new one without it", () => {
  const first = argsOf({ session: null, message: "go" });
  expect(first).not.toContain("--resume");
  const next = argsOf({ session: "abc-123", message: "again" });
  // The flag comes before the `--` that ends the options, so the prompt cannot be read as one.
  expect(next.slice(next.indexOf("--resume"))).toEqual([
    ...["--resume", "abc-123", "--", "again"],
  ]);
});

test("only an adapter with a confirmed syntax declares userInvoke, and only Claude Code declares multiTurn", () => {
  for (const harness of HARNESSES) {
    expect(harness.userInvocation !== undefined, harness.id).toBe(
      harness.capabilities.has("userInvoke"),
    );
  }
  expect(
    HARNESSES.filter(({ capabilities }) => capabilities.has("multiTurn")).map(
      ({ id }) => id,
    ),
  ).toEqual([CLAUDE_CODE]);
  // Compaction is unconfirmed for every adapter, so no adapter declares it.
  expect(
    HARNESSES.filter(({ capabilities }) => capabilities.has("compact")),
  ).toEqual([]);
});

test("a compact_boundary event of Claude Code's stream is a lifecycle event, and the session id is read", () => {
  const parsed = parseText(
    CLAUDE_CODE,
    lines(
      {
        type: "system",
        subtype: "init",
        session_id: "s-1",
        plugins: [],
        skills: [],
      },
      { type: "system", subtype: "compact_boundary", session_id: "s-1" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        session_id: "s-1",
      },
    ),
  );
  expect(parsed.sessionId).toBe("s-1");
  expect(parsed.transcript).toMatchObject([
    { type: "lifecycle", role: "system", name: "compact" },
  ]);
  expect(parsed.toolCalls).toEqual([]);
});

test("a skill copy that a later turn finds in place is kept, with what the agent changed in it", () => {
  const source = tempDir("kit-");
  const home = tempDir("home-");
  onTestFinished(() => {
    source.dispose();
    home.dispose();
  });
  fs.mkdirSync(path.join(source.dir, "greet"));
  fs.writeFileSync(path.join(source.dir, "greet", "SKILL.md"), "original\n");
  const subject = {
    kind: "skills" as const,
    dir: source.dir,
    skills: ["greet"],
    skillDirs: { greet: path.join(source.dir, "greet") },
  };
  const target = path.join(home.dir, "skills");
  placeSkills(subject, target);
  fs.writeFileSync(
    path.join(target, "greet", "SKILL.md"),
    "edited by the agent\n",
  );
  const placed = placeSkills(subject, target);
  expect(placed).toEqual({ greet: path.join(target, "greet") });
  expect(fs.readFileSync(path.join(target, "greet", "SKILL.md"), "utf8")).toBe(
    "edited by the agent\n",
  );
});
