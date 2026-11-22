import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { script } from "./testing/plant.js";
import { exec, play, scoreSubject } from "./testing/runs.js";
import type { Sandbox } from "./testing/sandbox.js";
import { sandbox } from "./testing/sandbox.js";
import { failure } from "./testing/turns-case.js";
import { scored } from "./testing/turns-run.js";

// A `-p` process refuses the question tool, and lists the refusal among the result's `permission_denials`.
const ask = (question: string, denied = false) => ({
  call: {
    name: "AskUserQuestion",
    input: { questions: [{ question, options: [{ label: "a" }] }] },
    ...(denied ? { denied } : {}),
  },
});
const WHICH = "Which database";
const REPLY = (when: string) => ({
  reply: { whenAsked: when, prompt: "answer.md" },
});

/**
 * Plants a case of prompt files and turns.
 * @param box - The sandbox.
 * @param id - The case's id; its first prompt is `do <id>`, which its script matches.
 * @param file - The keys of the case file.
 */
function plant(box: Sandbox, id: string, file: Record<string, unknown>) {
  box.write(`cases/${id}/one.md`, `do ${id}`);
  box.write(`cases/${id}/answer.md`, "Use postgres.");
  box.write(`cases/${id}/three.md`, "And then tidy up.");
  box.write(`cases/${id}/case.json`, file);
}

const score = (box: Sandbox) =>
  scoreSubject(box, {
    subject: "none",
    cases: path.join(box.root, "cases"),
    env: { PATH: `${String(box.env["PATH"])}:/usr/local/bin:/usr/bin:/bin` },
  });

/**
 * Plants three cases: one whose agent asks what the reply answers, one whose agent does not ask, and one whose agent
 * asks something else.
 * @param box - The sandbox.
 */
function plantAsking(box: Sandbox) {
  const migrating = { type: "output_contains", text: "migrating postgres" };
  plant(box, "asks", {
    turns: [
      { prompt: "one.md", checks: [{ type: "ended_awaiting_user" }] },
      { ...REPLY(WHICH), checks: [migrating] },
    ],
  });
  plant(box, "silent", {
    turns: [
      { prompt: "one.md" },
      { ...REPLY(WHICH), checks: [migrating] },
      { prompt: "three.md" },
    ],
    checks: [{ type: "output_matches", pattern: "^resumed fake-session-" }],
  });
  plant(box, "other", {
    turns: [{ prompt: "one.md" }, REPLY(WHICH)],
    checks: [{ type: "output_contains", text: "colour" }],
  });
  const answers = [{ final: "migrating postgres" }];
  script(box, "a", {
    match: { prompt: "do asks" },
    turns: [[ask("Which database should I migrate?")], answers],
  });
  script(box, "b", {
    match: { prompt: "do silent" },
    turns: [[{ final: "done." }], [{ final: "resumed $RESUMED" }]],
  });
  script(box, "c", {
    match: { prompt: "do other" },
    turns: [[ask("Which colour?"), { final: "colour" }]],
  });
}

test("a reply turn is sent only when the agent asked", async () => {
  const box = sandbox();
  plantAsking(box);
  const { status, stderr, records } = await score(box);
  expect(status, stderr).toBe(0);
  const by = (id: string) => records.find(({ caseId }) => caseId === id);
  // The agent asked, and the question matches: the reply is sent, its checks scored.
  expect(by("asks")?.userTurns?.map(({ skipped }) => skipped)).toEqual([
    null,
    null,
  ]);
  expect(by("asks")?.score).toBe(1);
  // It did not ask: the reply is not sent, the third turn is, and the session goes on from turn 1.
  const silent = by("silent");
  expect(silent?.userTurns?.map(({ skipped }) => skipped)).toEqual([
    null,
    "not asked",
    null,
  ]);
  expect(silent?.userTurns?.[1]?.why).toBe(
    "turn 1 did not end by asking the user",
  );
  expect(silent?.error).toBeNull();
  expect(silent?.finalText).toMatch(/^resumed fake-session-\d+$/);
  // Its checks are left out of the score, and do not make the run invalid.
  expect(silent?.checks[1]).toMatchObject({
    turn: 2,
    score: null,
    notScored: true,
    reason: "not scored: turn 2 was not asked",
  });
  expect(silent?.score).toBe(1);
  // It asked something else: the question does not match.
  expect(by("other")?.userTurns?.[1]).toMatchObject({
    skipped: "not asked",
    why: `no question of turn 1 matches /${WHICH}/`,
  });
  expect(by("other")?.score).toBe(1);
  // Two processes for `asks`, two for `silent` and one for `other`.
  const started = fs.readFileSync(box.started, "utf8").trim().split("\n");
  expect(started).toHaveLength(5);
});

test("the report says a reply turn that was not asked is not scored", async () => {
  const box = sandbox();
  plant(box, "silent", {
    turns: [
      { prompt: "one.md" },
      { ...REPLY("x"), checks: [{ type: "output_contains", text: "y" }] },
    ],
    checks: [{ type: "output_contains", text: "done" }],
  });
  script(box, "b", {
    match: { prompt: "do silent" },
    turns: [[{ final: "done." }]],
  });
  const { ran, results } = await scored(box);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("not scored: turn 2 was not asked");
  expect(results.records[0]?.score).toBe(1);
});

