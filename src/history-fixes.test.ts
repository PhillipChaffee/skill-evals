import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { childEnv } from "./env.js";
import { HARNESSES } from "./harnesses/index.js";
import {
  installClaudeHistory,
  installClaudeSessions,
  projectName,
} from "./harnesses/claude-code-history.js";
import { plantHistory } from "./history-plant.js";
import type { PriorSession } from "./history-types.js";
import {
  plantSeeded,
  scoreSeeded,
  twelveMessages,
} from "./testing/history-case.js";
import { nativeHistory } from "./testing/native-history.js";
import { sandbox } from "./testing/sandbox.js";

const PROJECTS = ".claude/projects";
const SESSION: PriorSession = {
  id: "earlier",
  startedAt: "2026-06-01T00:00:00Z",
  messages: [{ role: "user", text: "hi" }],
};

/**
 * Makes a throwaway home and workspace and removes them when the callback returns.
 * @param use - Gets the two directories.
 */
function inDirs(
  use: (where: { home: string; workspace: string }) => void,
): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fix-"));
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ws-")),
  );
  try {
    use({ home, workspace });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("a prompt that starts with a slash is not applicable under preamble, as a first-turn invoke is", async () => {
  const box = sandbox();
  plantSeeded(box, "slash", {
    history: twelveMessages(),
    prompt: "/release-notes v2",
  });
  plantSeeded(box, "plain");
  const { results } = await scoreSeeded(box);
  expect(results?.notApplicable).toEqual([
    expect.objectContaining({ caseId: "slash", missing: ["historyNative"] }),
  ]);
  // The same words that do not start the message are fine.
  const fine = sandbox();
  plantSeeded(fine, "ok", {
    history: twelveMessages(),
    prompt: "Please run /release-notes v2",
  });
  expect((await scoreSeeded(fine)).results?.notApplicable).toEqual([]);
});

test("validate and explain honour the config historyMode", async () => {
  const box = sandbox();
  plantSeeded(box, "seeded", { history: twelveMessages() });
  box.write("skill-evals.config.json", { historyMode: "native" });
  const cases = path.join(box.root, "cases");
  const validated = await box.cli([
    "validate",
    "--cases",
    cases,
    "--subject",
    "none",
  ]);
  expect(validated.stdout).toMatch(
    /not applicable on claude-code: needs historyNative/,
  );
  const explained = await box.cli(["explain", "seeded", "--cases", cases]);
  expect(explained.stdout).toMatch(
    /claude-code .*: not applicable, needs historyNative/,
  );
  box.write("skill-evals.config.json", { historyMode: "preamble" });
  const again = await box.cli(["explain", "seeded", "--cases", cases]);
  expect(again.stdout).toMatch(/claude-code .*: applicable/);
});

test("the active session is dated after the latest earlier session, and its ids differ from the line ids", () => {
  inDirs((where) => {
    const history = twelveMessages();
    const planted = plantHistory(
      {
        harness: nativeHistory,
        layers: { history, sessions: [SESSION] },
        historyMode: "native",
      },
      where,
    );
    expect(planted.failure).toBeNull();
    const dir = path.join(where.home, PROJECTS, projectName(where.workspace));
    const read = (id: string) =>
      fs
        .readFileSync(path.join(dir, `${id}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              timestamp: string;
              uuid: string;
              type: string;
              message: { id?: string };
            },
        );
    const earlier = read("earlier");
    const active = read(planted.session ?? "");
    expect(Date.parse(active[0]?.timestamp ?? "")).toBeGreaterThan(
      Date.parse(earlier.at(-1)?.timestamp ?? ""),
    );
    for (const line of active.filter(({ type }) => type === "assistant")) {
      const hex = line.uuid.replaceAll("-", "").slice(0, 24);
      expect(line.message.id).not.toBe(`msg_${hex}`);
    }
  });
});

test("planting refuses a link on its path", () => {
  inDirs((where) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
    fs.mkdirSync(path.join(where.home, ".claude"));
    fs.symlinkSync(elsewhere, path.join(where.home, PROJECTS));
    expect(() => {
      installClaudeSessions([SESSION], where);
    }).toThrow(/is a link, and nothing is planted through a link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(path.join(where.home, PROJECTS));
    const target = path.join(elsewhere, "x.jsonl");
    fs.mkdirSync(
      path.join(where.home, PROJECTS, projectName(where.workspace)),
      { recursive: true },
    );
    fs.symlinkSync(
      target,
      path.join(
        where.home,
        PROJECTS,
        projectName(where.workspace),
        "earlier.jsonl",
      ),
    );
    expect(() => {
      installClaudeSessions([SESSION], where);
    }).toThrow(/is a link/);
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(elsewhere, { recursive: true, force: true });
    // Nothing is left of a link-free path: the history of the same workspace is written under its own home.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "h-"));
    const { session } = installClaudeHistory(twelveMessages(), {
      home: fresh,
      workspace: where.workspace,
    });
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});

test("CLAUDE_CODE_PROJECT_DIR_NAME is never passed to Claude Code, whose adapter scrubs it", () => {
  const claude = HARNESSES.find(({ id }) => id === "claude-code");
  expect(claude?.scrubEnv).toEqual(["CLAUDE_CODE_PROJECT_DIR_NAME"]);
  const env = childEnv({
    scrubEnv: claude?.scrubEnv,
    home: "/h",
    base: { CLAUDE_CODE_PROJECT_DIR_NAME: "x", PATH: "/bin" },
    harnessEnv: {},
    authEnv: ["CLAUDE_CODE_PROJECT_DIR_NAME"],
    pass: ["CLAUDE_CODE_PROJECT_DIR_NAME"],
    withhold: [],
    caseEnv: {},
  });
  expect(env["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBeUndefined();
  expect(env["PATH"]).toBe("/bin");
});
