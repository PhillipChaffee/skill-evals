import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { LINTS } from "./commands/validate.js";
import { diffResults } from "./diff.js";
import { EXIT } from "./exit-codes.js";
import { invalidReason } from "./run.js";
import { script } from "./testing/plant.js";
import { record, results } from "./testing/diff.js";
import { scoreSubject } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";

const WHICH = "Which database";
const askCall = (question: string) => ({
  call: {
    name: "AskUserQuestion",
    input: { questions: [{ question }] },
    denied: true,
  },
});
const SHELL = { call: { name: "Bash", input: { command: "true" } } };
const reply = (more: Record<string, unknown> = {}) => ({
  reply: { whenAsked: WHICH, prompt: "answer.md" },
  ...more,
});

/**
 * Plants a case of prompt files and turns, and the script its first prompt matches.
 * @param box - The sandbox.
 * @param file - The keys of the case file.
 * @param turns - What the agent does in each process.
 */
function plant(
  box: Sandbox,
  file: Record<string, unknown>,
  turns: Record<string, unknown>[][],
) {
  box.write("cases/c/one.md", "do c");
  box.write("cases/c/answer.md", "Use postgres.");
  box.write("cases/c/case.json", file);
  script(box, "c", { match: { prompt: "do c" }, turns: turns as never });
}

const score = (box: Sandbox) =>
  scoreSubject(box, {
    subject: "none",
    cases: path.join(box.root, "cases"),
    env: { PATH: `${String(box.env["PATH"])}:/usr/local/bin:/usr/bin:/bin` },
  });

const PLAIN = [{ final: "thanks" }];

test("a run whose only checks are on an unasked reply is invalid, with its reason", async () => {
  const box = sandbox();
  plant(
    box,
    {
      turns: [
        { prompt: "one.md" },
        reply({ checks: [{ type: "output_contains", text: "x" }] }),
      ],
    },
    [[{ final: "done" }]],
  );
  const { status, records } = await score(box);
  expect(status).toBe(EXIT.invalid);
  expect(records[0]?.score).toBeNull();
  expect(invalidReason(records[0] as never)).toBe(
    "nothing was scored: every check is on a reply turn that was not asked (turn 2)",
  );
});

test("a reply after a clear is not sent: the question was asked in another session", async () => {
  const box = sandbox();
  plant(
    box,
    {
      turns: [
        { prompt: "one.md" },
        { event: "clear" },
        reply({ checks: [{ type: "output_contains", text: "x" }] }),
      ],
      checks: [{ type: "ended_awaiting_user" }],
    },
    [[askCall(`${WHICH}?`)], PLAIN],
  );
  const { records } = await score(box);
  expect(records[0]?.userTurns?.map(({ skipped }) => skipped)).toEqual([
    null,
    null,
    "not asked",
  ]);
  expect(records[0]?.userTurns?.[2]?.why).toBe(
    "no turn has been sent in this session",
  );
  expect(records[0]?.checks[1]).toMatchObject({ notScored: true });
});

test("a reply answers the question the turn ended on, not an earlier one", async () => {
  const box = sandbox();
  const turns = [
    { prompt: "one.md" },
    reply({ checks: [{ type: "output_matches", pattern: "thanks" }] }),
  ];
  const checks = [{ type: "asked_user", min: 2 }];
  // An earlier question matches, the agent went on, and it ended on another: the reply is not sent.
  plant(box, { turns, checks }, [
    [askCall(`${WHICH}?`), SHELL, askCall("Deploy now?")],
    PLAIN,
  ]);
  const { records } = await score(box);
  expect(records[0]?.userTurns?.[1]).toMatchObject({
    skipped: "not asked",
    why: `no question of turn 1 matches /${WHICH}/`,
  });
});

test("every question of the message the turn ended on counts", async () => {
  const box = sandbox();
  const turns = [
    { prompt: "one.md" },
    reply({ checks: [{ type: "output_matches", pattern: "thanks" }] }),
  ];
  const checks = [{ type: "asked_user", min: 2 }];
  plant(box, { turns, checks }, [
    [{ parallel: [askCall("Deploy now?"), askCall(`${WHICH}?`)] }],
    PLAIN,
  ]);
  const { records } = await score(box);
  expect(records[0]?.userTurns?.map(({ skipped }) => skipped)).toEqual([
    null,
    null,
  ]);
  expect(records[0]?.score).toBe(1);
});

test("a reply turn with nothing that checks the question is a warning", () => {
  const box = sandbox();
  const planted = (file: Record<string, unknown>) => {
    box.write("cases/c/one.md", "do c");
    box.write("cases/c/answer.md", "Use postgres.");
    box.write("cases/c/case.json", file);
    return loadCases(path.join(box.root, "cases"));
  };
  const lint = (cases: ReturnType<typeof planted>) =>
    LINTS.flatMap((one) =>
      one(cases, { subject: null, casesDir: "c", harnesses: [] } as never),
    ).filter(({ text }) => text.includes("is a reply"));
  const any = { type: "output_matches", pattern: "." };
  const bare = planted({
    turns: [{ prompt: "one.md" }, reply()],
    checks: [any],
  });
  expect(lint(bare)).toHaveLength(1);
  const early = planted({
    turns: [
      { prompt: "one.md", checks: [{ type: "ended_awaiting_user" }] },
      reply(),
    ],
    checks: [any],
  });
  expect(lint(early)).toEqual([]);
  const wide = planted({
    turns: [{ prompt: "one.md" }, reply()],
    checks: [{ type: "asked_user" }],
  });
  expect(lint(wide)).toEqual([]);
});

test("diff leaves a check that was never scored out of its means", () => {
  const unscored = (): ReturnType<typeof record> => {
    const one = record([1, 1]);
    return {
      ...one,
      checks: [
        one.checks[0],
        { ...one.checks[1], score: null, notScored: true },
      ],
    } as never;
  };
  const diff = diffResults(results([record([1, 1])]), results([unscored()]));
  const [one] = diff.sections[0]?.cases ?? [];
  expect(one?.newlyFailing).toEqual([]);
  expect(one?.newlyPassing).toEqual([]);
});