test("ended_awaiting_user passes when the run stops on a question", async () => {
  const box = sandbox();
  const checks = [{ type: "ended_awaiting_user" }];
  const cases: Record<string, Parameters<typeof play>[1]["steps"]> = {
    // The question is refused, as `-p` does, and the run ends on it.
    stops: [ask(`${WHICH}?`, true)],
    // The agent asked, was refused, and went on without the answer: it did not stop.
    "goes-on": [
      ask(`${WHICH}?`, true),
      exec("echo working"),
      { text: "I picked postgres and finished." },
    ],
    // Only a subagent asked. The main agent finished.
    sub: [
      {
        agent: {
          type: "helper",
          prompt: "ask",
          steps: [ask(`${WHICH}?`, true)],
        },
      },
      { text: "All done." },
    ],
    // Only a question tool asks.
    chats: [{ text: "Which database should I use?" }],
  };
  const scripted = (id: string) => ({ name: id, id, steps: cases[id] ?? [] });
  for (const id of Object.keys(cases)) {
    box.write(`cases/${id}/prompt.md`, `do ${id}\n`);
    box.write(`cases/${id}/case.json`, { checks });
    script(box, id, {
      match: { prompt: `do ${id}` },
      turns: [[...scripted(id).steps]],
    });
  }
  const { status, stderr, records } = await score(box);
  expect(status, stderr).toBe(0);
  const scores = Object.fromEntries(
    records.map(({ caseId, score: value }) => [caseId, value]),
  );
  expect(scores).toEqual({ stops: 1, "goes-on": 0, sub: 0, chats: 0 });
  // The adapter reports a stop for input only when the refused question is the one the run ended on.
  const asked = Object.fromEntries(
    records.map(({ caseId, askedUser }) => [caseId, askedUser]),
  );
  expect(asked).toEqual({
    stops: true,
    "goes-on": false,
    sub: false,
    chats: false,
  });
  expect(
    records.find(({ caseId }) => caseId === "chats")?.checks[0]?.reason,
  ).toContain("not a question call");
});

test("a final message that ends with a question mark is not asking", async () => {
  const box = sandbox();
  box.write("cases/chat/prompt.md", "do chat\n");
  box.write("cases/chat/case.json", {
    checks: [
      { type: "asked_user", max: 0 },
      { type: "asked_user" },
      { type: "ended_awaiting_user" },
    ],
  });
  script(box, "chat", {
    match: { prompt: "do chat" },
    turns: [[{ text: "Which one?" }, { final: "Which one do you want?" }]],
  });
  const { records } = await score(box);
  expect(records[0]?.checks.map(({ score: value }) => value)).toEqual([
    1, 0, 0,
  ]);
});

test("a shell command is not a question", async () => {
  const box = sandbox();
  box.write("cases/sh/prompt.md", "do sh\n");
  box.write("cases/sh/case.json", { checks: [{ type: "asked_user" }] });
  script(box, "sh", {
    match: { prompt: "do sh" },
    turns: [[exec("echo 'which one?'")]],
  });
  const { records } = await score(box);
  expect(records[0]?.checks[0]?.score).toBe(0);
  expect(records[0]?.checks[0]?.reason).toContain(
    "the agent asked no question",
  );
});

test("a harness without askUser makes asked_user, ended_awaiting_user and a reply not applicable", async () => {
  const box = sandbox();
  box.write("cases/q/prompt.md", "do q\n");
  box.write("cases/q/case.json", {
    checks: [{ type: "asked_user" }],
  });
  box.write("cases/e/prompt.md", "do e\n");
  box.write("cases/e/case.json", { checks: [{ type: "ended_awaiting_user" }] });
  plant(box, "r", {
    turns: [{ prompt: "one.md" }, REPLY("x")],
    checks: [{ type: "output_matches", pattern: "." }],
  });
  const { ran, results } = await scored(box, "claude-code,pi");
  expect(ran.status, ran.stderr).toBe(0);
  expect(results.suites.find(({ harness }) => harness === "pi")).toMatchObject({
    applicable: 0,
    total: 3,
  });
  expect(ran.stdout).toContain("needs askUser");
  const loaded = loadCases(path.join(box.root, "cases"));
  expect(loaded).toHaveLength(3);
});

test("a reply turn is strict: not first, a valid pattern, known keys", () => {
  const box = () => sandbox();
  const where = "ROOT/cases/talk/case.json turns[";
  expect(
    failure(box(), {
      turns: [{ reply: { whenAsked: "x", prompt: "one.md" } }],
    }),
  ).toBe(
    `${where}0]: the first turn must be a "prompt" or an "invoke"; an event or a reply acts on a session that exists`,
  );
  const second = (reply: unknown) =>
    failure(box(), { turns: [{ prompt: "one.md" }, { reply }] });
  expect(second({ whenAsked: "(", prompt: "two.md" })).toContain(
    "Invalid regular expression",
  );
  expect(second({ prompt: "two.md" })).toContain('needs a string "whenAsked"');
  expect(second({ whenAsked: "x" })).toContain('needs a string "prompt"');
  expect(second({ whenAsked: "x", prompt: "two.md", more: 1 })).toContain(
    'unknown key "more" for a reply',
  );
  expect(second({ whenAsked: "x", prompt: "gone.md" })).toContain(
    "prompt gone.md does not exist",
  );
  expect(second({ whenAsked: "x", prompt: "two.md" })).toBe("");
});

test("the record's loaded is the union over every turn's process", async () => {
  const box = sandbox();
  plant(box, "two", {
    turns: [{ prompt: "one.md" }, { prompt: "three.md" }],
    checks: [{ type: "output_matches", pattern: "." }],
  });
  script(box, "two", {
    match: { prompt: "do two" },
    inits: [{ skills: ["first-skill"] }, { skills: ["second-skill"] }],
    turns: [[{ final: "a" }], [{ final: "b" }]],
  });
  const { status, stderr, records } = await score(box);
  expect(status, stderr).toBe(0);
  expect(records[0]?.loaded.skills).toEqual(["first-skill", "second-skill"]);
});
